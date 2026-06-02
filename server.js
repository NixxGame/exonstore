/**
 * Exon External — Backend Server
 *
 * Install:
 *   npm install express stripe jsonwebtoken axios cors dotenv
 *
 * Run:
 *   node server.js
 */

require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const axios   = require('axios');
const jwt     = require('jsonwebtoken');
const stripe     = require('stripe')(process.env.STRIPE_SECRET_KEY);
const stripeTest = process.env.STRIPE_SECRET_KEY_TEST
  ? require('stripe')(process.env.STRIPE_SECRET_KEY_TEST)
  : stripe;
const db      = require('./db');

// ── Role helpers ──────────────────────────────────────────────────────────────

const ROLE_ORDER = ['member', 'customer', 'staff', 'developer'];

function promoteUser(discordId, targetRole) {
  const user = db.getUser(discordId);
  if (!user) return;
  if (ROLE_ORDER.indexOf(user.role) < ROLE_ORDER.indexOf(targetRole)) {
    db.setUserRole(discordId, targetRole);
    assignDiscordRole(discordId, `DISCORD_ROLE_${targetRole.toUpperCase()}`);
    writeUserToCF({ ...user, role: targetRole });
  }
}

async function assignDiscordRole(discordId, envKey) {
  const roleId   = process.env[envKey];
  const guildId  = process.env.DISCORD_GUILD_ID;
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!roleId || !guildId || !botToken) return;
  try {
    await axios.put(
      `https://discord.com/api/v10/guilds/${guildId}/members/${discordId}/roles/${roleId}`,
      {},
      { headers: { Authorization: `Bot ${botToken}` } }
    );
    console.log(`Assigned role ${envKey} to ${discordId}`);
  } catch (err) {
    console.error('Role assignment error:', err.response?.data ?? err.message);
  }
}

// ── JWT ───────────────────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-me';

function issueToken(discordId) {
  return jwt.sign({ sub: discordId }, JWT_SECRET, { expiresIn: '30d' });
}

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch { return null; }
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Not authenticated' });
  const payload = verifyToken(auth.slice(7));
  if (!payload) return res.status(401).json({ error: 'Invalid or expired token' });
  req.discordId = payload.sub;
  next();
}

// ── Key generation ────────────────────────────────────────────────────────────

const IS_TEST = (process.env.STRIPE_SECRET_KEY ?? '').startsWith('sk_test_');

function generateKey() {
  const chars  = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const seg    = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  const suffix = IS_TEST ? '-test' : '';
  return `exon-${seg()}-${seg()}-${seg()}${suffix}`;
}

// ── Cloudflare KV ────────────────────────────────────────────────────────────

function planToMinutes(plan) {
  if (!plan) return null;
  const p = plan.toLowerCase();
  if (p.includes('3 month')) return 129600; // 90 days
  if (p.includes('month'))   return 43200;  // 30 days
  if (p.includes('week'))    return 10080;  // 7 days
  if (p.includes('day'))     return 1440;   // 1 day
  return null;
}

function cfHeaders() {
  return { Authorization: `Bearer ${process.env.CF_API_TOKEN}`, 'Content-Type': 'text/plain' };
}

function cfBase() {
  return `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/storage/kv/namespaces/${process.env.CF_KV_NAMESPACE_ID}`;
}

function cfReady() {
  return !!(process.env.CF_ACCOUNT_ID && process.env.CF_KV_NAMESPACE_ID && process.env.CF_API_TOKEN);
}

async function cfWrite(kvKey, data) {
  if (!cfReady()) return;
  try {
    await axios.put(
      `${cfBase()}/values/${encodeURIComponent(kvKey)}`,
      JSON.stringify(data),
      { headers: cfHeaders() }
    );
  } catch (err) {
    console.error('CF KV write error:', err.response?.data ?? err.message);
  }
}

async function cfDelete(kvKey) {
  if (!cfReady()) return;
  try {
    await axios.delete(
      `${cfBase()}/values/${encodeURIComponent(kvKey)}`,
      { headers: cfHeaders() }
    );
  } catch (err) {
    console.error('CF KV delete error:', err.response?.data ?? err.message);
  }
}

