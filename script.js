// ── LOADER FILE SIZE ──────────────────────────────────────────────────────
(async function fetchLoaderSize() {
  const el = document.getElementById('dl-size');
  if (!el) return;
  try {
    const res  = await fetch('/api/loader/version');
    const data = await res.json();
    el.textContent = data.size_mb ? parseFloat(data.size_mb).toFixed(2) + ' MB' : '';
  } catch {
    el.textContent = '';
  }
})();

// ── AUTH & PROFILE ─────────────────────────────────────────────────────────

const API = ''; // empty = same origin; set to 'https://your-server.com' if hosted separately

const ROLE_ORDER = ['member', 'customer', 'vip', 'staff', 'developer'];
const ROLE_LABELS = { member: 'Member', customer: 'Customer', vip: 'VIP', staff: 'Staff', developer: 'Developer' };


// On load: grab token from URL (after Discord OAuth redirect) or localStorage
(function initAuth() {
  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get('token');
  if (urlToken) {
    localStorage.setItem('exon_token', urlToken);
    params.delete('token');
    const newUrl = window.location.pathname + (params.toString() ? '?' + params : '');
    history.replaceState(null, '', newUrl);
  }
  const token = localStorage.getItem('exon_token');
  if (token) fetchProfile(token);
})();

async function fetchProfile(token) {
  try {
    const res = await fetch(`${API}/api/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    // Only sign out on auth errors, not server errors
    if (res.status === 401) { signOut(); return; }
    if (!res.ok) return; // server restarting — stay logged in, retry later
    const user = await res.json();
    renderNav(user);
    renderProfileCard(user);
  } catch {
    // network error — stay logged in
  }
}

function renderNav(user) {
  document.getElementById('nav-login').style.display    = 'none';
  const btn = document.getElementById('nav-profile-btn');
  btn.style.display = 'flex';
  document.getElementById('nav-avatar').src             = user.avatar ?? '';
  document.getElementById('nav-username').textContent   = user.username;
  const dot = document.getElementById('nav-role-dot');
  dot.dataset.role = user.role;
  // Show bell for logged-in users
  const bellWrap = document.getElementById('nav-bell-wrap');
  if (bellWrap) bellWrap.style.display = 'flex';
  loadNotifications();
}

function renderProfileCard(user) {
  const card = document.getElementById('profile-card');
  card.dataset.role = user.role;

  document.getElementById('pc-avatar').src           = user.avatar ?? '';
  document.getElementById('pc-username').textContent = user.username;

  const profileLink = document.getElementById('pc-profile-link');
  if (profileLink) profileLink.href = `/u/${user.vanity ?? user.discord_id}`;

  const adminBtn = document.getElementById('pc-admin-btn');
  if (adminBtn) adminBtn.style.display = ['staff','developer'].includes(user.role) ? '' : 'none';
  const actrlBtn = document.getElementById('pc-actrl-btn');
  if (actrlBtn) actrlBtn.style.display = ['staff','developer'].includes(user.role) ? '' : 'none';

  const badge = document.getElementById('pc-role-badge');
  badge.textContent    = ROLE_LABELS[user.role] ?? user.role;
  badge.dataset.role   = user.role;

  // Role tags: show all roles up to and including the user's current role
  const rolesEl = document.getElementById('pc-roles');
  rolesEl.innerHTML = '';
  const cap = ROLE_ORDER.indexOf(user.role);
  ROLE_ORDER.slice(0, cap + 1).forEach(r => {
    const span = document.createElement('span');
    span.className    = 'role-tag';
    span.dataset.role = r;
    span.textContent  = ROLE_LABELS[r];
    rolesEl.appendChild(span);
  });

  // Keys — active first (full details), queued below (compact), scrollable
  const keysEl = document.getElementById('pc-keys');
  keysEl.innerHTML = '';

  if (!user.keys || user.keys.length === 0) {
    keysEl.innerHTML = '<div class="profile-no-keys">No keys linked yet.</div>';
    return;
  }

  const totalMs = user.combined_ms ?? 0;
  const timeStr = totalMs > 0 ? formatTimeLeft(Date.now() + totalMs) : 'Not Activated';
  const timeCol = totalMs > 0 ? 'key-active' : '';

  // Key expiry warning: show amber banner if soonest active key expires within 7 days
  let expiryWarningHtml = '';
  for (const k of user.keys ?? []) {
    if (k.queue_status === 'active') {
      // We'll check after key details load; for now show banner only if combined_ms is set
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      if (user.combined_ms > 0 && user.combined_ms <= sevenDaysMs) {
        const d = Math.floor(user.combined_ms / 86400000);
        const h = Math.floor((user.combined_ms % 86400000) / 3600000);
        expiryWarningHtml = `<div style="background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.3);border-radius:9px;padding:9px 14px;margin-bottom:10px;font-size:.8rem;color:#fbbf24;">
          ⚠️ Your subscription expires in <strong>${d > 0 ? d + 'd ' : ''}${h}h</strong> — <a href="#pricing" style="color:#f07a12;text-decoration:underline">renew</a>
        </div>`;
      }
      break;
    }
  }

  // Combined header
  const header = document.createElement('div');
  header.className = 'profile-key-item';
  header.innerHTML = `
    ${expiryWarningHtml}
    <div class="profile-key-header">
      <span class="profile-key-value">Exon External License</span>
      <span class="profile-key-plan ${timeCol}">${timeStr}</span>
    </div>
  `;
  keysEl.appendChild(header);

  // Scrollable key list
  const scroll = document.createElement('div');
  scroll.className = 'key-scroll-list';
  scroll.innerHTML = '<div class="key-detail-loading">Loading...</div>';
  keysEl.appendChild(scroll);

  // Load all keys then render
  loadKeyList(user.keys, scroll);
}

async function loadKeyList(keys, container) {
  const token = localStorage.getItem('exon_token');
  const results = [];

  for (const k of keys) {
    try {
      const res  = await fetch(`${API}/api/key/${encodeURIComponent(k.key_value)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (res.ok) results.push({ k, data });
    } catch {}
  }

  if (!results.length) {
    container.innerHTML = '<div class="key-detail-err">Could not load key details.</div>';
    return;
  }

  // Sort: active first, then queued
  results.sort((a, b) => {
    const order = { active: 0, queued: 1 };
    return (order[a.k.queue_status] ?? 2) - (order[b.k.queue_status] ?? 2);
  });

  container.innerHTML = '';
  results.forEach(({ k, data }, i) => {
    const isActive = k.queue_status === 'active';
    const entry    = document.createElement('div');
    entry.className = 'key-list-entry' + (isActive ? ' key-list-active' : ' key-list-queued');

    if (isActive) {
      // Full details for active key
      const purchased = data.purchased_at ? new Date(data.purchased_at).toLocaleString() : '—';
      const activated = data.activated_at ? new Date(data.activated_at).toLocaleString() : 'Not yet';
      const expires   = data.expires_at   ? new Date(data.expires_at).toLocaleString()   : (data.activated_at ? 'Never' : 'Not Redeemed');
      const timeLeft  = data.expired ? 'Expired'
                      : data.expires_at ? formatTimeLeft(data.expires_at)
                      : data.activated_at ? '∞'
                      : formatMinutes(data.length);
      const hwidHtml  = data.hwid
        ? `<div class="key-hwid-wrap"><span class="key-hwid">${data.hwid}</span><button class="key-hwid-reset" onclick="resetHwid('${data.key_value}',this)">Reset</button></div>`
        : `<span class="key-not-activated">Run the loader to activate</span>`;

      entry.innerHTML = `
        <div class="key-list-label">${k.plan ?? 'License'} <span class="key-queue-badge active">Active</span></div>
        <div class="key-detail-row"><span>Purchased</span><span>${purchased}</span></div>
        <div class="key-detail-row"><span>Activated</span><span>${activated}</span></div>
        <div class="key-detail-row"><span>Expires</span><span>${expires}</span></div>
        <div class="key-detail-row"><span>Time Left</span><span class="${data.expired ? 'key-expired' : 'key-active'}">${timeLeft}</span></div>
        <div class="key-detail-row hwid-row"><span>HWID</span>${hwidHtml}</div>
      `;
    } else {
      // Compact row for queued keys
      const purchased = data.purchased_at ? new Date(data.purchased_at).toLocaleDateString() : '—';
      const timeLeft  = formatMinutes(data.length);
      entry.innerHTML = `
        <div class="key-list-compact">
          <div class="key-list-compact-left">
            <span class="key-queue-badge queued">Queued</span>
            <span class="key-list-compact-plan">${k.plan ?? 'License'}</span>
          </div>
          <div class="key-list-compact-right">
            <span class="key-list-compact-time">${timeLeft}</span>
            <span class="key-list-compact-date">${purchased}</span>
          </div>
        </div>
      `;
    }

    container.appendChild(entry);
  });
}

async function toggleKeyDetails(keyValue) {
  const el = document.getElementById(`kd-${keyValue}`);
  const isOpen = el.classList.contains('open');

  // Close all
  document.querySelectorAll('.profile-key-details').forEach(d => d.classList.remove('open'));
  document.querySelectorAll('.profile-key-item').forEach(d => d.classList.remove('expanded'));

  if (isOpen) return;

  el.classList.add('open');
  el.closest('.profile-key-item').classList.add('expanded');

  const token = localStorage.getItem('exon_token');
  try {
    const res  = await fetch(`${API}/api/key/${encodeURIComponent(keyValue)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (!res.ok) { el.innerHTML = `<div class="key-detail-err">${data.error}</div>`; return; }

    const purchased  = data.purchased_at  ? new Date(data.purchased_at).toLocaleString()  : '—';
    const activated  = data.activated_at  ? new Date(data.activated_at).toLocaleString()  : 'Not yet';
    const expires    = data.expires_at    ? new Date(data.expires_at).toLocaleString()    : (data.activated_at ? 'Never' : 'Not Redeemed');
    const timeLeft   = data.expired ? 'Expired'
                     : data.expires_at ? formatTimeLeft(data.expires_at)
                     : data.activated_at ? '∞'
                     : formatMinutes(data.length); // not yet activated — show full plan duration
    const hwid       = data.hwid ?? 'Not activated yet';

    const hwidHtml = data.hwid
      ? `<div class="key-detail-row hwid-row">
           <span>HWID</span>
           <div class="key-hwid-wrap">
             <span class="key-hwid">${data.hwid}</span>
             <button class="key-hwid-reset" onclick="resetHwid('${data.key_value}', this)">Reset</button>
           </div>
         </div>`
      : `<div class="key-detail-row"><span>HWID</span><span style="color:var(--text-dim)">Not activated yet</span></div>`;

    el.innerHTML = `
      <div class="key-detail-row"><span>Purchased</span><span>${purchased}</span></div>
      <div class="key-detail-row"><span>Activated</span><span>${activated}</span></div>
      <div class="key-detail-row"><span>Expires</span><span>${expires}</span></div>
      <div class="key-detail-row"><span>Time Left</span><span class="${data.expired ? 'key-expired' : 'key-active'}">${timeLeft}</span></div>
      ${hwidHtml}
    `;
  } catch {
    el.innerHTML = '<div class="key-detail-err">Could not load details.</div>';
  }
}

function formatTimeLeft(expiresAt) {
  const ms   = expiresAt - Date.now();
  if (ms <= 0) return 'Expired';
  const days  = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  const mins  = Math.floor((ms % 3600000)  / 60000);
  if (days > 0)  return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

async function resetHwid(keyValue, btn) {
  if (!confirm('Reset your HWID? The next time you run the loader it will bind to your new machine.')) return;
  btn.disabled = true;
  btn.textContent = '...';
  const token = localStorage.getItem('exon_token');
  try {
    const res = await fetch(`${API}/api/reset-hwid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ key_value: keyValue }),
    });
    if (res.ok) {
      btn.closest('.hwid-row').querySelector('.key-hwid').textContent = 'Reset — activate on next loader launch';
      btn.remove();
    } else {
      btn.textContent = 'Failed';
      setTimeout(() => { btn.disabled = false; btn.textContent = 'Reset'; }, 2000);
    }
  } catch {
    btn.textContent = 'Error';
    setTimeout(() => { btn.disabled = false; btn.textContent = 'Reset'; }, 2000);
  }
}

