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
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);
const db      = require('./db');

// ── Role helpers ──────────────────────────────────────────────────────────────

const ROLE_ORDER = ['member', 'customer', 'staff', 'developer'];

function promoteUser(discordId, targetRole) {
  const user = db.getUser(discordId);
  if (!user) return;
  if (ROLE_ORDER.indexOf(user.role) < ROLE_ORDER.indexOf(targetRole)) {
    db.setUserRole(discordId, targetRole);
    assignDiscordRole(discordId, `DISCORD_ROLE_${targetRole.toUpperCase()}`);
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
  if (p.includes('3 month')) return 129600;
  if (p.includes('month'))   return 43200;
  if (p.includes('week'))    return 10080;
  if (p.includes('day'))     return 1440;
  return null;
}

async function writeKeyToCF(key, discordId, plan) {
  const accountId  = process.env.CF_ACCOUNT_ID;
  const namespaceId = process.env.CF_KV_NAMESPACE_ID;
  const apiToken   = process.env.CF_API_TOKEN;
  if (!accountId || !namespaceId || !apiToken) return;

  const value = JSON.stringify({
    key,
    discord_id:   discordId ?? null,
    hwid:         null,
    time_created: Date.now(),
    length:       planToMinutes(plan),
  });

  try {
    await axios.put(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`,
      value,
      { headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'text/plain' } }
    );
  } catch (err) {
    console.error('CF KV write error:', err.response?.data ?? err.message);
  }
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

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email   = session.customer_details?.email ?? session.customer_email;
    const plan    = session.metadata?.plan ?? null;

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

  res.json({ received: true });
});

app.use(express.static(path.join(__dirname)));

// ── Discord OAuth ─────────────────────────────────────────────────────────────

app.get('/auth/discord', (req, res) => {
  const params = new URLSearchParams({
    client_id:     process.env.DISCORD_CLIENT_ID,
    redirect_uri:  process.env.DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope:         'identify',
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

    const token = issueToken(id);
    res.redirect(`/?token=${token}`);
  } catch (err) {
    console.error('OAuth error:', err.response?.data ?? err.message);
    res.redirect('/?error=oauth_failed');
  }
});

// ── API: me ───────────────────────────────────────────────────────────────────

app.get('/api/me', requireAuth, (req, res) => {
  const user = db.getUser(req.discordId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const keys = db.getUserKeys(req.discordId);
  res.json({ ...user, keys });
});

// ── API: link key ─────────────────────────────────────────────────────────────

app.post('/api/link-key', requireAuth, express.json(), (req, res) => {
  const { key } = req.body ?? {};
  if (!key) return res.status(400).json({ error: 'Key is required' });

  const existing = db.getKey(key);
  if (!existing)            return res.status(404).json({ error: 'Key not found' });
  if (existing.discord_id)  return res.status(409).json({ error: 'Key is already linked to an account' });
  if (!existing.active)     return res.status(410).json({ error: 'Key is no longer active' });

  const user = db.getUser(req.discordId);
  if (!user) return res.status(404).json({ error: 'User record not found — please log in first' });

  db.linkKey(key, req.discordId);
  promoteUser(req.discordId, 'customer');

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