async function cfRead(kvKey) {
  if (!cfReady()) return null;
  try {
    const res = await axios.get(
      `${cfBase()}/values/${encodeURIComponent(kvKey)}`,
      { headers: cfHeaders() }
    );
    return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  } catch {
    return null;
  }
}

async function writeKeyToCF(key, discordId, plan) {
  await cfWrite(key, {
    key,
    discord_id:   discordId ?? null,
    hwid:         null,
    time_created: null,        // set on first activation by loader, not on purchase
    purchased_at: Date.now(),
    length:       planToMinutes(plan),
    active:       true,
  });
}

async function writeUserToCF(user) {
  await cfWrite(`user:${user.discord_id}`, user);
}

async function restoreUserFromCF(discordId) {
  const user = await cfRead(`user:${discordId}`);
  if (!user) return null;
  db.upsertUser(user.discord_id, user.username, user.avatar);
  if (user.role && user.role !== 'member') db.setUserRole(user.discord_id, user.role);
  await restoreKeysFromCF(discordId, user.linked_keys ?? []);
  return db.getUser(discordId);
}

async function restoreKeysFromCF(discordId, linkedKeys = []) {
  const validKeys = [];
  for (const keyValue of linkedKeys) {
    const entry = await cfRead(keyValue);

    // Key was manually deleted from CF — remove from user's linked list
    if (!entry) {
      console.log(`Key ${keyValue} not found in CF — skipping restore`);
      continue;
    }

    // Key expired — deactivate locally and skip
    if (entry.time_created && entry.length) {
      const expiresAt = entry.time_created + entry.length * 60 * 1000;
      if (Date.now() > expiresAt) {
        db.deactivateKey(keyValue);
        console.log(`Key ${keyValue} expired — deactivated`);
        continue;
      }
    }

    if (!db.getKey(keyValue)) {
      db.insertKey(keyValue, entry.plan ?? null, null, null);
      db.linkKey(keyValue, discordId);
    }
    validKeys.push(keyValue);
  }

  // Prune deleted/expired keys from the user's CF linked_keys list
  if (validKeys.length !== linkedKeys.length) {
    const cfUser = await cfRead(`user:${discordId}`);
    if (cfUser) {
      cfUser.linked_keys = validKeys;
      await cfWrite(`user:${discordId}`, cfUser);
    }
  }
}

async function addLinkedKeyToCF(discordId, keyValue) {
  const user = await cfRead(`user:${discordId}`);
  if (!user) return;
  const keys = user.linked_keys ?? [];
  if (!keys.includes(keyValue)) {
    user.linked_keys = [...keys, keyValue];
    await cfWrite(`user:${discordId}`, user);
  }
}

async function removeLinkedKeyFromCF(discordId, keyValue) {
  const user = await cfRead(`user:${discordId}`);
  if (!user) return;
  user.linked_keys = (user.linked_keys ?? []).filter(k => k !== keyValue);
  await cfWrite(`user:${discordId}`, user);
}

// ── Email (Resend) ────────────────────────────────────────────────────────────