const LIFETIME_THRESHOLD = 500000000; // anything above this = lifetime key

function isLifetime(minutes) { return minutes && minutes >= LIFETIME_THRESHOLD; }

function formatMinutes(minutes) {
  if (!minutes) return '∞';
  if (isLifetime(minutes)) return 'Lifetime ∞';
  const days = Math.floor(minutes / 1440);
  if (days >= 1) return `${days}d`;
  const hours = Math.floor(minutes / 60);
  if (hours >= 1) return `${hours}h`;
  return `${minutes}m`;
}

function toggleProfileCard() {
  document.getElementById('profile-card-overlay').classList.toggle('open');
}

function handleOverlayClick(e) {
  if (e.target === document.getElementById('profile-card-overlay')) {
    document.getElementById('profile-card-overlay').classList.remove('open');
  }
}

async function linkKey() {
  const input = document.getElementById('pc-key-input');
  const msg   = document.getElementById('pc-link-msg');
  const key   = input.value.trim();
  msg.className = 'profile-link-msg';
  msg.textContent = '';

  if (!key) { msg.className = 'profile-link-msg err'; msg.textContent = 'Enter a key first.'; return; }

  const token = localStorage.getItem('exon_token');
  try {
    const res  = await fetch(`${API}/api/link-key`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ key }),
    });
    const data = await res.json();
    if (!res.ok) {
      msg.className = 'profile-link-msg err';
      msg.textContent = data.error ?? 'Something went wrong.';
      return;
    }
    msg.className = 'profile-link-msg ok';
    msg.textContent = 'Key linked! Role updated.';
    input.value = '';
    fetchProfile(token);
  } catch {
    msg.className = 'profile-link-msg err';
    msg.textContent = 'Could not reach server.';
  }
}

function signOut() {
  localStorage.removeItem('exon_token');
  document.getElementById('nav-login').style.display = '';
  document.getElementById('nav-profile-btn').style.display = 'none';
  document.getElementById('profile-card-overlay').classList.remove('open');
}

// Close profile card on Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') document.getElementById('profile-card-overlay').classList.remove('open');
});


// ── PARTICLES ──────────────────────────────────────────────────────────────

(function () {
  const canvas = document.getElementById('particles');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let W, H, particles = [];

  const PARTICLE_COUNT = 90;

  function resize() {
    W = canvas.width  = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }

  class Particle {
    constructor() { this.reset(true); }

    reset(initial) {
      this.x    = Math.random() * W;
      this.y    = initial ? Math.random() * H : H + 8;
      this.r    = Math.random() * 1.2 + 0.3;
      this.vx   = (Math.random() - 0.5) * 0.25;
      this.vy   = -(Math.random() * 0.35 + 0.1);
      this.base = Math.random() * 0.35 + 0.04;
      this.op   = 0;
      this.life = 0;
      this.max  = Math.random() * 320 + 160;
      // ~20% orange, rest white
      this.orange = Math.random() < 0.2;
    }

    update() {
      this.x   += this.vx;
      this.y   += this.vy;
      this.life++;

      const fade = 30;
      if (this.life < fade) {
        this.op = this.base * (this.life / fade);
      } else if (this.life > this.max - fade) {
        this.op = this.base * ((this.max - this.life) / fade);
      } else {
        this.op = this.base;
      }

      if (this.life >= this.max || this.y < -8) this.reset(false);
    }

    draw() {
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.r, 0, Math.PI * 2);
      ctx.fillStyle = this.orange
        ? `rgba(240,140,40,${this.op})`
        : `rgba(220,225,240,${this.op})`;
      ctx.fill();
    }
  }

  function init() {
    resize();
    particles = Array.from({ length: PARTICLE_COUNT }, () => new Particle());
    window.addEventListener('resize', resize, { passive: true });
    loop();
  }

  function loop() {
    ctx.clearRect(0, 0, W, H);
    particles.forEach(p => { p.update(); p.draw(); });
    requestAnimationFrame(loop);
  }

  init();
})();


