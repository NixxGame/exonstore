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

const express   = require('express');
const cors      = require('cors');
const path      = require('path');
const axios     = require('axios');
const jwt       = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const stripe     = require('stripe')(process.env.STRIPE_SECRET_KEY);
const stripeTest = process.env.STRIPE_SECRET_KEY_TEST
  ? require('stripe')(process.env.STRIPE_SECRET_KEY_TEST)
  : stripe;
const db      = require('./db');

// ── Rate limiters ─────────────────────────────────────────────────────────────
const strictLimit   = rateLimit({ windowMs: 60000, max: 10,  standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests, slow down.' } });
const standardLimit = rateLimit({ windowMs: 60000, max: 60,  standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests.' } });
const looseLimit    = rateLimit({ windowMs: 60000, max: 120, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests.' } });

// ── Helpers ───────────────────────────────────────────────────────────────────

function sanitizeText(str, maxLen) {
  return String(str ?? '').replace(/<[^>]*>/g, '').replace(/[<>]/g, '').trim().slice(0, maxLen);
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

const VALID_BADGES = ['early_supporter', 'beta_tester', 'og'];
const BADGE_LABELS = { early_supporter: 'Early Supporter', beta_tester: 'Beta Tester', og: 'OG', '1_year_member': '1 Year Member' };

function hasOneYear(createdAt) {
  return createdAt && Date.now() - createdAt * 1000 >= 365 * 24 * 60 * 60 * 1000;
}

async function sendDiscordDM(discordId, content) {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!botToken) return;
  try {
    const dm = await axios.post(
      'https://discord.com/api/v10/users/@me/channels',
      { recipient_id: discordId },
      { headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' } }
    );
    await axios.post(
      `https://discord.com/api/v10/channels/${dm.data.id}/messages`,
      { content },
      { headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('DM error:', err.response?.data ?? err.message);
  }
}

async function addNotification(discordId, notification) {
  const cfUser = await cfRead(`user:${discordId}`);
  if (!cfUser) return;
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const notifications = (cfUser.notifications ?? []).filter(n => n.created_at > thirtyDaysAgo);
  notifications.unshift({ id: genId(), ...notification, created_at: Date.now(), read: false });
  cfUser.notifications = notifications.slice(0, 100);
  await cfWrite(`user:${discordId}`, cfUser);
}

async function updateLastSeen(discordId) {
  const cfUser = await cfRead(`user:${discordId}`);
  if (cfUser) { cfUser.last_seen = Date.now(); await cfWrite(`user:${discordId}`, cfUser); }
  db.setLastSeen(discordId);
}

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
  const prefix = IS_TEST ? 'test' : 'exon';
  return `${prefix}-${seg()}-${seg()}-${seg()}`;
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
    time_created: null,
    purchased_at: Date.now(),
    length:       planToMinutes(plan),
    active:       false,  // becomes true only when linked to a Discord account
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
  if (user.banned) db.setBanned(user.discord_id, true);
  await restoreKeysFromCF(discordId, user.linked_keys ?? []);
  return db.getUser(discordId);
}

async function restoreKeysFromCF(discordId, linkedKeys = []) {
  for (const keyValue of linkedKeys) {
    const entry = await cfRead(keyValue);

    // Can't read from CF right now — skip but don't remove
    if (!entry) {
      console.log(`Key ${keyValue} not readable from CF — skipping restore (not removing)`);
      continue;
    }

    if (!db.getKey(keyValue)) {
      db.insertKey(keyValue, entry.plan ?? null, null, null);
      db.linkKey(keyValue, discordId);
      // Keys in linked_keys are already claimed — mark active
      if (entry.active) db.activateKey(keyValue);
    }
  }
}

async function addLinkedKeyToCF(discordId, keyValue) {
  let user = await cfRead(`user:${discordId}`);
  // If CF user record doesn't exist yet, build it from local DB
  if (!user) {
    const dbUser = db.getUser(discordId);
    if (!dbUser) return;
    user = { ...dbUser, linked_keys: [] };
  }
  const keys = user.linked_keys ?? [];
  if (!keys.includes(keyValue)) {
    user.linked_keys = [...keys, keyValue];
    await cfWrite(`user:${discordId}`, user);
  }
}

async function updateSearchIndex(discordId, username, avatarUrl) {
  try {
    const index = (await cfRead('search_index')) ?? [];
    const existing = index.findIndex(u => u.discord_id === discordId);
    const entry = { discord_id: discordId, username, avatar: avatarUrl };
    if (existing >= 0) index[existing] = { ...index[existing], ...entry };
    else index.push(entry);
    await cfWrite('search_index', index);
  } catch (err) {
    console.error('search index update failed:', err.message);
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

  // checkout.session.completed  → only process if payment is already confirmed (cards etc.)
  // checkout.session.async_payment_succeeded → fires when delayed payments (bank etc.) confirm
  const isCompleted      = event.type === 'checkout.session.completed';
  const isAsyncConfirmed = event.type === 'checkout.session.async_payment_succeeded';

  if (isCompleted || isAsyncConfirmed) {
    const session = event.data.object;

    // For completed events, skip if payment isn't confirmed yet — async_payment_succeeded will handle it
    if (isCompleted && session.payment_status !== 'paid') {
      console.log(`checkout.session.completed — payment_status="${session.payment_status}", waiting for async confirmation`);
      return;
    }

    // Idempotency — one key per session no matter how many events fire
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
    console.log(`Payment confirmed [${event.type}] — plan="${plan}" session=${session.id}`);

    if (!event.livemode) {
      console.log(`Test payment detected — skipping key generation and email for session ${session.id}`);
      return;
    }

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

// ── Loader OAuth state store ──────────────────────────────────────────────────
const loaderStates = new Map(); // state -> { discord_id, username, jwt, expires_at }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of loaderStates)
    if (v.expires_at < now) loaderStates.delete(k);
}, 60_000);

// ── Discord OAuth ─────────────────────────────────────────────────────────────

app.get('/auth/discord', (req, res) => {
  const loaderState = req.query.loader_state ?? null;
  const params = new URLSearchParams({
    client_id:     process.env.DISCORD_CLIENT_ID,
    redirect_uri:  process.env.DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope:         'identify guilds.join',
    ...(loaderState ? { state: `loader:${loaderState}` } : {}),
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

app.get('/auth/discord/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.redirect('/?error=no_code');
  const loaderState = (state && state.startsWith('loader:')) ? state.slice(7) : null;

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
    updateSearchIndex(id, username, avatarUrl).catch(() => {});

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

    // If this was a loader login, store the result for polling and show a done page
    if (loaderState) {
      loaderStates.set(loaderState, {
        discord_id: id,
        username,
        avatar:     avatarUrl,
        jwt:        token,
        expires_at: Date.now() + 10 * 60 * 1000,
      });
      console.log(`Loader OAuth complete for ${username} (${id}), state=${loaderState}`);
      return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
        <title>Exon External</title>
        <style>body{margin:0;background:#06080d;display:flex;align-items:center;
        justify-content:center;height:100vh;font-family:system-ui;color:#eef0f6;}
        .box{text-align:center;padding:40px;background:#0e1119;border-radius:16px;
        border:1px solid rgba(240,122,18,.3);}
        h2{color:#f07a12;margin:0 0 10px}p{color:#7a8394;margin:0}</style></head>
        <body><div class="box"><h2>&#10003; Authorized</h2>
        <p>You can close this tab and return to the Exon loader.</p></div></body></html>`);
    }

    res.redirect(`/?token=${token}`);
  } catch (err) {
    console.error('OAuth error:', err.response?.data ?? err.message);
    if (loaderState) return res.redirect('/loader-error');
    res.redirect('/?error=oauth_failed');
  }
});

// ── API: public stats ─────────────────────────────────────────────────────────

app.get('/api/stats', looseLimit, (req, res) => {
  const data   = require('./db');
  const keys   = Object.values(require('fs').existsSync('./data/db.json')
    ? JSON.parse(require('fs').readFileSync('./data/db.json')).keys : {});
  const active = keys.filter(k => k.active && k.discord_id).length;
  res.json({ active_users: active });
});

// ── API: me ───────────────────────────────────────────────────────────────────

// Map Discord role IDs → internal role names (in priority order)
const DISCORD_ROLE_MAP = () => [
  { name: 'developer', id: process.env.DISCORD_ROLE_DEVELOPER },
  { name: 'staff',     id: process.env.DISCORD_ROLE_STAFF },
  { name: 'vip',       id: '1513352322116485310' },
  { name: 'customer',  id: process.env.DISCORD_ROLE_CUSTOMER },
  { name: 'member',    id: process.env.DISCORD_ROLE_MEMBER },
];

// Roles that can customize accent color (vip and above)
const COLOR_ROLES = new Set(['vip', 'staff', 'developer']);
// Roles that get full color picker vs preset-only
const FULL_COLOR_ROLES = new Set(['staff', 'developer']);

async function getHighestDiscordRole(discordId) {
  // Owner always gets developer
  if (discordId === process.env.OWNER_DISCORD_ID) return 'developer';

  const guildId  = process.env.DISCORD_GUILD_ID;
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!guildId || !botToken) return null;

  try {
    const res = await axios.get(
      `https://discord.com/api/v10/guilds/${guildId}/members/${discordId}`,
      { headers: { Authorization: `Bot ${botToken}` } }
    );
    const memberRoles = res.data.roles ?? [];
    console.log(`[roles] ${discordId} has: ${memberRoles.join(', ')}`);
    for (const { name, id } of DISCORD_ROLE_MAP()) {
      if (id && memberRoles.includes(id)) {
        console.log(`[roles] matched → ${name} (${id})`);
        return name;
      }
    }
    return 'member';
  } catch (err) {
    console.error(`[roles] Discord API error for ${discordId}:`, err.response?.status, err.response?.data ?? err.message);
    return null;
  }
}

app.get('/api/me', standardLimit, requireAuth, async (req, res) => {
  let user = db.getUser(req.discordId);

  // Server restarted and wiped local db — restore from CF KV
  if (!user) user = await restoreUserFromCF(req.discordId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Update last_seen (fire and forget)
  updateLastSeen(req.discordId).catch(() => {});

  const keys = db.getUserKeys(req.discordId);

  // Calculate combined time remaining across all keys (sequential — one ticks at a time)
  let combinedMs   = 0;
  let anyActivated = false;
  let currentFound = false;

  // Sort by purchase date for sequential ordering
  const sortedKeys = [...keys];
  const cfMap = {};
  for (const k of sortedKeys) {
    const cf = await cfRead(k.key_value);
    if (cf) cfMap[k.key_value] = cf;
  }
  sortedKeys.sort((a, b) => (cfMap[a.key_value]?.purchased_at ?? 0) - (cfMap[b.key_value]?.purchased_at ?? 0));

  for (const k of sortedKeys) {
    const cf = cfMap[k.key_value];
    if (!cf) continue;
    if (cf.time_created && cf.length) {
      anyActivated = true;
      const remaining = (cf.time_created + cf.length * 60 * 1000) - Date.now();
      if (remaining > 0) {
        combinedMs += remaining;
        if (!currentFound) { k.queue_status = 'active'; currentFound = true; }
        else k.queue_status = 'queued';
      } else {
        k.queue_status = 'expired';
      }
    } else if (cf.length) {
      combinedMs += cf.length * 60 * 1000;
      if (!currentFound) { k.queue_status = 'active'; currentFound = true; }
      else k.queue_status = 'queued';
    }
  }

  // Sync role from Discord
  const discordRole = await getHighestDiscordRole(req.discordId);
  if (discordRole && discordRole !== user.role) {
    db.setUserRole(req.discordId, discordRole);
    user.role = discordRole;
  }

  res.json({
    ...user,
    keys,
    combined_ms:        combinedMs,
    combined_activated: anyActivated,
  });
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

app.post('/api/link-key', strictLimit, requireAuth, express.json(), async (req, res) => {
  const { key } = req.body ?? {};
  if (!key) return res.status(400).json({ error: 'Key is required' });

  let incoming = db.getKey(key);

  // Key not in local DB — check CF (may have been created before last restart)
  if (!incoming) {
    const cf = await cfRead(key);
    if (!cf) return res.status(404).json({ error: 'Key not found' });
    // Restore it into local DB from CF
    db.insertKey(key, cf.plan ?? null, null, null);
    if (cf.discord_id) db.linkKey(key, cf.discord_id);
    if (cf.active)     db.activateKey(key);
    incoming = db.getKey(key);
  }

  if (!incoming)           return res.status(404).json({ error: 'Key not found' });
  if (incoming.discord_id) return res.status(409).json({ error: 'Key is already linked to an account' });
  // Only block keys that were previously active and then explicitly deactivated (discord_id would be set)
  // New unlinked keys have active: false + discord_id: null — those are fine to link

  let user = db.getUser(req.discordId);
  if (!user) user = await restoreUserFromCF(req.discordId);
  if (!user) return res.status(404).json({ error: 'User record not found — please log in first' });

  db.linkKey(key, req.discordId);
  db.activateKey(key);
  promoteUser(req.discordId, 'customer');
  await addLinkedKeyToCF(req.discordId, key);

  // Activate in CF KV too
  const cf = await cfRead(key);
  if (cf) {
    cf.discord_id = req.discordId;
    cf.active     = true;
    await cfWrite(key, cf);
  }

  res.json({ success: true });
});

// ── API: loader poll (OAuth flow) ─────────────────────────────────────────────

app.get('/api/loader/poll/:state', (req, res) => {
  const entry = loaderStates.get(req.params.state);
  if (!entry || entry.expires_at < Date.now()) {
    loaderStates.delete(req.params.state);
    return res.json({ ready: false });
  }

  res.json({ ready: true, discord_id: entry.discord_id, username: entry.username, avatar: entry.avatar, jwt: entry.jwt });
});

// ── API: loader member check ──────────────────────────────────────────────────

app.get('/api/loader/member/:discordId', async (req, res) => {
  const auth = req.headers.authorization ?? '';
  if (auth !== `Bearer ${process.env.LOADER_SECRET}`) {
    return res.status(401).json({ valid: false });
  }
  const user = db.getUser(req.params.discordId)
             ?? await restoreUserFromCF(req.params.discordId);
  if (!user) return res.json({ valid: false, reason: 'Discord account not linked on exoncheats.com' });
  res.json({ valid: true, username: user.username, role: user.role });
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

  // Scan db.json directly for all keys belonging to this discord_id
  const dbData   = JSON.parse(require('fs').readFileSync('./data/db.json', 'utf8'));
  const userKeys = Object.values(dbData.keys ?? {}).filter(k => k.discord_id === discord_id);
  const dbUser   = dbData.users?.[discord_id] ?? null;

  if (dbUser?.banned) {
    return res.json({ valid: false, reason: 'This account has been banned. Contact support on Discord.' });
  }

  if (!userKeys.length) {
    return res.json({
      valid:        false,
      reason:       'No active key found for this account',
      user_exists:  !!dbUser,
      username:     dbUser?.username ?? '',
      role:         dbUser?.role ?? 'member',
    });
  }

  // Load CF entries in parallel for expiry/hwid data
  const cfResults = await Promise.all(userKeys.map(k => cfRead(k.key_value).then(cf => cf ? { k, cf } : null)));
  const cfEntries = cfResults.filter(Boolean);

  if (!cfEntries.length) {
    return res.json({ valid: false, reason: 'No active key found for this account' });
  }

  cfEntries.sort((a, b) => (a.cf.purchased_at ?? 0) - (b.cf.purchased_at ?? 0));

  // ── Dual verification ─────────────────────────────────────────────────────
  // Any key already bound to a DIFFERENT hwid = reject immediately (no transfer)
  for (const { cf } of cfEntries) {
    if (cf.hwid && cf.hwid !== hwid) {
      return res.json({ valid: false, reason: 'HWID mismatch — this account is bound to a different machine. Reset your HWID on exoncheats.com if you changed PCs.' });
    }
  }

  // Check for banned keys
  for (const { cf } of cfEntries) {
    if (cf.banned) {
      return res.json({ valid: false, reason: 'This account has been suspended. Contact support on Discord.' });
    }
  }

  // ── Bind HWID to ALL keys immediately (lock against transfer before activation) ──
  await Promise.all(cfEntries.map(async entry => {
    if (!entry.cf.hwid) {
      entry.cf.hwid = hwid;
      await cfWrite(entry.k.key_value, entry.cf);
      console.log(`HWID locked on queued key ${entry.k.key_value} for ${discord_id}`);
    }
  }));

  // ── Find and start the current key (first with time remaining, else first queued) ──
  let currentEntry = null;
  for (const entry of cfEntries) {
    const { cf } = entry;
    if (cf.time_created && cf.length) {
      const expiresAt = cf.time_created + cf.length * 60 * 1000;
      if (Date.now() < expiresAt) { currentEntry = entry; break; } // still ticking
    } else if (!cf.time_created) {
      currentEntry = entry; break; // next in queue — start it
    }
  }

  if (!currentEntry) {
    return res.json({ valid: false, reason: 'All keys have expired' });
  }

  // Start the clock on current key if not already running
  if (!currentEntry.cf.time_created) {
    currentEntry.cf.time_created = Date.now();
    await cfWrite(currentEntry.k.key_value, currentEntry.cf);
    console.log(`Key ${currentEntry.k.key_value} timer started for ${discord_id}`);
  }

  // Combined time = current remaining + all queued keys' full durations
  let combinedMs = 0;
  for (const { cf } of cfEntries) {
    if (cf.time_created && cf.length) {
      const remaining = (cf.time_created + cf.length * 60 * 1000) - Date.now();
      if (remaining > 0) combinedMs += remaining;
    } else if (cf.length && !cf.time_created) {
      combinedMs += cf.length * 60 * 1000;
    }
  }

  // Always fetch live role from Discord rather than trusting stale DB value
  console.log(`[verify] discord_id="${discord_id}" owner="${process.env.OWNER_DISCORD_ID}" match=${discord_id === process.env.OWNER_DISCORD_ID}`);
  let role = (await getHighestDiscordRole(discord_id)) ?? db.getUser(discord_id)?.role ?? 'member';
  console.log(`[verify] resolved role="${role}" for ${discord_id}`);
  if (role && db.getUser(discord_id)?.role !== role) db.setUserRole(discord_id, role);

  const keysSummary = cfEntries.map(({ k, cf }) => {
    let status = 'queued';
    let expiresMs = cf.length ? cf.length * 60 * 1000 : 0;
    if (cf.time_created && cf.length) {
      const rem = cf.time_created + cf.length * 60 * 1000 - Date.now();
      status    = rem > 0 ? 'active' : 'expired';
      expiresMs = Math.max(0, rem);
    }
    return { key_value: k.key_value, plan: k.plan ?? cf.plan ?? 'License', status, expires_ms: expiresMs };
  });

  // Update last_seen (fire and forget)
  updateLastSeen(discord_id).catch(() => {});

  console.log(`Loader verify OK for ${discord_id} — ${combinedMs / 60000 | 0}m combined remaining`);

  return res.json({
    valid:         true,
    expires_in_ms: combinedMs,
    expires_at:    combinedMs > 0 ? Date.now() + combinedMs : null,
    role,
    keys:          keysSummary,
  });
});

// ── API: reset HWID ───────────────────────────────────────────────────────────

app.post('/api/reset-hwid', strictLimit, requireAuth, express.json(), async (req, res) => {
  const { key_value } = req.body ?? {};
  if (!key_value) return res.status(400).json({ error: 'key_value required' });

  const local = db.getKey(key_value);
  if (!local || local.discord_id !== req.discordId) {
    return res.status(404).json({ error: 'Key not found' });
  }

  const cf = await cfRead(key_value);
  if (!cf) return res.status(404).json({ error: 'Key not found in CF' });

  // 1 reset per 30 days
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  if (cf.hwid_reset_at && Date.now() - cf.hwid_reset_at < THIRTY_DAYS) {
    const nextReset = new Date(cf.hwid_reset_at + THIRTY_DAYS);
    return res.status(429).json({
      error: `HWID already reset this month. Next reset available ${nextReset.toDateString()}.`
    });
  }

  cf.hwid          = null;
  cf.hwid_reset_at = Date.now();
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

// ── Admin middleware ──────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Not authenticated' });
  const payload = verifyToken(auth.slice(7));
  if (!payload) return res.status(401).json({ error: 'Invalid token' });
  const user = db.getUser(payload.sub);
  if (!user || !['staff', 'developer'].includes(user.role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  req.discordId = payload.sub;
  next();
}

// GET /api/admin/keys?q=&page=1&limit=50
app.get('/api/admin/keys', requireAdmin, async (req, res) => {
  const q     = (req.query.q ?? '').toLowerCase();
  const page  = Math.max(1, parseInt(req.query.page  ?? 1));
  const limit = Math.min(100, parseInt(req.query.limit ?? 50));

  const dbData = JSON.parse(require('fs').readFileSync('./data/db.json', 'utf8'));
  let allKeys  = Object.values(dbData.keys ?? {});

  if (q) allKeys = allKeys.filter(k =>
    k.key_value?.toLowerCase().includes(q) ||
    k.discord_id?.includes(q) ||
    (dbData.users?.[k.discord_id]?.username ?? '').toLowerCase().includes(q)
  );

  allKeys.sort((a, b) => b.created_at - a.created_at);
  const total = allKeys.length;
  const slice = allKeys.slice((page - 1) * limit, (page - 1) * limit + limit);

  const enriched = await Promise.all(slice.map(async k => {
    const cf   = await cfRead(k.key_value);
    const user = k.discord_id ? (dbData.users?.[k.discord_id] ?? null) : null;
    const timeCreated = cf?.time_created ?? null;
    const length      = cf?.length ?? null;
    const expiresAt   = timeCreated && length ? timeCreated + length * 60000 : null;
    return {
      key_value:    k.key_value,
      plan:         k.plan ?? cf?.plan ?? '—',
      discord_id:   k.discord_id ?? null,
      username:     user?.username ?? null,
      active:       k.active,
      banned:       cf?.banned ?? false,
      hwid:         cf?.hwid ?? null,
      time_created: timeCreated,
      expires_at:   expiresAt,
      length_min:   length,
      purchased_at: cf?.purchased_at ?? null,
    };
  }));

  res.json({ keys: enriched, total, page, limit });
});

// POST /api/admin/keys/generate  { plan, days }
app.post('/api/admin/keys/generate', requireAdmin, express.json(), async (req, res) => {
  const { plan, days } = req.body ?? {};
  if (!plan || !days) return res.status(400).json({ error: 'plan and days required' });
  const key     = generateKey();
  const minutes = Math.round(parseFloat(days) * 1440);
  db.insertKey(key, plan, null, null);
  await cfWrite(key, {
    key, discord_id: null, hwid: null, time_created: null,
    purchased_at: Date.now(), length: minutes, active: false, banned: false,
  });
  res.json({ key });
});

// DELETE /api/admin/keys/:key
app.delete('/api/admin/keys/:key', requireAdmin, async (req, res) => {
  db.deleteKey(req.params.key);
  await cfDelete(req.params.key);
  res.json({ success: true });
});

// POST /api/admin/keys/:key/add-time  { minutes }
app.post('/api/admin/keys/:key/add-time', requireAdmin, express.json(), async (req, res) => {
  const minutes = parseInt(req.body?.minutes ?? 0);
  if (!minutes) return res.status(400).json({ error: 'minutes required' });
  const cf = await cfRead(req.params.key);
  if (!cf) return res.status(404).json({ error: 'Key not found' });
  cf.length = (cf.length ?? 0) + minutes;
  await cfWrite(req.params.key, cf);
  res.json({ success: true, length_min: cf.length });
});

// POST /api/admin/keys/:key/ban  { banned }
app.post('/api/admin/keys/:key/ban', requireAdmin, express.json(), async (req, res) => {
  const cf = await cfRead(req.params.key);
  if (!cf) return res.status(404).json({ error: 'Key not found' });
  cf.banned = !!req.body?.banned;
  await cfWrite(req.params.key, cf);
  res.json({ success: true });
});

// POST /api/admin/keys/:key/reset-hwid
app.post('/api/admin/keys/:key/reset-hwid', requireAdmin, async (req, res) => {
  const cf = await cfRead(req.params.key);
  if (!cf) return res.status(404).json({ error: 'Key not found' });
  cf.hwid = null;
  await cfWrite(req.params.key, cf);
  res.json({ success: true });
});

// GET /api/admin/users/:discordId
app.get('/api/admin/users/:discordId', requireAdmin, async (req, res) => {
  const dbData = JSON.parse(require('fs').readFileSync('./data/db.json', 'utf8'));
  const user   = dbData.users?.[req.params.discordId] ?? null;
  if (!user) return res.status(404).json({ error: 'User not found' });

  const cfUser   = await cfRead(`user:${req.params.discordId}`);
  const userKeys = Object.values(dbData.keys ?? {}).filter(k => k.discord_id === req.params.discordId);

  const enrichedKeys = await Promise.all(userKeys.map(async k => {
    const cf = await cfRead(k.key_value);
    const timeCreated = cf?.time_created ?? null;
    const length      = cf?.length ?? null;
    const expiresAt   = timeCreated && length ? timeCreated + length * 60000 : null;
    return {
      key_value:    k.key_value,
      plan:         k.plan ?? cf?.plan ?? '—',
      active:       k.active,
      hwid:         cf?.hwid ?? null,
      time_created: timeCreated,
      expires_at:   expiresAt,
      length_min:   length,
      purchased_at: cf?.purchased_at ?? null,
    };
  }));

  enrichedKeys.sort((a, b) => (b.purchased_at ?? 0) - (a.purchased_at ?? 0));

  res.json({
    ...user,
    banned:     cfUser?.banned ?? user.banned ?? false,
    linked_keys: cfUser?.linked_keys ?? [],
    keys:       enrichedKeys,
  });
});

// POST /api/admin/users/:discordId/ban  { banned }
app.post('/api/admin/users/:discordId/ban', requireAdmin, express.json(), async (req, res) => {
  const banned = !!req.body?.banned;
  db.setBanned(req.params.discordId, banned);
  const cfUser = await cfRead(`user:${req.params.discordId}`);
  if (cfUser) {
    cfUser.banned = banned;
    await cfWrite(`user:${req.params.discordId}`, cfUser);
  }
  console.log(`Admin ${req.discordId} ${banned ? 'banned' : 'unbanned'} user ${req.params.discordId}`);
  res.json({ success: true });
});

// ── API: loader version (auto-updater) ───────────────────────────────────────
// Loader checks this on every launch. Change LOADER_VERSION + LOADER_DOWNLOAD_URL
// in your .env to push an update to all clients automatically.

app.get('/api/loader/version', looseLimit, (req, res) => {
  const auth = req.headers.authorization ?? '';
  if (auth !== `Bearer ${process.env.LOADER_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({
    version: process.env.LOADER_VERSION       ?? '1.0.0',
    url:     process.env.LOADER_DOWNLOAD_URL  ?? '',
    size_mb: process.env.LOADER_SIZE_MB       ?? '',
  });
});

// ── Profile pages (/u/ routes) ───────────────────────────────────────────────

app.get('/u/:discordId', (req, res) => res.sendFile(path.join(__dirname, 'profile.html')));
app.get('/u/:discordId/followers', (req, res) => res.sendFile(path.join(__dirname, 'profile.html')));
app.get('/u/:discordId/following', (req, res) => res.sendFile(path.join(__dirname, 'profile.html')));

// ── API: public profile ───────────────────────────────────────────────────────

app.get('/api/profile/:discordId', looseLimit, async (req, res) => {
  const cfUser = await cfRead(`user:${req.params.discordId}`);
  const dbUser = db.getUser(req.params.discordId);
  if (!cfUser && !dbUser) return res.status(404).json({ error: 'User not found' });

  const user    = { ...(dbUser ?? {}), ...(cfUser ?? {}) };
  // DB role is always authoritative — synced from Discord on every login
  if (dbUser?.role) user.role = dbUser.role;
  const privacy = user.privacy ?? {};

  // Identify requester
  const authHeader = (req.headers.authorization ?? '').replace('Bearer ', '');
  const payload    = authHeader ? verifyToken(authHeader) : null;
  const requesterId = payload?.sub ?? null;
  const isOwner    = requesterId === req.params.discordId;

  // Block check — blocked users see 404
  if (!isOwner && requesterId && (user.blocked ?? []).includes(requesterId)) {
    return res.status(404).json({ error: 'User not found' });
  }

  // Auto badge: 1 year member
  const autoBadges = hasOneYear(user.created_at) ? ['1_year_member'] : [];
  const allBadges  = [...new Set([...(user.badges ?? []), ...autoBadges])];

  // Mutual followers (viewers who are logged in)
  let mutual_count = 0;
  if (requesterId && !isOwner) {
    const cfRequester = await cfRead(`user:${requesterId}`);
    const requesterFollowing = cfRequester?.following ?? [];
    const targetFollowers    = user.followers ?? [];
    mutual_count = requesterFollowing.filter(id => targetFollowers.includes(id)).length;
  }

  const base = {
    discord_id:         user.discord_id,
    username:           user.username,
    display_name:       user.display_name ?? user.username,
    avatar:             user.avatar,
    bio:                user.bio ?? '',
    role:               user.role ?? 'member',
    created_at:         user.created_at,
    badges:             allBadges,
    follower_count:     (user.followers ?? []).length,
    following_count:    (user.following ?? []).length,
    show_follower_count: privacy.show_follower_count ?? false,
    is_owner:           isOwner,
    is_following:       requesterId ? (user.followers ?? []).includes(requesterId) : false,
    is_blocked_by_you:  requesterId ? (user.blocked ?? []).includes(requesterId) : false,
    last_seen:          (privacy.show_online_status && user.last_seen) ? user.last_seen : null,
    accent_color:       user.accent_color ?? null,
    team_description:   user.team_description ?? null,
    mutual_count,
    can_edit_color:     COLOR_ROLES.has(user.role ?? 'member'),
    full_color:         FULL_COLOR_ROLES.has(user.role ?? 'member'),
  };

  if (isOwner) {
    // Owner: full data
    const dbData   = JSON.parse(require('fs').readFileSync('./data/db.json', 'utf8'));
    const userKeys = Object.values(dbData.keys ?? {}).filter(k => k.discord_id === req.params.discordId);
    const enriched = await Promise.all(userKeys.map(async k => {
      const cf = await cfRead(k.key_value);
      const tc = cf?.time_created ?? null;
      const ln = cf?.length ?? null;
      return { key_value: k.key_value, plan: k.plan ?? '—', hwid: cf?.hwid ?? null,
               time_created: tc, expires_at: tc && ln ? tc + ln * 60000 : null,
               length_min: ln, purchased_at: cf?.purchased_at ?? null };
    }));
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const notifications = (user.notifications ?? []).filter(n => n.created_at > thirtyDaysAgo);
    return res.json({
      ...base,
      privacy,
      keys:             enriched,
      notifications:    notifications,
      unread_count:     notifications.filter(n => !n.read).length,
      following:        user.following ?? [],
      blocked:          user.blocked ?? [],
      last_seen:        user.last_seen ?? null, // owner always sees their own
    });
  }

  // Public view — apply privacy filters
  const pub = { ...base };
  if (privacy.show_subscription) {
    const dbData   = JSON.parse(require('fs').readFileSync('./data/db.json', 'utf8'));
    const userKeys = Object.values(dbData.keys ?? {}).filter(k => k.discord_id === req.params.discordId);
    const cfKeys   = await Promise.all(userKeys.map(k => cfRead(k.key_value)));
    pub.has_active_subscription = cfKeys.some(cf => cf?.time_created && cf?.length && Date.now() < cf.time_created + cf.length * 60000);
  }
  if (privacy.show_time_remaining) {
    const dbData   = JSON.parse(require('fs').readFileSync('./data/db.json', 'utf8'));
    const userKeys = Object.values(dbData.keys ?? {}).filter(k => k.discord_id === req.params.discordId);
    let combinedMs = 0;
    for (const k of userKeys) {
      const cf = await cfRead(k.key_value);
      if (cf?.time_created && cf?.length) {
        const rem = cf.time_created + cf.length * 60000 - Date.now();
        if (rem > 0) combinedMs += rem;
      } else if (cf?.length && !cf?.time_created) combinedMs += cf.length * 60000;
    }
    pub.time_remaining_ms = combinedMs;
  }
  if (privacy.show_key_count) {
    const dbData = JSON.parse(require('fs').readFileSync('./data/db.json', 'utf8'));
    pub.key_count = Object.values(dbData.keys ?? {}).filter(k => k.discord_id === req.params.discordId).length;
  }
  res.json(pub);
});

// ── API: update profile ───────────────────────────────────────────────────────

app.post('/api/profile', strictLimit, requireAuth, express.json(), async (req, res) => {
  const { display_name, bio, privacy, accent_color, team_description } = req.body ?? {};
  let cfUser = await cfRead(`user:${req.discordId}`);
  if (!cfUser) {
    const dbUser = db.getUser(req.discordId);
    if (!dbUser) return res.status(404).json({ error: 'User not found' });
    cfUser = { ...dbUser, linked_keys: db.getUserKeys(req.discordId).map(k => k.key_value) };
  }

  if (display_name !== undefined) cfUser.display_name = sanitizeText(display_name, 32);
  if (bio !== undefined)          cfUser.bio           = sanitizeText(bio, 200);
  if (privacy && typeof privacy === 'object') {
    const allowed = ['show_subscription','show_time_remaining','show_key_count','show_follower_count','show_online_status'];
    cfUser.privacy = cfUser.privacy ?? {};
    allowed.forEach(k => { if (k in privacy) cfUser.privacy[k] = !!privacy[k]; });
  }

  // Accent color — only allowed for VIP+
  if (accent_color !== undefined) {
    const dbUser = db.getUser(req.discordId);
    const role   = dbUser?.role ?? cfUser.role ?? 'member';
    if (COLOR_ROLES.has(role)) {
      if (accent_color === null) {
        cfUser.accent_color = null;
      } else {
        // Validate hex color
        const hex = String(accent_color).trim();
        if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
          // VIP gets preset colors only (enforced client-side; server allows any valid hex from allowed list)
          cfUser.accent_color = hex;
        }
      }
    }
  }

  // Team description — only staff/developer can set their own
  if (team_description !== undefined) {
    const dbUser = db.getUser(req.discordId);
    const role   = dbUser?.role ?? cfUser.role ?? 'member';
    if (FULL_COLOR_ROLES.has(role)) {
      cfUser.team_description = sanitizeText(team_description, 120);
    }
  }

  await cfWrite(`user:${req.discordId}`, cfUser);
  res.json({ success: true });
});

// ── API: follow / unfollow ────────────────────────────────────────────────────

app.post('/api/follow/:discordId', strictLimit, requireAuth, async (req, res) => {
  const targetId = req.params.discordId;
  if (targetId === req.discordId) return res.status(400).json({ error: 'Cannot follow yourself' });

  const [cfTarget, cfSelf] = await Promise.all([
    cfRead(`user:${targetId}`),
    cfRead(`user:${req.discordId}`),
  ]);
  if (!cfTarget) return res.status(404).json({ error: 'User not found' });
  if ((cfTarget.blocked ?? []).includes(req.discordId)) return res.status(403).json({ error: 'Cannot follow this user' });

  const followers = cfTarget.followers ?? [];
  if (followers.includes(req.discordId)) return res.json({ success: true }); // already following

  cfTarget.followers = [...followers, req.discordId];
  if (cfSelf) cfSelf.following = [...new Set([...(cfSelf.following ?? []), targetId])];

  await Promise.all([
    cfWrite(`user:${targetId}`, cfTarget),
    cfSelf ? cfWrite(`user:${req.discordId}`, cfSelf) : Promise.resolve(),
  ]);

  // Notification
  const selfUser = db.getUser(req.discordId) ?? cfSelf;
  const displayName = cfSelf?.display_name ?? selfUser?.username ?? 'Someone';
  await addNotification(targetId, {
    type: 'follow',
    from_discord_id: req.discordId,
    from_username:   selfUser?.username ?? '',
    from_display_name: displayName,
    message: `${displayName} followed you!`,
  });

  // Discord DM (fire and forget)
  const profileUrl = `${process.env.SITE_URL}/u/${req.discordId}`;
  sendDiscordDM(targetId, `**[${displayName}](${profileUrl})** followed you on Exon External!`).catch(() => {});

  res.json({ success: true });
});

app.delete('/api/follow/:discordId', strictLimit, requireAuth, async (req, res) => {
  const targetId = req.params.discordId;
  const [cfTarget, cfSelf] = await Promise.all([
    cfRead(`user:${targetId}`),
    cfRead(`user:${req.discordId}`),
  ]);

  if (cfTarget) {
    cfTarget.followers = (cfTarget.followers ?? []).filter(id => id !== req.discordId);
    await cfWrite(`user:${targetId}`, cfTarget);
  }
  if (cfSelf) {
    cfSelf.following = (cfSelf.following ?? []).filter(id => id !== targetId);
    await cfWrite(`user:${req.discordId}`, cfSelf);
  }
  res.json({ success: true });
});

// ── API: followers / following lists ─────────────────────────────────────────

async function buildUserList(ids) {
  return Promise.all(ids.map(async id => {
    const cf = await cfRead(`user:${id}`);
    const db_ = db.getUser(id);
    const u = { ...(db_ ?? {}), ...(cf ?? {}) };
    return {
      discord_id:   id,
      username:     u.username ?? '—',
      display_name: u.display_name ?? u.username ?? '—',
      avatar:       u.avatar ?? null,
      role:         u.role ?? 'member',
      badges:       [...(u.badges ?? []), ...(hasOneYear(u.created_at) ? ['1_year_member'] : [])],
    };
  }));
}

app.get('/api/followers/:discordId', looseLimit, async (req, res) => {
  const cfUser  = await cfRead(`user:${req.params.discordId}`);
  if (!cfUser) return res.status(404).json({ error: 'User not found' });
  const privacy = cfUser.privacy ?? {};
  if (!privacy.show_follower_count) return res.status(403).json({ error: 'Follower list is private' });

  // Block check
  const auth    = (req.headers.authorization ?? '').replace('Bearer ', '');
  const payload = auth ? verifyToken(auth) : null;
  const requesterId = payload?.sub ?? null;
  if (requesterId && (cfUser.blocked ?? []).includes(requesterId)) {
    return res.status(404).json({ error: 'User not found' });
  }

  const list = await buildUserList(cfUser.followers ?? []);
  res.json({ followers: list });
});

app.get('/api/following/:discordId', looseLimit, async (req, res) => {
  const cfUser  = await cfRead(`user:${req.params.discordId}`);
  if (!cfUser) return res.status(404).json({ error: 'User not found' });
  const privacy = cfUser.privacy ?? {};
  if (!privacy.show_follower_count) return res.status(403).json({ error: 'Following list is private' });

  const auth    = (req.headers.authorization ?? '').replace('Bearer ', '');
  const payload = auth ? verifyToken(auth) : null;
  const requesterId = payload?.sub ?? null;
  if (requesterId && (cfUser.blocked ?? []).includes(requesterId)) {
    return res.status(404).json({ error: 'User not found' });
  }

  const list = await buildUserList(cfUser.following ?? []);
  res.json({ following: list });
});

// ── API: block / unblock ──────────────────────────────────────────────────────

app.post('/api/block/:discordId', strictLimit, requireAuth, async (req, res) => {
  const targetId = req.params.discordId;
  if (targetId === req.discordId) return res.status(400).json({ error: 'Cannot block yourself' });

  const [cfSelf, cfTarget] = await Promise.all([
    cfRead(`user:${req.discordId}`),
    cfRead(`user:${targetId}`),
  ]);
  if (!cfSelf) return res.status(404).json({ error: 'User not found' });

  // Add block
  cfSelf.blocked = [...new Set([...(cfSelf.blocked ?? []), targetId])];
  // Remove them from your followers and you from their following
  cfSelf.followers = (cfSelf.followers ?? []).filter(id => id !== targetId);
  if (cfTarget) {
    cfTarget.following = (cfTarget.following ?? []).filter(id => id !== req.discordId);
    await cfWrite(`user:${targetId}`, cfTarget);
  }
  await cfWrite(`user:${req.discordId}`, cfSelf);
  res.json({ success: true });
});

app.delete('/api/block/:discordId', strictLimit, requireAuth, async (req, res) => {
  const cfSelf = await cfRead(`user:${req.discordId}`);
  if (!cfSelf) return res.status(404).json({ error: 'User not found' });
  cfSelf.blocked = (cfSelf.blocked ?? []).filter(id => id !== req.params.discordId);
  await cfWrite(`user:${req.discordId}`, cfSelf);
  res.json({ success: true });
});

// ── API: notifications ────────────────────────────────────────────────────────

app.get('/api/notifications', standardLimit, requireAuth, async (req, res) => {
  const cfUser = await cfRead(`user:${req.discordId}`);
  if (!cfUser) return res.json({ notifications: [], unread_count: 0 });
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const notifications  = (cfUser.notifications ?? []).filter(n => n.created_at > thirtyDaysAgo);
  res.json({ notifications, unread_count: notifications.filter(n => !n.read).length });
});

app.post('/api/notifications/read', standardLimit, requireAuth, express.json(), async (req, res) => {
  const { id } = req.body ?? {}; // if no id, mark all read
  const cfUser = await cfRead(`user:${req.discordId}`);
  if (!cfUser) return res.json({ success: true });
  cfUser.notifications = (cfUser.notifications ?? []).map(n => ({
    ...n, read: id ? (n.id === id ? true : n.read) : true,
  }));
  await cfWrite(`user:${req.discordId}`, cfUser);
  res.json({ success: true });
});

// ── API: user search ──────────────────────────────────────────────────────────

app.get('/api/search', looseLimit, async (req, res) => {
  const q = sanitizeText(req.query.q ?? '', 50).toLowerCase();
  if (q.length < 2) return res.json({ results: [] });

  // Search CF KV index first (persists across restarts), fall back to local DB
  const cfIndex  = (await cfRead('search_index')) ?? [];
  const dbUsers  = db.getAllUsers();

  // Merge: CF index as base, local DB updates on top
  const merged = new Map();
  cfIndex.forEach(u => merged.set(u.discord_id, u));
  dbUsers.forEach(u => merged.set(u.discord_id, { ...merged.get(u.discord_id), ...u }));

  const matched = [...merged.values()]
    .filter(u => {
      const name   = (u.display_name ?? u.username ?? '').toLowerCase();
      const handle = (u.username ?? '').toLowerCase();
      return name.includes(q) || handle.includes(q);
    })
    .slice(0, 20);

  // Enrich with CF user record for display_name/badges/role
  const results = await Promise.all(matched.map(async u => {
    const cf = await cfRead(`user:${u.discord_id}`);
    const dbUser = db.getUser(u.discord_id);
    return {
      discord_id:   u.discord_id,
      username:     u.username,
      display_name: cf?.display_name ?? u.username,
      avatar:       u.avatar ?? cf?.avatar,
      role:         dbUser?.role ?? cf?.role ?? 'member',
      badges:       [...(cf?.badges ?? []), ...(hasOneYear(u.created_at ?? cf?.created_at) ? ['1_year_member'] : [])],
    };
  }));

  res.json({ results });
});

// ── API: online users count ───────────────────────────────────────────────────

app.get('/api/stats/online', looseLimit, async (req, res) => {
  const fiveMinAgo = Date.now() - 5 * 60 * 1000;
  const allUsers   = db.getAllUsers();
  let count = 0;
  const avatars = [];

  for (const u of allUsers) {
    if (!u.last_seen || u.last_seen < fiveMinAgo) continue;
    const cf = await cfRead(`user:${u.discord_id}`);
    if (!cf) continue;
    const privacy = cf.privacy ?? {};
    if (!privacy.show_online_status) continue;
    if (cf.banned) continue;
    count++;
    if (avatars.length < 5 && u.avatar) avatars.push(u.avatar);
  }

  res.json({ online: count, avatars });
});

// ── API: admin badges ─────────────────────────────────────────────────────────

app.post('/api/admin/badges/:discordId', requireAdmin, express.json(), async (req, res) => {
  const { badge, action } = req.body ?? {};
  if (!badge) return res.status(400).json({ error: 'badge required' });
  if (!VALID_BADGES.includes(badge)) return res.status(400).json({ error: 'Invalid badge' });
  const cfUser = await cfRead(`user:${req.params.discordId}`);
  if (!cfUser) return res.status(404).json({ error: 'User not found' });
  const badges = cfUser.badges ?? [];
  cfUser.badges = action === 'remove' ? badges.filter(b => b !== badge) : [...new Set([...badges, badge])];
  await cfWrite(`user:${req.params.discordId}`, cfUser);
  res.json({ success: true, badges: cfUser.badges });
});

// ── Start ─────────────────────────────────────────────────────────────────────

async function cfListAllKeys() {
  if (!cfReady()) return [];
  const results = [];
  let cursor = null;
  do {
    const url = `${cfBase()}/keys?limit=1000${cursor ? `&cursor=${cursor}` : ''}`;
    try {
      const res  = await axios.get(url, { headers: cfHeaders() });
      const body = res.data;
      results.push(...(body.result ?? []).map(k => k.name));
      cursor = body.result_info?.cursor ?? null;
    } catch { break; }
  } while (cursor);
  return results;
}

async function restoreAllFromCF() {
  console.log('Restoring keys from CF...');
  const allCFKeys = await cfListAllKeys();
  const keyNames  = allCFKeys.filter(k => !k.startsWith('user:'));
  let restored = 0;

  await Promise.all(keyNames.map(async kv => {
    if (db.getKey(kv)) return; // already in local DB
    const cf = await cfRead(kv);
    if (!cf || !cf.discord_id) return;
    db.insertKey(kv, cf.plan ?? null, null, null);
    db.linkKey(kv, cf.discord_id);
    if (cf.active || cf.time_created) db.activateKey(kv);
    restored++;
  }));

  console.log(`CF restore complete — ${restored} key(s) restored.`);
}

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => {
  console.log(`Exon server running → http://localhost:${PORT}`);
  if (cfReady()) restoreAllFromCF().catch(err => console.error('CF restore error:', err.message));
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
