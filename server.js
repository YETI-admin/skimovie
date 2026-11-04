process.env.TZ = process.env.TZ || 'America/Los_Angeles';

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const Stripe = require('stripe');
const { openDb } = require('./lib/db');
const { chargeToRow, countRow, dollarsToCents } = require('./lib/classify');

// ---------- Config ----------
const env = process.env;
const PORT = env.PORT || 3000;
const DATA_DIR = env.DATA_DIR || path.join(__dirname, 'data');
const STRIPE_KEY = (env.STRIPE_SECRET_KEY || '').trim();
const WEBHOOK_SECRET = (env.STRIPE_WEBHOOK_SECRET || '').trim();
const ADMIN_PIN = env.ADMIN_PIN || '';
const SESSION_SECRET = env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const CAMPAIGN_SLUG = env.GIVELIVELY_CAMPAIGN_SLUG || 'powder-to-the-people-north-bend-ski-movie-night-fundraiser';
// Setting names are case-sensitive on Linux; accept e.g. "Admin_Names" too.
const envAnyCase = (name) => env[Object.keys(env).find((k) => k.toUpperCase() === name) || name];
const ADMIN_NAMES = (envAnyCase('ADMIN_NAMES') || '').split(',').map((s) => s.trim()).filter(Boolean);
const SYNC_EVERY_MS = 60 * 1000;

const stripe = new Stripe(STRIPE_KEY || 'rk_not_configured', { maxNetworkRetries: 2, timeout: 20000 });
const db = openDb(DATA_DIR);

// ---------- Settings (stored values win over env defaults) ----------
const DEFAULTS = {
  goal_cents: String(parseInt(env.GOAL_CENTS || '2000000', 10)),
  event_start: env.EVENT_START || '2026-11-12T12:00:00-08:00',
  adjust_cents: '0',
  adjust_note: '',
  offline_cents: '0',
  offline_updated_at: '',
  offline_updated_by: '',
  glcheck_cents: '',
  glcheck_at: '',
  glcheck_by: '',
  glcheck_diff_cents: '',
};
const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const putSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

function settings() {
  const v = (k) => { const r = getSetting.get(k); return r ? r.value : DEFAULTS[k]; };
  return {
    goalCents: parseInt(v('goal_cents'), 10),
    eventStart: v('event_start'),
    eventStartMs: Date.parse(v('event_start')),
    adjustCents: parseInt(v('adjust_cents'), 10) || 0,
    adjustNote: v('adjust_note'),
    // Offline gifts recorded in Give Lively (they never pass through Stripe).
    offlineCents: parseInt(v('offline_cents'), 10) || 0,
    offlineUpdatedAt: v('offline_updated_at') || null,
    offlineUpdatedBy: v('offline_updated_by'),
    // Last "what does the Give Lively page say?" check by an admin.
    glCheckCents: v('glcheck_cents') === '' ? null : parseInt(v('glcheck_cents'), 10),
    glCheckAt: v('glcheck_at') || null,
    glCheckBy: v('glcheck_by'),
    // Page figure minus (online + offline) at the moment of the check.
    glCheckDiffCents: v('glcheck_diff_cents') === '' ? null : parseInt(v('glcheck_diff_cents'), 10),
  };
}

// ---------- Status (in memory, shown on admin page) ----------
const status = {
  startedAt: new Date().toISOString(),
  lastWebhookAt: null,
  lastWebhookType: null,
  webhookErrors: 0,
  lastSyncAt: null,
  lastSyncOk: null,
  lastSyncError: null,
  lastSyncSeen: 0,
};

const now = () => new Date().toISOString();
const audit = db.prepare('INSERT INTO audit (at, who, action, detail) VALUES (?, ?, ?, ?)');

// ---------- Charges ----------
const upsertCharge = db.prepare(`
  INSERT INTO charges (id, created, source, in_campaign, ok, method, charge_cents, tip_cents, base_cents, refunded_cents, updated_at)
  VALUES (:id, :created, :source, :in_campaign, :ok, :method, :charge_cents, :tip_cents, :base_cents, :refunded_cents, :updated_at)
  ON CONFLICT(id) DO UPDATE SET
    source = excluded.source, in_campaign = excluded.in_campaign, ok = excluded.ok, method = excluded.method,
    charge_cents = excluded.charge_cents, tip_cents = excluded.tip_cents, base_cents = excluded.base_cents,
    refunded_cents = excluded.refunded_cents, updated_at = excluded.updated_at
`);