// ── SCROLL REVEAL ──────────────────────────────────────────────────────────

const observer = new IntersectionObserver(
  entries => entries.forEach(e => {
    if (e.isIntersecting) {
      e.target.classList.add('active');
      observer.unobserve(e.target);
    }
  }),
  { threshold: 0.08 }
);

document.querySelectorAll('.card, .pricing-box, .feat-item').forEach(el => {
  el.classList.add('reveal');
  observer.observe(el);
});


// ── NAV SCROLL STATE + SCROLL-SPY + SCROLL-TO-TOP ─────────────────────────

const nav = document.getElementById('nav');
const scrollTopBtn = document.getElementById('scroll-top');

const sections = ['overview','feature-list','pricing','faq','download']
  .map(id => document.getElementById(id))
  .filter(Boolean);

window.addEventListener('scroll', () => {
  const y = window.scrollY;

  // scrolled shadow
  nav.classList.toggle('scrolled', y > 50);

  // scroll-to-top visibility
  scrollTopBtn.classList.toggle('visible', y > 400);

  // scroll-spy
  let current = '';
  sections.forEach(sec => {
    if (y >= sec.offsetTop - 140) current = sec.id;
  });
  document.querySelectorAll('.nav-links a[data-section]').forEach(a => {
    a.classList.toggle('nav-active', a.dataset.section === current);
  });
}, { passive: true });


// ── SMOOTH SCROLL ──────────────────────────────────────────────────────────

document.querySelectorAll('a[href^="#"]').forEach(a => {
  a.addEventListener('click', e => {
    const id = a.getAttribute('href');
    const target = document.querySelector(id);
    if (!target || id === '#') return;
    e.preventDefault();
    const top = target.getBoundingClientRect().top + window.scrollY - 88;
    window.scrollTo({ top, behavior: 'smooth' });
  });
});


// ── MOBILE NAV ─────────────────────────────────────────────────────────────

function toggleMobileNav() {
  const hamburger = document.getElementById('nav-hamburger');
  const links = document.getElementById('nav-links');
  hamburger.classList.toggle('open');
  links.classList.toggle('mobile-open');
}

// Close mobile nav when a link is clicked
document.querySelectorAll('.nav-links a').forEach(a => {
  a.addEventListener('click', () => {
    document.getElementById('nav-hamburger').classList.remove('open');
    document.getElementById('nav-links').classList.remove('mobile-open');
  });
});


// ── FAQ ACCORDION ──────────────────────────────────────────────────────────

function toggleFaq(item) {
  const isOpen = item.classList.contains('open');
  document.querySelectorAll('.faq-item.open').forEach(el => el.classList.remove('open'));
  if (!isOpen) item.classList.add('open');
}


// ── CLICK-TO-COPY KEY VALUE ────────────────────────────────────────────────

document.addEventListener('click', e => {
  const el = e.target.closest('.profile-key-value');
  if (!el) return;
  const text = el.textContent.trim();
  if (!text || text === 'Exon External License') return;
  navigator.clipboard.writeText(text).then(() => {
    const orig = el.textContent;
    el.textContent = 'Copied!';
    el.style.color = '#4ade80';
    setTimeout(() => { el.textContent = orig; el.style.color = ''; }, 1500);
  });
});

// ── STATUS BANNER ──────────────────────────────────────────────────────────────

async function loadStatusBanner() {
  try {
    const r = await fetch('/api/status');
    if (!r.ok) return;
    const s = await r.json();
    const banner = document.getElementById('status-banner');
    if (!banner) return;
    if (!s.online) {
      banner.className = 'status-banner offline';
      document.getElementById('status-banner-text').textContent =
        s.message ? `Loader Offline — ${s.message}` : 'Loader is currently offline';
    } else if (s.message) {
      banner.className = 'status-banner maintenance';
      document.getElementById('status-banner-text').textContent = s.message;
    } else {
      banner.className = 'status-banner'; // hidden
    }
  } catch {}
}

loadStatusBanner();

// Also show announcements on dashboard if present
async function loadAnnouncements() {
  try {
    const r = await fetch('/api/announcements');
    if (!r.ok) return;
    const list = await r.json();
    const el = document.getElementById('announce-feed');
    if (!el || !list.length) return;
    el.innerHTML = list.slice(0, 5).map(a => `
      <div class="announce-card ${a.type ?? 'info'}">
        <div class="announce-title">${escHtml(a.title)}</div>
        <div class="announce-body">${escHtml(a.body)}</div>
        <div class="announce-meta">${timeAgo(a.created_at)}</div>
      </div>`).join('');
    el.style.display = 'flex';
  } catch {}
}

function timeAgo(ts) {
  const d = Date.now() - ts;
  if (d < 60000)   return 'just now';
  if (d < 3600000) return Math.floor(d/60000) + 'm ago';
  if (d < 86400000) return Math.floor(d/3600000) + 'h ago';
  return Math.floor(d/86400000) + 'd ago';
}

// ── ADMIN CONTROLS PANEL ──────────────────────────────────────────────────────

let _actrlTab = 'announcements';

function actrlOpen() {
  document.getElementById('admin-ctrl').style.display = 'flex';
  actrlTab('announcements', document.querySelector('.actrl-tab'));
}

function actrlClose() {
  document.getElementById('admin-ctrl').style.display = 'none';
}

function actrlTab(tab, btn) {
  _actrlTab = tab;
  document.querySelectorAll('.actrl-tab').forEach(t => t.classList.remove('active'));
  if (btn) btn.classList.add('active');
  const body = document.getElementById('actrl-body');
  body.innerHTML = '<div class="adash-loading">Loading…</div>';
  if (tab === 'announcements') renderActrlAnnouncements();
  else if (tab === 'status')   renderActrlStatus();
  else if (tab === 'coupons')  renderActrlCoupons();
  else if (tab === 'bulk')     renderActrlBulk();
}

// ── Announcements tab ──────────────────────────────────────────────────────────

async function renderActrlAnnouncements() {
  const token = localStorage.getItem('exon_token');
  const list  = await fetch('/api/announcements').then(r => r.json()).catch(() => []);
  const body  = document.getElementById('actrl-body');
  body.innerHTML = `
    <div class="actrl-section-title">Post Announcement</div>
    <div class="actrl-card">
      <div>
        <div class="actrl-label">Title</div>
        <input class="actrl-input" id="an-title" placeholder="e.g. Maintenance tonight" maxlength="100">
      </div>
      <div>
        <div class="actrl-label">Type</div>
        <select class="actrl-select" id="an-type">
          <option value="info">Info</option>
          <option value="update">Update</option>
          <option value="warning">Warning</option>
          <option value="downtime">Downtime</option>
          <option value="promo">Promo</option>
        </select>
      </div>
      <div>
        <div class="actrl-label">Body</div>
        <textarea class="actrl-textarea" id="an-body" maxlength="500" placeholder="Announcement details…"></textarea>
      </div>
      <button class="actrl-btn primary" onclick="postAnnouncement()">Post Announcement</button>
      <div id="an-result" style="font-size:.8rem;color:#10b981;display:none">Posted!</div>
    </div>
    <div class="actrl-section-title">Recent (${list.length})</div>
    <div id="an-list">
      ${!list.length ? '<div class="actrl-empty">No announcements yet</div>' :
        list.map(a => `
          <div class="actrl-announce-item">
            <div class="actrl-announce-text">
              <strong>${escHtml(a.title)}</strong>
              <span>${escHtml(a.body.slice(0,80))}${a.body.length>80?'…':''} · ${timeAgo(a.created_at)}</span>
            </div>
            <button class="actrl-btn danger" onclick="deleteAnnouncement('${a.id}')">Delete</button>
          </div>`).join('')}
    </div>`;
}

