// ── AUTH & PROFILE ─────────────────────────────────────────────────────────

const API = ''; // empty = same origin; set to 'https://your-server.com' if hosted separately

const ROLE_ORDER = ['member', 'customer', 'staff', 'developer'];
const ROLE_LABELS = { member: 'Member', customer: 'Customer', staff: 'Staff', developer: 'Developer' };

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
}

function renderProfileCard(user) {
  const card = document.getElementById('profile-card');
  card.dataset.role = user.role;

  document.getElementById('pc-avatar').src           = user.avatar ?? '';
  document.getElementById('pc-username').textContent = user.username;

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

  // Keys
  const keysEl = document.getElementById('pc-keys');
  keysEl.innerHTML = '';
  if (user.keys && user.keys.length > 0) {
    user.keys.forEach(k => {
      const div = document.createElement('div');
      div.className = 'profile-key-item';
      div.innerHTML = `
        <span class="profile-key-value">${k.key_value}</span>
        <span class="profile-key-plan">${k.plan ?? 'License'}</span>
      `;
      keysEl.appendChild(div);
    });
  } else {
    keysEl.innerHTML = '<div class="profile-no-keys">No keys linked yet.</div>';
  }
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

document.querySelectorAll('.card, .faq-item, .pricing-box, .feat-item').forEach(el => {
  el.classList.add('reveal');
  observer.observe(el);
});


// ── NAV SCROLL STATE ───────────────────────────────────────────────────────

const nav = document.getElementById('nav');
window.addEventListener('scroll', () => {
  nav.classList.toggle('scrolled', window.scrollY > 50);
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
