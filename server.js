/**
 * Exon External — Backend Server
 *
 * Handles:
 *  - Static file serving
 *  - Discord OAuth2 login
 *  - JWT auth
 *  - Key linking + role promotion
 *  - Stripe webhook → key generation + email
 *
 * Install:
 *   npm install express stripe better-sqlite3 jsonwebtoken axios cors dotenv
 *
 * Run:
 *   node server.js
 */

require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const fs         = require('fs');
const axios      = require('axios');
const jwt        = require('jsonwebtoken');
const stripe     = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Database   = require('better-sqlite3');

// ── Database ────────────────────────────────────────────────────────────────

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'exon.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    discord_id  TEXT PRIMARY KEY,
    username    TEXT NOT NULL,
    avatar      TEXT,
    role        TEXT NOT NULL DEFAULT 'member',
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS keys (
    key_value         TEXT PRIMARY KEY,
    discord_id        TEXT,
    active            INTEGER NOT NULL DEFAULT 1,
    plan              TEXT,
    stripe_session_id TEXT,
    customer_email    TEXT,
    created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (discord_id) REFERENCES users(discord_id)
  );
`);

const getUser   = db.prepare('SELECT * FROM users WHERE discord_id = ?');
const getKey    = db.prepare('SELECT * FROM keys WHERE key_value = ?');
const getUserKeys = db.prepare('SELECT * FROM keys WHERE discord_id = ? AND active = 1 ORDER BY created_at DESC');
const upsertUser  = db.prepare(`
  INSERT INTO users (discord_id, username, avatar)
  VALUES (?, ?, ?)
  ON CONFLICT(discord_id) DO UPDATE SET username = excluded.username, avatar = excluded.avatar
`);

// ── Role helpers ─────────────────────────────────────────────────────────────

const ROLE_ORDER = ['member', 'customer', 'staff', 'developer'];

function promoteUser(discordId, targetRole) {
  const user = getUser.get(discordId);
  if (!user) return;
  if (ROLE_ORDER.indexOf(user.role) < ROLE_ORDER.indexOf(targetRole)) {
    db.prepare('UPDATE users SET role = ? WHERE discord_id = ?').run(targetRole, discordId);
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

// ── Key generation ─────────────────────────────────────────────────────────────

function generateKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const seg   = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `exon-${seg()}-${seg()}-${seg()}-test`;
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

// ── Express ──────────────────────────────────────────────────────────────────

const app = express();

app.use(cors({
  origin: process.env.SITE_URL ?? '*',
  credentials: true,
}));

// Serve static site files
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
    // Exchange code for access token
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

    // Get Discord user info
    const userRes = await axios.get('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bearer ${tokenRes.data.access_token}` },
    });

    const { id, username, discriminator, avatar } = userRes.data;
    const avatarUrl = avatar
      ? `https://cdn.discordapp.com/avatars/${id}/${avatar}.png?size=128`
      : `https://cdn.discordapp.com/embed/avatars/${(BigInt(id) >> 22n) % 6n}.png`;

    // Upsert user record
    upsertUser.run(id, username, avatarUrl);

    // Issue JWT and redirect back to site
    const token = issueToken(id);
    res.redirect(`/?token=${token}`);
  } catch (err) {
    console.error('OAuth error:', err.response?.data ?? err.message);
    res.redirect('/?error=oauth_failed');
  }
});

// ── API: me ─────────────────────────────────────────────────────────────────

app.get('/api/me', requireAuth, (req, res) => {
  const user = getUser.get(req.discordId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const keys = getUserKeys.all(req.discordId);
  res.json({ ...user, keys });
});

// ── API: link key ─────────────────────────────────────────────────────────────

app.post('/api/link-key', requireAuth, express.json(), (req, res) => {
  const { key } = req.body ?? {};
  if (!key) return res.status(400).json({ error: 'Key is required' });

  const existing = getKey.get(key);
  if (!existing)          return res.status(404).json({ error: 'Key not found' });
  if (existing.discord_id) return res.status(409).json({ error: 'Key is already linked to an account' });
  if (!existing.active)   return res.status(410).json({ error: 'Key is no longer active' });

  db.prepare('UPDATE keys SET discord_id = ? WHERE key_value = ?').run(req.discordId, key);

  // Make sure the user record exists (might be logging in fresh)
  const user = getUser.get(req.discordId);
  if (!user) return res.status(404).json({ error: 'User record not found — please log in first' });

  promoteUser(req.discordId, 'customer');

  res.json({ success: true });
});

// ── API: mod — check user license ─────────────────────────────────────────────
// (Requires staff/developer role — validated by bot; this endpoint is for internal use)

app.get('/api/check/:discordId', requireAuth, (req, res) => {
  const caller = getUser.get(req.discordId);
  if (!caller || !['staff', 'developer'].includes(caller.role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const target = getUser.get(req.params.discordId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const keys = getUserKeys.all(req.params.discordId);
  res.json({ ...target, keys });
});

// ── Stripe webhook ─────────────────────────────────────────────────────────────

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

    // Store key in DB (unlinked until user logs in and claims it)
    db.prepare(`
      INSERT OR IGNORE INTO keys (key_value, active, plan, stripe_session_id, customer_email)
      VALUES (?, 1, ?, ?, ?)
    `).run(key, plan, session.id, email);

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

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => {
  console.log(`Exon server running → http://localhost:${PORT}`);
});