async function postAnnouncement() {
  const token = localStorage.getItem('exon_token');
  const title = document.getElementById('an-title').value.trim();
  const body2 = document.getElementById('an-body').value.trim();
  const type  = document.getElementById('an-type').value;
  if (!title || !body2) return alert('Title and body required');
  const r = await fetch('/api/admin/announcements', {
    method: 'POST', headers: { 'Content-Type':'application/json', Authorization:`Bearer ${token}` },
    body: JSON.stringify({ title, body: body2, type }),
  });
  if (!r.ok) return alert('Failed: ' + (await r.json()).error);
  const res = document.getElementById('an-result');
  res.style.display = 'block';
  setTimeout(() => { res.style.display='none'; actrlTab('announcements', null); }, 1200);
}

async function deleteAnnouncement(id) {
  if (!confirm('Delete this announcement?')) return;
  const token = localStorage.getItem('exon_token');
  await fetch(`/api/admin/announcements/${id}`, { method:'DELETE', headers:{ Authorization:`Bearer ${token}` }});
  actrlTab('announcements', null);
}

// ── Status tab ────────────────────────────────────────────────────────────────

async function renderActrlStatus() {
  const r = await fetch('/api/status');
  const s = r.ok ? await r.json() : { online: true, message: '' };
  const body = document.getElementById('actrl-body');
  body.innerHTML = `
    <div class="actrl-section-title">Loader Status</div>
    <div class="actrl-status-toggle">
      <div class="actrl-toggle-track ${s.online ? 'on' : ''}" id="status-toggle" onclick="statusToggleClick()">
        <div class="actrl-toggle-thumb"></div>
      </div>
      <div>
        <div style="font-size:.88rem;font-weight:600;color:#eef0f6" id="status-toggle-label">${s.online ? 'Online' : 'Offline'}</div>
        <div style="font-size:.75rem;color:#7a8394">Toggle loader availability</div>
      </div>
    </div>
    <div class="actrl-card">
      <div class="actrl-label">Status Message (optional — shown in banner)</div>
      <input class="actrl-input" id="status-msg" value="${escHtml(s.message ?? '')}" placeholder="e.g. Undergoing maintenance until 8pm EST" maxlength="200">
      <button class="actrl-btn primary" onclick="saveStatus()">Save</button>
      <div id="status-result" style="font-size:.8rem;color:#10b981;display:none">Saved!</div>
    </div>`;
  window._statusOnline = s.online;
}

function statusToggleClick() {
  window._statusOnline = !window._statusOnline;
  const t = document.getElementById('status-toggle');
  const l = document.getElementById('status-toggle-label');
  t.className = 'actrl-toggle-track' + (window._statusOnline ? ' on' : '');
  l.textContent = window._statusOnline ? 'Online' : 'Offline';
}

async function saveStatus() {
  const token = localStorage.getItem('exon_token');
  const msg   = document.getElementById('status-msg').value.trim();
  const r = await fetch('/api/admin/status', {
    method: 'POST', headers: { 'Content-Type':'application/json', Authorization:`Bearer ${token}` },
    body: JSON.stringify({ online: window._statusOnline, message: msg }),
  });
  if (!r.ok) return alert('Failed');
  document.getElementById('status-result').style.display = 'block';
  setTimeout(() => { document.getElementById('status-result').style.display='none'; loadStatusBanner(); }, 1500);
}

// ── Coupons tab ───────────────────────────────────────────────────────────────

async function renderActrlCoupons() {
  const token = localStorage.getItem('exon_token');
  const body  = document.getElementById('actrl-body');
  let coupons = [], promos = [];
  try {
    const cr = await fetch('/api/admin/coupons', { headers:{ Authorization:`Bearer ${token}` }});
    if (cr.ok) { const d = await cr.json(); coupons = d.coupons; promos = d.promo_codes; }
  } catch {}

  const promoByName = {};
  promos.forEach(p => { promoByName[p.coupon.id] = p.code; });

  body.innerHTML = `
    <div class="actrl-section-title">Create Coupon</div>
    <div class="actrl-card">
      <div>
        <div class="actrl-label">Code / Name (no spaces)</div>
        <input class="actrl-input" id="cp-name" placeholder="e.g. LAUNCH20" maxlength="20">
      </div>
      <div class="actrl-row">
        <div style="flex:1">
          <div class="actrl-label">% Off</div>
          <input class="actrl-input" id="cp-pct" type="number" min="1" max="100" placeholder="20">
        </div>
        <div style="align-self:center;color:#7a8394;font-size:.82rem;flex-shrink:0">OR</div>
        <div style="flex:1">
          <div class="actrl-label">$ Off</div>
          <input class="actrl-input" id="cp-amt" type="number" min="0.01" step="0.01" placeholder="5.00">
        </div>
      </div>
      <div class="actrl-row">
        <div style="flex:1">
          <div class="actrl-label">Max Redemptions (blank = unlimited)</div>
          <input class="actrl-input" id="cp-max" type="number" min="1" placeholder="">
        </div>
        <div style="flex:1">
          <div class="actrl-label">Duration</div>
          <select class="actrl-select" id="cp-dur">
            <option value="once">Once</option>
            <option value="forever">Forever</option>
          </select>
        </div>
      </div>
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:.82rem;color:#a0a8bc;margin-top:2px">
        <input type="checkbox" id="cp-first" style="width:14px;height:14px;accent-color:#f07a12;flex-shrink:0">
        First purchase only <span style="font-size:.72rem;color:#5a6478">(Stripe restricts to new customers)</span>
      </label>
      <button class="actrl-btn primary" onclick="createCoupon()">Create Coupon</button>
      <div id="cp-result" style="font-size:.8rem;display:none"></div>
    </div>
    <div class="actrl-section-title">Active Coupons (${coupons.length})</div>
    ${!coupons.length ? '<div class="actrl-empty">No coupons yet</div>' :
      coupons.map(c => {
        const discount = c.percent_off ? `${c.percent_off}% off` : `$${(c.amount_off/100).toFixed(2)} off`;
        const code = promoByName[c.id] ?? '—';
        const redeemed = c.times_redeemed ?? 0;
        const max = c.max_redemptions ?? '∞';
        const promo = promos.find(p => p.coupon.id === c.id);
        const firstOnly = promo?.restrictions?.first_time_transaction ? ' · 🆕 first purchase only' : '';
        return `<div class="actrl-coupon-row">
          <div>
            <div class="actrl-coupon-code">${escHtml(code)}</div>
            <div class="actrl-coupon-info">${discount} · ${redeemed}/${max} used · ${c.duration}${firstOnly}</div>
          </div>
          <button class="actrl-btn danger" onclick="deleteCoupon('${c.id}')">Delete</button>
        </div>`;
      }).join('')}`;
}