async function sendKeyEmail(to, key, plan) {
  const planLabel = plan ?? 'License';

  const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#06080d;font-family:system-ui,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#eef0f6;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#06080d;padding:40px 0;">
  <tr><td align="center">
  <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
    <tr><td align="center" style="padding:0 0 28px;">
      <span style="font-size:1.3rem;font-weight:800;letter-spacing:-.02em;color:#eef0f6;">
        Exon <span style="color:#f07a12;">External</span>
      </span>
    </td></tr>
    <tr><td style="background:#0e1119;border:1px solid rgba(255,255,255,.07);border-radius:20px;padding:36px;">
      <p style="margin:0 0 4px;font-size:.68rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#f07a12;">Order Confirmed</p>
      <h1 style="margin:0 0 14px;font-size:1.5rem;font-weight:800;letter-spacing:-.03em;color:#eef0f6;line-height:1.2;">Your license is ready.</h1>
      <p style="margin:0 0 24px;font-size:.9rem;color:#7a8394;line-height:1.65;">
        Thanks for purchasing <strong style="color:#eef0f6;">${planLabel}</strong>.
        Your license key is below — keep it safe.
      </p>
      <div style="background:#06080d;border:1px solid rgba(240,122,18,.3);border-radius:12px;padding:16px 20px;margin:0 0 24px;text-align:center;">
        <p style="margin:0 0 4px;font-size:.65rem;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:#7a8394;">License Key</p>
        <p style="margin:0;font-size:1.1rem;font-weight:700;letter-spacing:.06em;color:#f07a12;font-family:'Courier New',Courier,monospace;">${key}</p>
      </div>
      <p style="margin:0 0 10px;font-size:.78rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#eef0f6;">Getting started</p>
      <ol style="margin:0 0 24px;padding:0 0 0 18px;color:#7a8394;font-size:.86rem;line-height:1.85;">
        <li>Download the loader from our <a href="https://discord.gg/NczWT7nyAs" style="color:#f07a12;text-decoration:none;">Discord server</a>.</li>
        <li>Log into <strong style="color:#eef0f6;">exoncheats.com</strong> with Discord and paste your key to link it to your account.</li>
        <li>Run the loader and enter your key when prompted.</li>
        <li>Launch Dead by Daylight and enjoy.</li>
      </ol>
      <p style="margin:0;font-size:.84rem;color:#7a8394;line-height:1.65;">
        Need help? Join our <a href="https://discord.gg/NczWT7nyAs" style="color:#f07a12;text-decoration:none;">Discord server</a> and open a support ticket.
      </p>
    </td></tr>
    <tr><td align="center" style="padding:24px 0 0;">
      <p style="margin:0;font-size:.73rem;color:#404858;line-height:1.6;">
        © 2026 Exon External &nbsp;·&nbsp;
        <a href="https://exoncheats.com/terms.html" style="color:#404858;">Terms</a> &nbsp;·&nbsp;
        <a href="https://exoncheats.com/privacy.html" style="color:#404858;">Privacy</a> &nbsp;·&nbsp;
        <a href="https://exoncheats.com/refund.html" style="color:#404858;">Refunds</a>
      </p>
    </td></tr>
  </table>
  </td></tr>
</table>
</body></html>`;

  const res = await axios.post(
    'https://api.resend.com/emails',
    {
      from:    `Exon External <${process.env.SMTP_FROM}>`,
      to:      [to],
      subject: 'Your Exon External License Key',
      html,
      text: `Your Exon External license key: ${key}\n\nLink it to your Discord at exoncheats.com.\n\nSupport: https://discord.gg/NczWT7nyAs`,
    },
    { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` } }
  );

  return res.data;
}

// ── Express ───────────────────────────────────────────────────────────────────

const app = express();

app.use(cors({ origin: process.env.SITE_URL ?? '*', credentials: true }));

// ── Stripe webhook (must be before express.static and body parsers) ───────────

app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  const secrets = [
    process.env.STRIPE_WEBHOOK_SECRET,
    process.env.STRIPE_WEBHOOK_SECRET_TEST,
  ].filter(Boolean);

  let lastErr;
  for (const secret of secrets) {
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, secret);
      break;
    } catch (err) {
      lastErr = err;
    }
  }

  if (!event) {
    console.error('Stripe signature error:', lastErr.message);
    return res.status(400).send(`Webhook Error: ${lastErr.message}`);
  }

  const stripeClient = event.livemode ? stripe : stripeTest;
  console.log(`Webhook: ${event.type} [${event.livemode ? 'live' : 'test'}] id=${event.id}`);

  // Respond immediately so Stripe doesn't retry due to timeout
  res.json({ received: true });

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    if (session.payment_status !== 'paid') {
      console.log(`Skipping — payment_status is "${session.payment_status}"`);
      return;
    }

    // Idempotency — one key per session, no matter how many times Stripe delivers it
    if (db.getKeyBySession(session.id)) {
      console.log(`Session ${session.id} already processed — skipping`);
      return;
    }

    const email = session.customer_details?.email ?? session.customer_email;

    // Detect plan from line items
    let plan = session.metadata?.plan ?? null;
    try {
      const items = await stripeClient.checkout.sessions.listLineItems(session.id, { limit: 1 });
      const productName = items.data[0]?.description ?? items.data[0]?.price?.nickname ?? '';
      if (productName) plan = productName;
    } catch (err) {
      console.error('Line items fetch error:', err.message);
    }
    console.log(`Plan detected: "${plan}" for session ${session.id}`);

    const key = generateKey();
    db.insertKey(key, plan, session.id, email);
    await writeKeyToCF(key, null, plan);

    if (email) {
      try {
        await sendKeyEmail(email, key, plan);
        console.log(`Key emailed to ${email}: ${key}`);
      } catch (err) {
        console.error('Email error:', err.message);
      }
    }
  }
});

app.use(express.static(path.join(__dirname)));

// ── Discord OAuth ─────────────────────────────────────────────────────────────

app.get('/auth/discord', (req, res) => {
  const params = new URLSearchParams({
    client_id:     process.env.DISCORD_CLIENT_ID,
    redirect_uri:  process.env.DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope:         'identify guilds.join',
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

app.get('/auth/discord/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?error=no_code');

  try {
    const tokenRes = await axios.post(
      'https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id:     process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type:    'authorization_code',
        code,
        redirect_uri:  process.env.DISCORD_REDIRECT_URI,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const userRes = await axios.get('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bearer ${tokenRes.data.access_token}` },
    });

    const { id, username, avatar } = userRes.data;
    const avatarUrl = avatar
      ? `https://cdn.discordapp.com/avatars/${id}/${avatar}.png?size=128`
      : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(id) % 6n)}.png`;

    db.upsertUser(id, username, avatarUrl);
    writeUserToCF(db.getUser(id));

    // Auto-join Discord server
    const guildId  = process.env.DISCORD_GUILD_ID;
    const botToken = process.env.DISCORD_BOT_TOKEN;
    if (guildId && botToken) {
      try {
        await axios.put(
          `https://discord.com/api/v10/guilds/${guildId}/members/${id}`,
          { access_token: tokenRes.data.access_token },
          { headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' } }
        );
      } catch (err) {
        console.log('Guild join:', err.response?.status, err.response?.data?.message ?? err.message);
      }
    }

    const token = issueToken(id);
    res.redirect(`/?token=${token}`);
  } catch (err) {
    console.error('OAuth error:', err.response?.data ?? err.message);
    res.redirect('/?error=oauth_failed');
  }
});