function saveCharge(ch) {
  upsertCharge.run({ ...chargeToRow(ch, { campaignSlug: CAMPAIGN_SLUG }), updated_at: now() });
}

let syncing = null;
async function syncFromStripe() {
  if (!STRIPE_KEY) { status.lastSyncOk = false; status.lastSyncError = 'STRIPE_SECRET_KEY not set'; return; }
  if (syncing) return syncing;
  syncing = (async () => {
    let seen = 0;
    try {
      // 1. Every Give Lively gift to this campaign, any date (catches refunds too).
      for await (const ch of stripe.charges.search({ query: `metadata['campaign_slug']:'${CAMPAIGN_SLUG}'`, limit: 100 })) {
        saveCharge(ch); seen++;
      }
      // 2. Every charge since the event start (card reader, payment links, ...).
      const since = Math.floor(settings().eventStartMs / 1000);
      for await (const ch of stripe.charges.list({ created: { gte: since }, limit: 100 })) {
        saveCharge(ch); seen++;
      }
      status.lastSyncOk = true; status.lastSyncError = null; status.lastSyncSeen = seen;
    } catch (err) {
      status.lastSyncOk = false; status.lastSyncError = err.message;
      console.error('Stripe sync failed:', err.message);
    } finally {
      status.lastSyncAt = now(); syncing = null;
    }
  })();
  return syncing;
}

// ---------- Totals ----------
const allCharges = db.prepare('SELECT * FROM charges ORDER BY created DESC');
const liveCash = db.prepare('SELECT * FROM cash WHERE deleted_at IS NULL');

function totals() {
  const s = settings();
  let givelively = 0, stripeSum = 0, gifts = 0;
  for (const row of allCharges.all()) {
    const { cents } = countRow(row, s);
    if (!cents) continue;
    gifts++;
    if (row.source === 'givelively') givelively += cents; else stripeSum += cents;
  }
  const cashRows = liveCash.all();
  const cash = cashRows.reduce((sum, r) => sum + r.amount_cents, 0);
  const total = givelively + s.offlineCents + stripeSum + cash + s.adjustCents;
  return {
    totalCents: total, goalCents: s.goalCents,
    givelivelyCents: givelively, offlineCents: s.offlineCents,
    stripeCents: stripeSum, cashCents: cash, adjustCents: s.adjustCents,
    gifts: gifts + cashRows.length,
  };
}

const insertSnapshot = db.prepare('INSERT OR IGNORE INTO snapshots (at, total_cents, givelively_cents, stripe_cents, cash_cents, adjust_cents, offline_cents) VALUES (?, ?, ?, ?, ?, ?, ?)');
let lastSnapshotTotal = null;
function snapshot() {
  const t = totals();
  if (t.totalCents === lastSnapshotTotal) return;
  lastSnapshotTotal = t.totalCents;
  insertSnapshot.run(now(), t.totalCents, t.givelivelyCents, t.stripeCents, t.cashCents, t.adjustCents, t.offlineCents);
}

// ---------- Admin sessions ----------
function sign(value) { return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex'); }
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function readCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}
function isAdmin(req) {
  const c = readCookie(req, 'adm');
  if (!c) return false;
  const [exp, sig] = c.split('.');
  return Boolean(exp && sig) && Number(exp) > Date.now() && safeEqual(sig, sign(exp));
}
function requireAdmin(req, res, next) {
  if (!ADMIN_PIN) return res.status(503).json({ error: 'ADMIN_PIN is not set on the server' });
  if (!isAdmin(req)) return res.status(401).json({ error: 'Please log in' });
  next();
}

const failures = new Map(); // ip -> { count, until }
function tooManyAttempts(ip) {
  const f = failures.get(ip);
  return f && f.count >= 8 && f.until > Date.now();
}
function noteFailure(ip) {
  const f = failures.get(ip);
  if (!f || f.until < Date.now()) failures.set(ip, { count: 1, until: Date.now() + 15 * 60 * 1000 });
  else f.count++;
}