async function createCoupon() {
  const token = localStorage.getItem('exon_token');
  const name  = document.getElementById('cp-name').value.trim().toUpperCase().replace(/[^A-Z0-9]/g,'');
  const pct   = document.getElementById('cp-pct').value;
  const amt   = document.getElementById('cp-amt').value;
  const max   = document.getElementById('cp-max').value;
  const dur   = document.getElementById('cp-dur').value;
  if (!name) return alert('Code required');
  if (!pct && !amt) return alert('Enter % off or $ off');
  const res = document.getElementById('cp-result');
  const firstOnly = document.getElementById('cp-first').checked;
  const r = await fetch('/api/admin/coupons', {
    method: 'POST', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${token}` },
    body: JSON.stringify({ name, ...(pct ? {percent_off:parseFloat(pct)} : {amount_off:parseFloat(amt)}), max_redemptions:max||undefined, duration:dur, first_time_only:firstOnly }),
  });
  const d = await r.json();
  if (!r.ok) { res.style.cssText='display:block;color:#ef4444'; res.textContent='Error: '+d.error; return; }
  res.style.cssText='display:block;color:#10b981';
  res.textContent = `Created! Code: ${d.promo_code}`;
  setTimeout(() => renderActrlCoupons(), 2000);
}

async function deleteCoupon(id) {
  if (!confirm('Delete this coupon? This cannot be undone.')) return;
  const token = localStorage.getItem('exon_token');
  await fetch(`/api/admin/coupons/${id}`, { method:'DELETE', headers:{ Authorization:`Bearer ${token}` }});
  renderActrlCoupons();
}

// ── Bulk keys tab ─────────────────────────────────────────────────────────────

function renderActrlBulk() {
  const body = document.getElementById('actrl-body');
  body.innerHTML = `
    <div class="actrl-section-title">Bulk Generate Keys</div>
    <div class="actrl-card">
      <div>
        <div class="actrl-label">Plan Name</div>
        <input class="actrl-input" id="bk-plan" placeholder="e.g. 1 Month">
      </div>
      <div>
        <div class="actrl-label">Duration</div>
        <select class="actrl-select" id="bk-dur" onchange="bkDurChange(this)">
          <option value="1">1 Day</option>
          <option value="7">1 Week</option>
          <option value="30" selected>1 Month</option>
          <option value="90">3 Months</option>
          <option value="lifetime">Lifetime ∞</option>
          <option value="custom">Custom…</option>
        </select>
        <input class="actrl-input" id="bk-days" type="number" min="1" placeholder="Days" style="display:none;margin-top:6px">
      </div>
      <div>
        <div class="actrl-label">Count (1–100)</div>
        <input class="actrl-input" id="bk-count" type="number" min="1" max="100" value="10">
      </div>
      <button class="actrl-btn primary" onclick="bulkGenerate()">Generate Keys</button>
      <div id="bk-result" style="display:none">
        <div style="font-size:.78rem;color:#7a8394;margin-bottom:6px">Generated keys (click to download .txt):</div>
        <button class="actrl-btn" id="bk-dl-btn" onclick="bulkDownload()">⬇ Download .txt</button>
        <div id="bk-preview" style="font-size:.7rem;font-family:monospace;color:#a0a8bc;margin-top:8px;max-height:120px;overflow-y:auto;line-height:1.7"></div>
      </div>
    </div>`;
  window._bkKeys = [];
}

function bkDurChange(sel) {
  document.getElementById('bk-days').style.display = sel.value === 'custom' ? 'block' : 'none';
}

async function bulkGenerate() {
  const token    = localStorage.getItem('exon_token');
  const plan     = document.getElementById('bk-plan').value.trim();
  const durVal   = document.getElementById('bk-dur').value;
  const lifetime = durVal === 'lifetime';
  const days     = durVal === 'custom' ? document.getElementById('bk-days').value : (lifetime ? null : durVal);
  const count    = parseInt(document.getElementById('bk-count').value) || 10;
  if (!plan) return alert('Plan name required');
  const r = await fetch('/api/admin/keys/bulk-generate', {
    method:'POST', headers:{'Content-Type':'application/json', Authorization:`Bearer ${token}`},
    body: JSON.stringify({ plan, days, lifetime, count }),
  });
  if (!r.ok) return alert('Error: ' + (await r.json()).error);
  const d = await r.json();
  window._bkKeys = d.keys;
  document.getElementById('bk-result').style.display = 'block';
  document.getElementById('bk-preview').innerHTML = d.keys.map(k => `<div>${k}</div>`).join('');
}

function bulkDownload() {
  const keys = window._bkKeys ?? [];
  if (!keys.length) return;
  const plan  = document.getElementById('bk-plan').value.trim() || 'keys';
  const blob  = new Blob([keys.join('\n')], { type: 'text/plain' });
  const url   = URL.createObjectURL(blob);
  const a     = document.createElement('a');
  a.href = url; a.download = `exon-${plan.replace(/\s+/g,'-').toLowerCase()}-${Date.now()}.txt`;
  a.click(); URL.revokeObjectURL(url);
}

// ── Bulk generate (Key Dashboard modal) ──────────────────────────────────────

function adashOpenBulkModal() {
  window._adashBulkKeys = [];
  document.getElementById('adash-bulk-result').style.display = 'none';
  document.getElementById('adash-bulk-preview').innerHTML = '';
  document.getElementById('adash-bulk-plan').value = '';
  document.getElementById('adash-bulk-count').value = '10';
  document.getElementById('adash-bulk-duration').value = '30';
  document.getElementById('adash-bulk-days').style.display = 'none';
  document.getElementById('adash-bulk-modal').style.display = 'flex';
}

function adashBulkCancel() {
  document.getElementById('adash-bulk-modal').style.display = 'none';
}

function adashBulkDurChange(sel) {
  document.getElementById('adash-bulk-days').style.display = sel.value === 'custom' ? 'block' : 'none';
}

async function adashBulkSubmit() {
  const token    = localStorage.getItem('exon_token');
  const plan     = document.getElementById('adash-bulk-plan').value.trim();
  const durVal   = document.getElementById('adash-bulk-duration').value;
  const lifetime = durVal === 'lifetime';
  const days     = durVal === 'custom' ? document.getElementById('adash-bulk-days').value : (lifetime ? null : durVal);
  const count    = parseInt(document.getElementById('adash-bulk-count').value) || 10;
  if (!plan) return alert('Plan name required');
  const r = await fetch('/api/admin/keys/bulk-generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ plan, days, lifetime, count }),
  });
  if (!r.ok) return alert('Error: ' + (await r.json()).error);
  const d = await r.json();
  window._adashBulkKeys = d.keys;
  document.getElementById('adash-bulk-result').style.display = 'block';
  document.getElementById('adash-bulk-preview').innerHTML = d.keys.map(k => `<div>${k}</div>`).join('');
  adashLoad();
}

function adashBulkDownload() {
  const keys = window._adashBulkKeys ?? [];
  if (!keys.length) return;
  const plan = document.getElementById('adash-bulk-plan').value.trim() || 'keys';
  const blob = new Blob([keys.join('\n')], { type: 'text/plain' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `exon-${plan.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}.txt`;
  a.click(); URL.revokeObjectURL(url);
}

// ── Show admin controls button when admin ─────────────────────────────────────
function showAdminControlsBtn(role) {
  const btn = document.getElementById('pc-actrl-btn');
  if (btn && ['staff','developer'].includes(role)) btn.style.display = 'flex';
}


// ── ADMIN KEY DASHBOARD ────────────────────────────────────────────────────

let _adashPage  = 1;
let _adashTotal = 0;
let _adashQ     = '';
let _adashTimer = null;
let _adashTimeKey = null;
const ADASH_LIMIT = 50;

function adashOpen() {
  document.getElementById('admin-dash').style.display = 'flex';
  document.getElementById('profile-card-overlay').classList.remove('open');
  _adashPage = 1;
  _adashQ    = '';
  document.getElementById('adash-search').value = '';
  adashLoad();
}

function adashClose() {
  document.getElementById('admin-dash').style.display = 'none';
}

function adashSearch() {
  clearTimeout(_adashTimer);
  _adashTimer = setTimeout(() => {
    _adashQ    = document.getElementById('adash-search').value.trim();
    _adashPage = 1;
    adashLoad();
  }, 300);
}

function adashPage(dir) {
  const totalPages = Math.max(1, Math.ceil(_adashTotal / ADASH_LIMIT));
  _adashPage = Math.max(1, Math.min(totalPages, _adashPage + dir));
  adashLoad();
}

async function adashLoad() {
  const tbody = document.getElementById('adash-tbody');
  tbody.innerHTML = '<tr><td colspan="7" class="adash-loading">Loading…</td></tr>';
  const token  = localStorage.getItem('exon_token');
  const params = new URLSearchParams({ q: _adashQ, page: _adashPage, limit: ADASH_LIMIT });
  try {
    const res  = await fetch(`/api/admin/keys?${params}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 403) { adashClose(); return; }
    const data = await res.json();
    _adashTotal = data.total;
    const ucEl = document.getElementById('adash-user-count');
    if (ucEl && data.user_count !== undefined) ucEl.textContent = `${data.user_count} user${data.user_count !== 1 ? 's' : ''}`;
    adashRender(data.keys, data.total);
  } catch {
    tbody.innerHTML = '<tr><td colspan="7" class="adash-loading">Failed to load.</td></tr>';
  }
}