// ── API: me ───────────────────────────────────────────────────────────────────

// Map Discord role IDs → internal role names (in priority order)
const DISCORD_ROLE_MAP = () => [
  { name: 'developer', id: process.env.DISCORD_ROLE_DEVELOPER },
  { name: 'staff',     id: process.env.DISCORD_ROLE_STAFF },
  { name: 'customer',  id: process.env.DISCORD_ROLE_CUSTOMER },
  { name: 'member',    id: process.env.DISCORD_ROLE_MEMBER },
];

async function getHighestDiscordRole(discordId) {
  const guildId  = process.env.DISCORD_GUILD_ID;
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!guildId || !botToken) return null;

  try {
    const res = await axios.get(
      `https://discord.com/api/v10/guilds/${guildId}/members/${discordId}`,
      { headers: { Authorization: `Bot ${botToken}` } }
    );
    const memberRoles = res.data.roles ?? [];
    for (const { name, id } of DISCORD_ROLE_MAP()) {
      if (id && memberRoles.includes(id)) return name;
    }
    return 'member';
  } catch {
    return null;
  }
}

app.get('/api/me', requireAuth, async (req, res) => {
  let user = db.getUser(req.discordId);

  // Server restarted and wiped local db — restore from CF KV
  if (!user) user = await restoreUserFromCF(req.discordId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Audit existing keys — remove expired or CF-deleted ones
  const rawKeys = db.getUserKeys(req.discordId);
  for (const k of rawKeys) {
    const cf = await cfRead(k.key_value);
    if (!cf) {
      db.removeLinkedKey(req.discordId, k.key_value);
      removeLinkedKeyFromCF(req.discordId, k.key_value);
      console.log(`Key ${k.key_value} deleted from CF — removed from user ${req.discordId}`);
      continue;
    }
    if (cf.time_created && cf.length) {
      const expiresAt = cf.time_created + cf.length * 60 * 1000;
      if (Date.now() > expiresAt) {
        db.removeLinkedKey(req.discordId, k.key_value);
        removeLinkedKeyFromCF(req.discordId, k.key_value);
        console.log(`Key ${k.key_value} expired — removed from user ${req.discordId}`);
      }
    }
  }

  const keys = db.getUserKeys(req.discordId);

  // Sync role from Discord
  const discordRole = await getHighestDiscordRole(req.discordId);
  if (discordRole && discordRole !== user.role) {
    db.setUserRole(req.discordId, discordRole);
    user.role = discordRole;
  }

  res.json({ ...user, keys });
});

// ── API: key details ──────────────────────────────────────────────────────────

app.get('/api/key/:keyValue', requireAuth, async (req, res) => {
  const local = db.getKey(req.params.keyValue);
  if (!local || local.discord_id !== req.discordId) {
    return res.status(404).json({ error: 'Key not found' });
  }

  const cf           = await cfRead(req.params.keyValue);
  const activatedAt  = cf?.time_created ?? null;   // null until loader activates
  const purchasedAt  = cf?.purchased_at ?? (local.created_at * 1000);
  const length       = cf?.length ?? null;
  const expiresAt    = activatedAt && length ? activatedAt + length * 60 * 1000 : null;

  res.json({
    key_value:     local.key_value,
    plan:          local.plan ?? 'License',
    active:        local.active,
    hwid:          cf?.hwid ?? null,
    purchased_at:  purchasedAt,
    activated_at:  activatedAt,
    expires_at:    expiresAt,
    expired:       expiresAt ? Date.now() > expiresAt : false,
    length:        length, // plan duration in minutes, for pre-activation display
  });
});

// ── API: link key ─────────────────────────────────────────────────────────────

app.post('/api/link-key', requireAuth, express.json(), async (req, res) => {
  const { key } = req.body ?? {};
  if (!key) return res.status(400).json({ error: 'Key is required' });

  const incoming = db.getKey(key);
  if (!incoming)            return res.status(404).json({ error: 'Key not found' });
  if (incoming.discord_id)  return res.status(409).json({ error: 'Key is already linked to an account' });
  if (!incoming.active)     return res.status(410).json({ error: 'Key is no longer active' });

  let user = db.getUser(req.discordId);
  if (!user) user = await restoreUserFromCF(req.discordId);
  if (!user) return res.status(404).json({ error: 'User record not found — please log in first' });

  // ── Stacking: find existing active key for this user ─────────────────────
  const incomingCF  = await cfRead(key);
  const addMinutes  = incomingCF?.length ?? null;
  const userKeys    = db.getUserKeys(req.discordId);
  const activeKey   = userKeys.find(k => k.active);

  if (activeKey && addMinutes) {
    const existingCF = await cfRead(activeKey.key_value);
    if (existingCF) {
      const currentLength = existingCF.length ?? 0;
      existingCF.length   = currentLength + addMinutes;
      await cfWrite(activeKey.key_value, existingCF);

      // Consumed key — remove from local db and CF KV entirely
      db.linkKey(key, req.discordId);
      db.removeLinkedKey(req.discordId, key);
      await cfDelete(key);

      console.log(`Stacked ${addMinutes}m onto ${activeKey.key_value} for ${req.discordId} — deleted consumed key ${key}`);
      return res.json({ success: true, stacked: true, stacked_into: activeKey.key_value });
    }
  }

  // No existing key — link normally
  db.linkKey(key, req.discordId);
  promoteUser(req.discordId, 'customer');
  addLinkedKeyToCF(req.discordId, key);

  res.json({ success: true, stacked: false });
});

// ── API: loader verify (Discord-based, no key entry) ─────────────────────────
// Loader sends: POST /api/loader/verify  { discord_id, hwid }
// Auth: Authorization: Bearer <LOADER_SECRET>

app.post('/api/loader/verify', express.json(), async (req, res) => {
  const auth = req.headers.authorization ?? '';
  if (auth !== `Bearer ${process.env.LOADER_SECRET}`) {
    return res.status(401).json({ valid: false, reason: 'Unauthorized' });
  }

  const { discord_id, hwid } = req.body ?? {};
  if (!discord_id || !hwid) {
    return res.status(400).json({ valid: false, reason: 'discord_id and hwid required' });
  }

  const userKeys = db.getUserKeys(discord_id);
  const activeKey = userKeys.find(k => k.active);

  if (!activeKey) {
    return res.json({ valid: false, reason: 'No active key found for this account' });
  }

  const cf = await cfRead(activeKey.key_value);
  if (!cf) {
    return res.json({ valid: false, reason: 'Key not found' });
  }

  // Check expiry
  if (cf.time_created && cf.length) {
    const expiresAt = cf.time_created + cf.length * 60 * 1000;
    if (Date.now() > expiresAt) {
      db.removeLinkedKey(discord_id, activeKey.key_value);
      removeLinkedKeyFromCF(discord_id, activeKey.key_value);
      return res.json({ valid: false, reason: 'Key has expired' });
    }
  }

  // HWID mismatch
  if (cf.hwid && cf.hwid !== hwid) {
    return res.json({ valid: false, reason: 'HWID mismatch — reset your HWID on exoncheats.com if you changed PCs' });
  }

  // First activation — bind HWID and start clock
  if (!cf.hwid) {
    cf.hwid         = hwid;
    cf.time_created = Date.now();
    await cfWrite(activeKey.key_value, cf);
    console.log(`Key ${activeKey.key_value} activated for Discord user ${discord_id}`);
  }

  const expiresAt = cf.time_created && cf.length
    ? cf.time_created + cf.length * 60 * 1000
    : null;

  return res.json({
    valid:      true,
    key:        activeKey.key_value,
    plan:       activeKey.plan ?? 'License',
    expires_at: expiresAt,
  });
});

// ── API: reset HWID ───────────────────────────────────────────────────────────

app.post('/api/reset-hwid', requireAuth, express.json(), async (req, res) => {
  const { key_value } = req.body ?? {};
  if (!key_value) return res.status(400).json({ error: 'key_value required' });

  const local = db.getKey(key_value);
  if (!local || local.discord_id !== req.discordId) {
    return res.status(404).json({ error: 'Key not found' });
  }

  const cf = await cfRead(key_value);
  if (!cf) return res.status(404).json({ error: 'Key not found in CF' });

  cf.hwid = null;
  await cfWrite(key_value, cf);
  console.log(`HWID reset for key ${key_value} by ${req.discordId}`);

  res.json({ success: true });
});

// ── API: mod check ────────────────────────────────────────────────────────────

app.get('/api/check/:discordId', requireAuth, (req, res) => {
  const caller = db.getUser(req.discordId);
  if (!caller || !['staff', 'developer'].includes(caller.role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const target = db.getUser(req.params.discordId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const keys = db.getUserKeys(req.params.discordId);
  res.json({ ...target, keys });
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => {
  console.log(`Exon server running → http://localhost:${PORT}`);
  try {
    console.log('Loading bot module...');
    const { startBot } = require('./bot');
    console.log('Bot module loaded, calling startBot...');
    startBot();
  } catch (err) {
    console.error('Bot failed to start:', err.message);
    console.error(err.stack);
  }
});
