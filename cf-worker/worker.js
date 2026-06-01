/**
 * Exon External — Cloudflare Worker (Key Validation)
 *
 * KV namespace binding: KEYS
 * Each key stored as: { key, discord_id, hwid, time_created, length }
 *
 * Routes:
 *   POST /activate  { key, hwid }             → bind HWID on first use
 *   POST /verify    { key, hwid }             → check key is valid + not expired
 *   POST /link      { key, discord_id }       → called by server when user links
 *   GET  /info      ?key=exon-XXXX-...        → return key data (internal/mod use)
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function isExpired(entry) {
  if (!entry.length) return false; // no expiry = lifetime
  const expiresAt = entry.time_created + entry.length * 60 * 1000;
  return Date.now() > expiresAt;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    // ── POST /activate ──────────────────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/activate') {
      const { key, hwid } = await request.json().catch(() => ({}));
      if (!key || !hwid) return json({ error: 'key and hwid required' }, 400);

      const raw = await env.KEYS.get(key);
      if (!raw) return json({ error: 'Key not found' }, 404);

      const entry = JSON.parse(raw);

      if (!entry.active) return json({ error: 'Key is inactive' }, 403);
      if (isExpired(entry)) return json({ error: 'Key has expired' }, 403);

      if (entry.hwid && entry.hwid !== hwid) {
        return json({ error: 'HWID mismatch — key is bound to a different machine' }, 403);
      }

      // First activation — bind HWID
      if (!entry.hwid) {
        entry.hwid = hwid;
        await env.KEYS.put(key, JSON.stringify(entry));
      }

      return json({ success: true, key: entry.key, discord_id: entry.discord_id });
    }

    // ── POST /verify ────────────────────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/verify') {
      const { key, hwid } = await request.json().catch(() => ({}));
      if (!key || !hwid) return json({ error: 'key and hwid required' }, 400);

      const raw = await env.KEYS.get(key);
      if (!raw) return json({ valid: false, reason: 'Key not found' }, 404);

      const entry = JSON.parse(raw);

      if (!entry.active)         return json({ valid: false, reason: 'Key is inactive' });
      if (isExpired(entry))      return json({ valid: false, reason: 'Key has expired' });
      if (entry.hwid !== hwid)   return json({ valid: false, reason: 'HWID mismatch' });

      return json({ valid: true });
    }

    // ── POST /link ──────────────────────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/link') {
      // Verify internal token
      const auth = request.headers.get('Authorization') ?? '';
      if (auth !== `Bearer ${env.INTERNAL_SECRET}`) {
        return json({ error: 'Unauthorized' }, 401);
      }

      const { key, discord_id } = await request.json().catch(() => ({}));
      if (!key || !discord_id) return json({ error: 'key and discord_id required' }, 400);

      const raw = await env.KEYS.get(key);
      if (!raw) return json({ error: 'Key not found' }, 404);

      const entry = JSON.parse(raw);
      entry.discord_id = discord_id;
      await env.KEYS.put(key, JSON.stringify(entry));

      return json({ success: true });
    }

    // ── GET /info ───────────────────────────────────────────────────────────
    if (request.method === 'GET' && url.pathname === '/info') {
      const auth = request.headers.get('Authorization') ?? '';
      if (auth !== `Bearer ${env.INTERNAL_SECRET}`) {
        return json({ error: 'Unauthorized' }, 401);
      }

      const key = url.searchParams.get('key');
      if (!key) return json({ error: 'key param required' }, 400);

      const raw = await env.KEYS.get(key);
      if (!raw) return json({ error: 'Key not found' }, 404);

      const entry = JSON.parse(raw);
      return json({
        ...entry,
        expired: isExpired(entry),
        expires_at: entry.length
          ? new Date(entry.time_created + entry.length * 60 * 1000).toISOString()
          : null,
      });
    }

    return json({ error: 'Not found' }, 404);
  },
};