function adashRender(keys, total) {
  const tbody      = document.getElementById('adash-tbody');
  const totalPages = Math.max(1, Math.ceil(total / ADASH_LIMIT));
  document.getElementById('adash-count').textContent     = `${total} key${total !== 1 ? 's' : ''}`;
  document.getElementById('adash-page-info').textContent = `Page ${_adashPage} of ${totalPages}`;
  document.getElementById('adash-prev').disabled         = _adashPage <= 1;
  document.getElementById('adash-next').disabled         = _adashPage >= totalPages;

  if (!keys.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="adash-loading">No keys found.</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  keys.forEach(k => {
    const tr = document.createElement('tr');

    // Status
    let status = 'unlinked', statusLabel = 'Unlinked';
    if (k.banned)         { status = 'banned';   statusLabel = 'Banned';   }
    else if (!k.discord_id) { status = 'unlinked'; statusLabel = 'Unlinked'; }
    else if (k.time_created) {
      const expired = k.expires_at && Date.now() > k.expires_at;
      status      = expired ? 'expired' : 'active';
      statusLabel = expired ? 'Expired' : 'Active';
    } else { status = 'queued'; statusLabel = 'Queued'; }

    // Expires column
    let expiresStr = '—';
    if (isLifetime(k.length_min)) expiresStr = '<span style="color:#10b981">Lifetime ∞</span>';
    else if (k.expires_at && Date.now() < k.expires_at) expiresStr = formatTimeLeft(k.expires_at);
    else if (k.expires_at)  expiresStr = 'Expired';
    else if (k.length_min && !k.time_created) expiresStr = formatMinutes(k.length_min) + ' total';

    const userHtml = (k.username && k.discord_id)
      ? `<span class="adash-user-link" onclick="adashOpenUser('${escHtml(k.discord_id)}')">${escHtml(k.username)}</span>`
      : '<span style="color:#404858">—</span>';

    const hwidHtml = k.hwid
      ? `<span title="${escHtml(k.hwid)}" style="font-family:monospace;font-size:.72rem;color:#7a8394">${k.hwid.slice(0,8)}…</span>`
      : '<span style="color:#404858">—</span>';

    const kv = escHtml(k.key_value);

    tr.innerHTML = `
      <td><span class="adash-key-val" onclick="adashCopy(this,'${kv}')" title="${kv}">${kv}</span></td>
      <td style="color:#7a8394">${escHtml(k.plan ?? '—')}</td>
      <td>${userHtml}</td>
      <td><span class="adash-badge ${status}">${statusLabel}</span></td>
      <td style="color:#7a8394;font-size:.78rem">${expiresStr}</td>
      <td>${hwidHtml}</td>
      <td>
        <div class="adash-actions-cell">
          <button class="adash-action-btn warn"   onclick="adashOpenTime('${kv}')">+Time</button>
          <button class="adash-action-btn"        onclick="adashResetHwid('${kv}')">↺ HWID</button>
          <button class="adash-action-btn danger" onclick="adashDelete('${kv}')">Delete</button>
        </div>
      </td>`;
    tbody.appendChild(tr);
  });
}

function adashCopy(el, key) {
  navigator.clipboard.writeText(key).then(() => {
    const orig = el.textContent;
    el.textContent = 'Copied!';
    el.style.color = '#4ade80';
    setTimeout(() => { el.textContent = orig; el.style.color = ''; }, 1500);
  });
}

// ── USER PROFILE PANEL ─────────────────────────────────────────────────────

let _adashCurrentUser = null;

async function adashOpenUser(discordId) {
  _adashCurrentUser = discordId;
  const panel = document.getElementById('adash-user-panel');
  const body  = document.getElementById('adash-up-body');
  panel.style.display = 'flex';
  body.innerHTML = '<div class="adash-loading">Loading user…</div>';

  const token = localStorage.getItem('exon_token');
  try {
    const res  = await fetch(`/api/admin/users/${encodeURIComponent(discordId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const user = await res.json();
    if (!res.ok) { body.innerHTML = `<div class="adash-loading">${escHtml(user.error)}</div>`; return; }
    adashRenderUser(user);
  } catch {
    body.innerHTML = '<div class="adash-loading">Failed to load user.</div>';
  }
}

function adashCloseUser() {
  document.getElementById('adash-user-panel').style.display = 'none';
  _adashCurrentUser = null;
}

function adashRenderUser(user) {
  const body     = document.getElementById('adash-up-body');
  const isBanned = user.banned ?? false;
  const joinedAt = user.created_at ? new Date(user.created_at * 1000).toLocaleDateString() : '—';

  // Key stats
  const totalKeys   = user.keys.length;
  const activeKeys  = user.keys.filter(k => k.time_created && k.expires_at && Date.now() < k.expires_at).length;
  const expiredKeys = user.keys.filter(k => k.expires_at && Date.now() > k.expires_at).length;

  // Combined time remaining
  let combinedMs = 0;
  user.keys.forEach(k => {
    if (k.time_created && k.length_min) {
      const rem = (k.time_created + k.length_min * 60000) - Date.now();
      if (rem > 0) combinedMs += rem;
    } else if (k.length_min && !k.time_created) {
      combinedMs += k.length_min * 60000;
    }
  });
  const combinedStr = combinedMs > 0 ? formatTimeLeft(Date.now() + combinedMs) : '—';

  const keysHtml = user.keys.length ? user.keys.map(k => {
    let status = 'queued', statusLabel = 'Queued';
    if (k.time_created) {
      const expired = k.expires_at && Date.now() > k.expires_at;
      status = expired ? 'expired' : 'active';
      statusLabel = expired ? 'Expired' : 'Active';
    }
    let expiresStr = '—';
    if (k.expires_at && Date.now() < k.expires_at) expiresStr = formatTimeLeft(k.expires_at);
    else if (k.expires_at) expiresStr = 'Expired';
    else if (k.length_min && !k.time_created) expiresStr = formatMinutes(k.length_min) + ' total';

    const purchStr  = k.purchased_at ? new Date(k.purchased_at).toLocaleDateString() : '—';
    const activatedStr = k.time_created ? new Date(k.time_created).toLocaleDateString() : '—';
    const hwidShort = k.hwid ? k.hwid.slice(0, 16) + '…' : '—';
    const kv = escHtml(k.key_value);

    return `<tr>
      <td><span class="adash-key-val" onclick="adashCopy(this,'${kv}')" title="${kv}">${kv}</span></td>
      <td style="color:#7a8394">${escHtml(k.plan)}</td>
      <td><span class="adash-badge ${status}">${statusLabel}</span></td>
      <td style="color:#7a8394;font-size:.78rem">${expiresStr}</td>
      <td style="color:#7a8394;font-size:.78rem">${purchStr}</td>
      <td style="color:#7a8394;font-size:.78rem">${activatedStr}</td>
      <td style="font-family:monospace;font-size:.71rem;color:#404858;max-width:130px;overflow:hidden;text-overflow:ellipsis" title="${escHtml(k.hwid ?? '')}">${escHtml(hwidShort)}</td>
      <td>
        <div class="adash-actions-cell">
          <button class="adash-action-btn warn"   onclick="adashOpenTime('${kv}')">+Time</button>
          <button class="adash-action-btn"        onclick="adashUserResetHwid('${kv}',this)">↺ HWID</button>
          <button class="adash-action-btn danger" onclick="adashUserDeleteKey('${kv}',this)">Delete</button>
        </div>
      </td>
    </tr>`;
  }).join('') : `<tr><td colspan="8" class="adash-loading" style="padding:20px">No keys linked.</td></tr>`;

  body.innerHTML = `
    <div class="adash-up-card">
      <div class="adash-up-identity">
        ${user.avatar ? `<img src="${escHtml(user.avatar)}" class="adash-up-avatar" alt="">` : '<div class="adash-up-avatar-ph"></div>'}
        <div>
          <div class="adash-up-name">${escHtml(user.username)}</div>
          <div class="adash-up-meta">
            <span class="adash-badge ${user.role ?? 'member'}" style="font-size:.65rem">${escHtml(ROLE_LABELS[user.role] ?? user.role ?? 'Member')}</span>
            <span class="adash-badge ${isBanned ? 'banned' : 'active'}" style="font-size:.65rem">${isBanned ? 'Banned' : 'Active'}</span>
            <span style="color:#404858;font-size:.74rem;font-family:monospace">${escHtml(user.discord_id)}</span>
            <span style="color:#404858;font-size:.74rem">Joined ${joinedAt}</span>
          </div>
        </div>
      </div>
      <div class="adash-up-actions">
        <select class="adash-role-select" onchange="adashSetRole('${escHtml(user.discord_id)}',this.value,this)" title="Override role">
          ${['member','customer','vip','staff','developer'].map(r =>
            `<option value="${r}" ${user.role===r?'selected':''}>${escHtml(ROLE_LABELS[r]??r)}</option>`
          ).join('')}
        </select>
        <button class="adash-up-ban-btn ${isBanned ? 'unbanning' : ''}" onclick="adashBanUser('${escHtml(user.discord_id)}',${isBanned})">
          ${isBanned ? '✓ Unban User' : '🚫 Ban User'}
        </button>
      </div>
    </div>

    <div class="adash-up-stats">
      <div class="adash-up-stat"><div class="adash-up-stat-label">Total Keys</div><div class="adash-up-stat-value">${totalKeys}</div></div>
      <div class="adash-up-stat"><div class="adash-up-stat-label">Active</div><div class="adash-up-stat-value" style="color:#10b981">${activeKeys}</div></div>
      <div class="adash-up-stat"><div class="adash-up-stat-label">Expired</div><div class="adash-up-stat-value" style="color:#ef4444">${expiredKeys}</div></div>
      <div class="adash-up-stat"><div class="adash-up-stat-label">Time Left</div><div class="adash-up-stat-value" style="color:#f07a12">${combinedStr}</div></div>
      <div class="adash-up-stat"><div class="adash-up-stat-label">Role</div><div class="adash-up-stat-value">${escHtml(ROLE_LABELS[user.role] ?? user.role ?? 'Member')}</div></div>
    </div>

    <div class="adash-up-keys-label">Keys (${totalKeys})</div>
    <div class="adash-table-wrap" style="border:1px solid rgba(255,255,255,.07);border-radius:10px;overflow:hidden;flex:none">
      <table class="adash-table">
        <thead>
          <tr>
            <th>Key</th><th>Plan</th><th>Status</th><th>Expires / Duration</th>
            <th>Purchased</th><th>Activated</th><th>HWID</th><th>Actions</th>
          </tr>
        </thead>
        <tbody>${keysHtml}</tbody>
      </table>
    </div>`;
}

async function adashSetRole(discordId, role, selectEl) {
  if (!confirm(`Set role to "${ROLE_LABELS[role] ?? role}" for this user? This will update Discord roles.`)) {
    // Revert select
    adashOpenUser(discordId); return;
  }
  selectEl.disabled = true;
  const token = localStorage.getItem('exon_token');
  const res = await fetch(`/api/admin/users/${encodeURIComponent(discordId)}/role`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ role }),
  });
  if (!res.ok) { alert('Failed to set role.'); }
  adashOpenUser(discordId);
}

async function adashBanUser(discordId, isBanned) {
  const token = localStorage.getItem('exon_token');
  await fetch(`/api/admin/users/${encodeURIComponent(discordId)}/ban`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ banned: !isBanned }),
  });
  adashOpenUser(discordId);
}

async function adashUserResetHwid(key, btn) {
  if (!confirm(`Reset HWID for ${key}?`)) return;
  btn.disabled = true; btn.textContent = '…';
  const token = localStorage.getItem('exon_token');
  await fetch(`/api/admin/keys/${encodeURIComponent(key)}/reset-hwid`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  });
  if (_adashCurrentUser) adashOpenUser(_adashCurrentUser);
}

async function adashUserDeleteKey(key, btn) {
  if (!confirm(`Permanently delete ${key}?`)) return;
  btn.disabled = true;
  const token = localStorage.getItem('exon_token');
  await fetch(`/api/admin/keys/${encodeURIComponent(key)}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
  });
  if (_adashCurrentUser) adashOpenUser(_adashCurrentUser);
}

async function adashResetHwid(key) {
  if (!confirm(`Reset HWID for ${key}?`)) return;
  const token = localStorage.getItem('exon_token');
  await fetch(`/api/admin/keys/${encodeURIComponent(key)}/reset-hwid`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  });
  adashLoad();
}