// ---------- App ----------
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Frame-Options', 'DENY');
  next();
});
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Stripe webhook needs the raw body for signature checks, so it comes before express.json().
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), wrap(async (req, res) => {
  if (!WEBHOOK_SECRET) return res.status(503).send('Webhook secret not configured');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], WEBHOOK_SECRET);
  } catch (err) {
    status.webhookErrors++;
    console.warn('Rejected webhook:', err.message);
    return res.status(400).send('Bad signature');
  }
  if (event.type.startsWith('charge.') && event.data.object.object === 'charge') {
    let ch = event.data.object;
    // Re-read the charge so out-of-order events can't leave stale amounts behind.
    if (STRIPE_KEY) {
      try { ch = await stripe.charges.retrieve(ch.id); } catch (err) { console.warn('Charge re-read failed, using event copy:', err.message); }
    }
    saveCharge(ch);
    snapshot();
  }
  status.lastWebhookAt = now();
  status.lastWebhookType = event.type;
  res.json({ received: true });
}));

app.use(express.json({ limit: '20kb' }));

// Public: what the TV needs, nothing else.
app.get('/api/total', (req, res) => {
  const t = totals();
  res.set('Cache-Control', 'no-store');
  res.json({ totalCents: t.totalCents, goalCents: t.goalCents, gifts: t.gifts, at: now() });
});

app.get('/healthz', (req, res) => res.json({ ok: true, stripeKey: Boolean(STRIPE_KEY), webhookSecret: Boolean(WEBHOOK_SECRET), adminPin: Boolean(ADMIN_PIN) }));

