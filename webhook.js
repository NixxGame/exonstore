/**
 * Exon External — Stripe Webhook + Email Delivery
 *
 * Setup:
 *   npm install express stripe resend dotenv
 *
 * Create a .env file (see .env.example) then run:
 *   node webhook.js
 *
 * Point your Stripe webhook to:
 *   https://yourdomain.com/webhook
 * Events to listen for:
 *   checkout.session.completed
 */

require('dotenv').config();
const express  = require('express');
const stripe   = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

const app = express();

// Stripe requires the raw body for signature verification
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email   = session.customer_details?.email ?? session.customer_email;

    if (email) {
      const key = generateKey();
      try {
        await sendConfirmationEmail(email, key, session);
        console.log(`Key sent to ${email}: ${key}`);
      } catch (err) {
        console.error('Email send error:', err.message);
      }
    } else {
      console.warn('checkout.session.completed — no customer email found');
    }
  }

  res.json({ received: true });
});

// ── Key generation ──────────────────────────────────────────────────────────

function generateKey() {
  const chars   = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const segment = () =>
    Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `exon-${segment()}-${segment()}-${segment()}-test`;
}

// ── Email ───────────────────────────────────────────────────────────────────

async function sendConfirmationEmail(to, key, session) {

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your Exon External License</title>
</head>
<body style="margin:0;padding:0;background:#06080d;font-family:system-ui,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#eef0f6;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#06080d;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

          <!-- Header -->
          <tr>
            <td align="center" style="padding:0 0 32px;">
              <span style="font-size:1.4rem;font-weight:800;letter-spacing:-.02em;color:#eef0f6;">
                Exon <span style="color:#f07a12;">External</span>
              </span>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td style="background:#0e1119;border:1px solid rgba(255,255,255,.07);border-radius:20px;padding:40px 36px;position:relative;">

              <p style="margin:0 0 6px;font-size:.72rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#f07a12;">
                Order Confirmed
              </p>
              <h1 style="margin:0 0 16px;font-size:1.55rem;font-weight:800;letter-spacing:-.03em;color:#eef0f6;line-height:1.2;">
                Your license is ready.
              </h1>
              <p style="margin:0 0 28px;font-size:.92rem;color:#7a8394;line-height:1.65;">
                Thanks for your purchase. Your Exon External license key is below.
                Keep it safe — it's tied to your hardware ID on first use.
              </p>

              <!-- Key box -->
              <div style="background:#06080d;border:1px solid rgba(240,122,18,.3);border-radius:12px;padding:18px 22px;margin:0 0 28px;text-align:center;">
                <p style="margin:0 0 6px;font-size:.68rem;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:#7a8394;">License Key</p>
                <p style="margin:0;font-size:1.15rem;font-weight:700;letter-spacing:.06em;color:#f07a12;font-family:'Courier New',Courier,monospace;">
                  ${key}
                </p>
              </div>

              <!-- Steps -->
              <p style="margin:0 0 12px;font-size:.8rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#eef0f6;">
                Getting started
              </p>
              <ol style="margin:0 0 28px;padding:0 0 0 18px;color:#7a8394;font-size:.88rem;line-height:1.8;">
                <li>Download the loader from our Discord server.</li>
                <li>Run the loader and enter your key when prompted.</li>
                <li>Launch Dead by Daylight and enjoy.</li>
              </ol>

              <p style="margin:0;font-size:.85rem;color:#7a8394;line-height:1.65;">
                Need help? Join our
                <a href="https://discord.gg/NczWT7nyAs" style="color:#f07a12;text-decoration:none;">Discord server</a>
                and open a support ticket — we'll get you sorted.
              </p>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding:28px 0 0;">
              <p style="margin:0;font-size:.75rem;color:#404858;line-height:1.6;">
                © 2026 Exon External &nbsp;·&nbsp;
                <a href="https://exoncheats.com/terms.html" style="color:#404858;">Terms</a> &nbsp;·&nbsp;
                <a href="https://exoncheats.com/privacy.html" style="color:#404858;">Privacy</a> &nbsp;·&nbsp;
                <a href="https://exoncheats.com/refund.html" style="color:#404858;">Refunds</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const { error } = await resend.emails.send({
    from:    `Exon External <${process.env.SMTP_FROM}>`,
    to,
    subject: 'Your Exon External License Key',
    html,
    text: `Your Exon External license key: ${key}\n\nJoin our Discord for setup help: https://discord.gg/NczWT7nyAs`,
  });

  if (error) throw new Error(error.message);
}

// ── Start ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => console.log(`Webhook server listening on port ${PORT}`));