async function adashDelete(key) {
  if (!confirm(`Permanently delete ${key}? This cannot be undone.`)) return;
  const token = localStorage.getItem('exon_token');
  await fetch(`/api/admin/keys/${encodeURIComponent(key)}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
  });
  adashLoad();
}

function adashOpenGenModal() {
  document.getElementById('adash-gen-plan').value           = '';
  document.getElementById('adash-gen-duration').value       = '30';
  document.getElementById('adash-gen-days').value           = '';
  document.getElementById('adash-gen-days').style.display   = 'none';
  document.getElementById('adash-gen-result').style.display = 'none';
  document.getElementById('adash-gen-result').textContent   = '';
  document.getElementById('adash-gen-modal').style.display  = 'flex';
}

function adashDurationChange(sel) {
  const customInput = document.getElementById('adash-gen-days');
  customInput.style.display = sel.value === 'custom' ? '' : 'none';
  if (sel.value === 'custom') { customInput.value = ''; customInput.focus(); }
}

function adashGenCancel() { document.getElementById('adash-gen-modal').style.display = 'none'; }

async function adashGenSubmit() {
  const plan     = document.getElementById('adash-gen-plan').value.trim();
  const durVal   = document.getElementById('adash-gen-duration').value;
  const lifetime = durVal === 'lifetime';
  let days;
  if (lifetime) {
    days = null;
  } else if (durVal === 'custom') {
    days = parseFloat(document.getElementById('adash-gen-days').value);
    if (!days || days < 1) { alert('Enter a valid number of days.'); return; }
  } else {
    days = parseFloat(durVal);
  }
  if (!plan) { alert('Enter a plan name.'); return; }
  const token = localStorage.getItem('exon_token');
  const res   = await fetch('/api/admin/keys/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ plan, days, lifetime }),
  });
  const data = await res.json();
  if (res.ok) {
    const el = document.getElementById('adash-gen-result');
    el.textContent   = data.key;
    el.style.display = '';
    navigator.clipboard.writeText(data.key).catch(() => {});
    adashLoad();
  }
}

function adashOpenTime(key) {
  _adashTimeKey = key;
  document.getElementById('adash-time-key').textContent  = key;
  document.getElementById('adash-time-days').value       = '7';
  document.getElementById('adash-time-modal').style.display = 'flex';
}

function adashTimeCancel() {
  document.getElementById('adash-time-modal').style.display = 'none';
  _adashTimeKey = null;
}

async function adashTimeSubmit() {
  const days = parseFloat(document.getElementById('adash-time-days').value);
  if (!days || !_adashTimeKey) return;
  const token = localStorage.getItem('exon_token');
  await fetch(`/api/admin/keys/${encodeURIComponent(_adashTimeKey)}/add-time`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ minutes: Math.round(days * 1440) }),
  });
  document.getElementById('adash-time-modal').style.display = 'none';
  _adashTimeKey = null;
  adashLoad();
}

function escHtml(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (document.getElementById('adash-time-modal').style.display  !== 'none') { adashTimeCancel();  return; }
  if (document.getElementById('adash-gen-modal').style.display   !== 'none') { adashGenCancel();   return; }
  if (document.getElementById('adash-user-panel').style.display  !== 'none') { adashCloseUser();   return; }
  if (document.getElementById('admin-dash').style.display        !== 'none') { adashClose();       return; }
});


// ── NOTIFICATIONS ──────────────────────────────────────────────────────────

let _notifOpen = false;

async function loadNotifications() {
  const token = localStorage.getItem('exon_token');
  if (!token) return;
  try {
    const res  = await fetch('/api/notifications', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return;
    const data = await res.json();
    renderNotifications(data.notifications ?? []);
    const unread = data.unread_count ?? 0;
    const badge = document.getElementById('nav-bell-badge');
    if (badge) badge.classList.toggle('has-unread', unread > 0);
    // Update page title with unread count
    const base = document.title.replace(/^\(\d+\)\s*/, '');
    document.title = unread > 0 ? `(${unread}) ${base}` : base;
  } catch {}
}

function renderNotifications(notifications) {
  const list = document.getElementById('notif-list');
  if (!list) return;
  if (!notifications.length) {
    list.innerHTML = '<div class="notif-empty">No notifications yet.</div>';
    return;
  }
  list.innerHTML = notifications.map(n => {
    const timeAgo = formatRelativeTime(n.created_at);
    const profileUrl = `/u/${n.from_discord_id}`;
    let msg = '';
    if (n.type === 'follow') {
      msg = `<a href="${profileUrl}">${escHtml(n.from_display_name || n.from_username)}</a> followed you!`;
    } else {
      msg = escHtml(n.message ?? n.type);
    }
    return `<div class="notif-item ${n.read ? '' : 'unread'}" onclick="notifMarkOne('${n.id}',this)">
      <div class="notif-item-body">
        <div class="notif-item-msg">${msg}</div>
        <div class="notif-item-time">${timeAgo}</div>
      </div>
      ${!n.read ? '<div class="notif-unread-dot"></div>' : ''}
    </div>`;
  }).join('');
}

function notifToggle() {
  const panel = document.getElementById('notif-panel');
  _notifOpen  = !_notifOpen;
  panel.classList.toggle('open', _notifOpen);
  if (_notifOpen) loadNotifications();
}

async function notifMarkAll() {
  const token = localStorage.getItem('exon_token');
  if (!token) return;
  await fetch('/api/notifications/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({}),
  });
  loadNotifications();
}

async function notifMarkOne(id, el) {
  const token = localStorage.getItem('exon_token');
  if (!token) return;
  el.classList.remove('unread');
  el.querySelector('.notif-unread-dot')?.remove();
  await fetch('/api/notifications/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ id }),
  }).catch(() => {});
  const badge = document.getElementById('nav-bell-badge');
  if (badge && !document.querySelector('.notif-item.unread')) badge.classList.remove('has-unread');
}

// Close notification panel on outside click
document.addEventListener('click', e => {
  const wrap = document.querySelector('.nav-bell-wrap');
  if (wrap && !wrap.contains(e.target) && _notifOpen) {
    document.getElementById('notif-panel').classList.remove('open');
    _notifOpen = false;
  }
});

function formatRelativeTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000)       return 'just now';
  if (diff < 3600000)     return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000)    return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 2592000000)  return `${Math.floor(diff / 86400000)}d ago`;
  return new Date(ts).toLocaleDateString();
}


// ── NAV SEARCH ─────────────────────────────────────────────────────────────

let _searchTimer = null;
let _searchOpen  = false;

function navSearchToggle() {
  const input   = document.getElementById('nav-search-input');
  const results = document.getElementById('nav-search-results');
  _searchOpen   = !_searchOpen;
  input.classList.toggle('open', _searchOpen);
  if (_searchOpen) { setTimeout(() => input.focus(), 50); }
  else { results.classList.remove('open'); results.innerHTML = ''; input.value = ''; }
}

function navSearchInput() {
  clearTimeout(_searchTimer);
  const q = document.getElementById('nav-search-input').value.trim();
  if (q.length < 2) {
    document.getElementById('nav-search-results').classList.remove('open');
    return;
  }
  _searchTimer = setTimeout(() => navSearchFetch(q), 280);
}

async function navSearchFetch(q) {
  const results = document.getElementById('nav-search-results');
  try {
    const res  = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    const items = data.results ?? [];
    if (!items.length) {
      results.innerHTML = '<div class="nav-search-empty">No users found.</div>';
      results.classList.add('open');
      return;
    }
    results.innerHTML = items.map(u => {
      const badgeHtml = u.badges?.length
        ? `<span style="font-size:.65rem;color:#f07a12;margin-left:4px">${badgeLabel(u.badges[0])}</span>` : '';
      return `<a class="nav-search-result-item" href="/u/${escHtml(u.discord_id)}">
        ${u.avatar ? `<img src="${escHtml(u.avatar)}" class="nav-search-result-avatar" alt="">` : '<div class="nav-search-result-avatar"></div>'}
        <div class="nav-search-result-info">
          <div class="nav-search-result-name">${escHtml(u.display_name || u.username)}${badgeHtml}</div>
          <div class="nav-search-result-handle">@${escHtml(u.username)}</div>
        </div>
      </a>`;
    }).join('');
    results.classList.add('open');
  } catch {}
}

function navSearchBlur() {
  // small delay so clicks on results register
  setTimeout(() => {
    document.getElementById('nav-search-results').classList.remove('open');
  }, 200);
}

function badgeLabel(badge) {
  const labels = { early_supporter: '⭐ Early', '1_year_member': '🎂 1 Year',
                   verified: '✓ Verified', staff: '🛡 Staff', developer: '⚒ Dev',
                   vip: '👑 VIP', tester: '🧪 Beta', og: '🏆 OG' };
  return labels[badge] ?? badge;
}

// Close search on outside click
document.addEventListener('click', e => {
  const wrap = document.getElementById('nav-search-wrap');
  if (wrap && !wrap.contains(e.target) && _searchOpen) {
    navSearchToggle();
  }
});


// ── ONLINE PILL ────────────────────────────────────────────────────────────

async function updateOnlinePill() {
  try {
    const res  = await fetch('/api/stats/online');
    const data = await res.json();
    const pill  = document.getElementById('online-pill');
    const count = document.getElementById('online-pill-count');
    if (!pill || !count) return;
    count.textContent = data.online ?? 0;
    pill.style.display = 'flex';
  } catch {}
}

updateOnlinePill();
setInterval(updateOnlinePill, 30000);


// ── FEATURE TABS ───────────────────────────────────────────────────────────

document.querySelectorAll('.feat-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.feat-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.feat-panel').forEach(p => p.classList.remove('active'));

    tab.classList.add('active');
    const panel = document.getElementById('tab-' + tab.dataset.tab);
    if (!panel) return;
    panel.classList.add('active');

    // Re-run reveal on newly visible items
    panel.querySelectorAll('.feat-item').forEach(el => {
      el.classList.remove('active');
      // Small delay so the browser registers the class removal before re-observing
      requestAnimationFrame(() => observer.observe(el));
    });
  });
});