// Admin login
app.post('/api/admin/login', (req, res) => {
  if (!ADMIN_PIN) return res.status(503).json({ error: 'ADMIN_PIN is not set on the server' });
  const ip = req.ip;
  if (tooManyAttempts(ip)) return res.status(429).json({ error: 'Too many tries. Wait 15 minutes.' });
  if (!safeEqual(String((req.body && req.body.pin) || ''), ADMIN_PIN)) {
    noteFailure(ip);
    return res.status(401).json({ error: 'Wrong PIN' });
  }
  failures.delete(ip);
  const exp = String(Date.now() + 12 * 60 * 60 * 1000);
  res.set('Set-Cookie', `adm=${exp}.${sign(exp)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`);
  res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => {
  res.set('Set-Cookie', 'adm=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
  res.json({ ok: true });
});

const recentCharges = db.prepare('SELECT * FROM charges ORDER BY created DESC LIMIT 40');
const allCash = db.prepare('SELECT * FROM cash ORDER BY created_at DESC');

app.get('/api/admin/state', requireAdmin, (req, res) => {
  const s = settings();
  res.set('Cache-Control', 'no-store');
  res.json({
    settings: s,
    totals: totals(),
    status: { ...status, stripeKey: Boolean(STRIPE_KEY), webhookSecret: Boolean(WEBHOOK_SECRET), campaignSlug: CAMPAIGN_SLUG },
    adminNames: ADMIN_NAMES,
    cash: allCash.all(),
    charges: recentCharges.all().map((r) => ({ ...r, ...countRow(r, s) })),
  });
});

function parseAmount(v) {
  const c = dollarsToCents(v);
  return c != null && Number.isInteger(c) ? c : null;
}

app.post('/api/admin/settings', requireAdmin, wrap(async (req, res) => {
  const b = req.body || {};
  const changes = [];
  if (b.goal != null) {
    const c = parseAmount(b.goal);
    if (!c || c <= 0) return res.status(400).json({ error: 'Goal must be a positive amount' });
    putSetting.run('goal_cents', String(c)); changes.push(`goal=${c}`);
  }
  let startChanged = false;
  if (b.eventStart != null) {
    // "2026-11-12T12:00" from a datetime-local input is read as Pacific time (TZ is set above).
    const ms = Date.parse(b.eventStart);
    if (!Number.isFinite(ms)) return res.status(400).json({ error: 'Event start is not a valid date' });
    const iso = new Date(ms).toISOString();
    if (iso !== new Date(settings().eventStartMs).toISOString()) { putSetting.run('event_start', iso); changes.push(`event_start=${iso}`); startChanged = true; }
  }
  if (b.adjust != null) {
    const c = parseAmount(b.adjust);
    if (c == null) return res.status(400).json({ error: 'Adjustment must be an amount (can be negative)' });
    putSetting.run('adjust_cents', String(c)); changes.push(`adjust=${c}`);
  }
  if (b.adjustNote != null) putSetting.run('adjust_note', String(b.adjustNote).slice(0, 200));
  audit.run(now(), String(b.who || ''), 'settings', changes.join(', '));
  if (startChanged) await syncFromStripe();
  snapshot();
  res.json({ ok: true });
}));

// Give Lively offline gifts: the total of offline donations recorded in Give Lively.
app.post('/api/admin/offline', requireAdmin, (req, res) => {
  const b = req.body || {};
  const c = parseAmount(b.amount);
  if (c == null || c < 0) return res.status(400).json({ error: 'Offline gifts must be $0 or more' });
  const who = String(b.who || '').slice(0, 60);
  putSetting.run('offline_cents', String(c));
  putSetting.run('offline_updated_at', now());
  putSetting.run('offline_updated_by', who);
  audit.run(now(), who, 'offline', String(c));
  snapshot();
  res.json({ ok: true });
});

// Give Lively page check: an admin types the "raised" figure the Give Lively page shows,
// and we compare it with online Give Lively gifts + offline gifts.
app.post('/api/admin/glcheck', requireAdmin, (req, res) => {
  const b = req.body || {};
  const c = parseAmount(b.amount);
  if (c == null || c < 0) return res.status(400).json({ error: 'Enter the amount shown on the Give Lively page' });
  const who = String(b.who || '').slice(0, 60);
  putSetting.run('glcheck_cents', String(c));
  putSetting.run('glcheck_at', now());
  putSetting.run('glcheck_by', who);
  const t = totals();
  const diff = c - (t.givelivelyCents + t.offlineCents);
  putSetting.run('glcheck_diff_cents', String(diff));
  audit.run(now(), who, 'glcheck', `page=${c} diff=${diff}`);
  res.json({ ok: true, diffCents: diff });
});

const insertCash = db.prepare('INSERT INTO cash (amount_cents, kind, note, entered_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
const updateCash = db.prepare('UPDATE cash SET amount_cents = ?, kind = ?, note = ?, entered_by = ?, updated_at = ? WHERE id = ?');
const setCashDeleted = db.prepare('UPDATE cash SET deleted_at = ?, updated_at = ? WHERE id = ?');
const KINDS = ['cash', 'cheque', 'other'];

function cashInput(b) {
  const amount = parseAmount(b.amount);
  if (!amount || amount <= 0) return { error: 'Amount must be more than $0' };
  if (amount > 5000000) return { error: 'That amount looks too large. Check it and try again.' };
  const kind = KINDS.includes(b.kind) ? b.kind : 'cash';
  return { amount, kind, note: String(b.note || '').slice(0, 120), who: String(b.who || '').slice(0, 60) };
}

app.post('/api/admin/cash', requireAdmin, (req, res) => {
  const c = cashInput(req.body || {});
  if (c.error) return res.status(400).json(c);
  const t = now();
  const r = insertCash.run(c.amount, c.kind, c.note, c.who, t, t);
  audit.run(t, c.who, 'cash add', `#${r.lastInsertRowid} ${c.amount}`);
  snapshot();
  res.json({ ok: true, id: Number(r.lastInsertRowid) });
});
app.put('/api/admin/cash/:id', requireAdmin, (req, res) => {
  const c = cashInput(req.body || {});
  if (c.error) return res.status(400).json(c);
  const r = updateCash.run(c.amount, c.kind, c.note, c.who, now(), Number(req.params.id));
  if (!r.changes) return res.status(404).json({ error: 'Entry not found' });
  audit.run(now(), c.who, 'cash edit', `#${req.params.id} ${c.amount}`);
  snapshot();
  res.json({ ok: true });
});
app.delete('/api/admin/cash/:id', requireAdmin, (req, res) => {
  const r = setCashDeleted.run(now(), now(), Number(req.params.id));
  if (!r.changes) return res.status(404).json({ error: 'Entry not found' });
  audit.run(now(), String(req.query.who || ''), 'cash delete', `#${req.params.id}`);
  snapshot();
  res.json({ ok: true });
});
app.post('/api/admin/cash/:id/restore', requireAdmin, (req, res) => {
  const r = setCashDeleted.run(null, now(), Number(req.params.id));
  if (!r.changes) return res.status(404).json({ error: 'Entry not found' });
  audit.run(now(), String((req.body && req.body.who) || ''), 'cash restore', `#${req.params.id}`);
  snapshot();
  res.json({ ok: true });
});

app.post('/api/admin/sync', requireAdmin, wrap(async (req, res) => {
  await syncFromStripe();
  snapshot();
  res.json({ ok: status.lastSyncOk, error: status.lastSyncError, seen: status.lastSyncSeen });
}));

// CSV exports
function csv(rows, columns) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(','), ...rows.map((r) => columns.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}
const dollars = (c) => (c / 100).toFixed(2);
const pacific = (ms) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
function sendCsv(res, name, body) {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${name}"`);
  res.send(body);
}
app.get('/api/admin/export/charges.csv', requireAdmin, (req, res) => {
  const s = settings();
  const rows = allCharges.all().map((r) => {
    const { cents, reason } = countRow(r, s);
    return {
      charge_id: r.id, created_pacific: pacific(r.created * 1000), source: r.source, method: r.method,
      charged: dollars(r.charge_cents), givelively_tip: dollars(r.tip_cents), yeti_share: dollars(r.base_cents),
      refunded: dollars(r.refunded_cents), counted: dollars(cents), reason,
    };
  });
  sendCsv(res, 'stripe-charges.csv', csv(rows, ['charge_id', 'created_pacific', 'source', 'method', 'charged', 'givelively_tip', 'yeti_share', 'refunded', 'counted', 'reason']));
});
app.get('/api/admin/export/cash.csv', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM cash ORDER BY id').all().map((r) => ({
    id: r.id, amount: dollars(r.amount_cents), kind: r.kind, note: r.note, entered_by: r.entered_by,
    created_pacific: pacific(Date.parse(r.created_at)), updated_pacific: pacific(Date.parse(r.updated_at)),
    deleted: r.deleted_at ? 'yes' : '',
  }));
  sendCsv(res, 'cash-entries.csv', csv(rows, ['id', 'amount', 'kind', 'note', 'entered_by', 'created_pacific', 'updated_pacific', 'deleted']));
});
app.get('/api/admin/export/snapshots.csv', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM snapshots ORDER BY at').all().map((r) => ({
    at_pacific: pacific(Date.parse(r.at)), total: dollars(r.total_cents), givelively_online: dollars(r.givelively_cents),
    givelively_offline: dollars(r.offline_cents || 0),
    stripe: dollars(r.stripe_cents), cash: dollars(r.cash_cents), adjustment: dollars(r.adjust_cents),
  }));
  sendCsv(res, 'total-history.csv', csv(rows, ['at_pacific', 'total', 'givelively_online', 'givelively_offline', 'stripe', 'cash', 'adjustment']));
});

// Pages
const pub = path.join(__dirname, 'public');
app.get('/', (req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(pub, 'index.html')); });
app.get('/admin', (req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(pub, 'admin.html')); });
app.use(express.static(pub, {
  index: false,
  // Images rarely change; CSS/JS are rechecked so the TV picks up fixes on its hourly reload.
  setHeaders: (res, file) => res.set('Cache-Control', /\.(png|svg|jpg|webp)$/.test(file) ? 'public, max-age=86400' : 'no-cache'),
}));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

app.listen(PORT, () => {
  console.log(`Thermometer listening on ${PORT}. Stripe key: ${Boolean(STRIPE_KEY)}, webhook secret: ${Boolean(WEBHOOK_SECRET)}, admin PIN: ${Boolean(ADMIN_PIN)}`);
  syncFromStripe().then(snapshot);
  setInterval(() => syncFromStripe().then(snapshot), SYNC_EVERY_MS);
});
