/**
 * storage.js — thin JSON-file persistence layer
 * Keeps the same file layout as the previous Python app so existing data
 * on the Railway Volume migrates automatically.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

export const DATA_DIR    = process.env.DATA_DIR || '/programmatic-seo';
export const JINGLES_DIR = join(DATA_DIR, 'jingles');
export const ANN_DIR     = join(DATA_DIR, 'announcements');

// ── ensure dirs ────────────────────────────────────────────────────────────
for (const d of [DATA_DIR, JINGLES_DIR, ANN_DIR]) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

// ── low-level helpers ──────────────────────────────────────────────────────
function rj(path, def) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return def; }
}
function wj(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf8');
}

// ── Spotify tokens ────────────────────────────────────────────────────────
const TOKEN_FILE = join(DATA_DIR, 'spotify_tokens.json');

export function loadTokens() {
  const env = process.env.SPOTIFY_REFRESH_TOKEN;
  const t   = rj(TOKEN_FILE, {});
  if (env && !t.refresh_token) t.refresh_token = env;
  return t;
}
export function saveTokens(t) { wj(TOKEN_FILE, t); }

// ── Device ────────────────────────────────────────────────────────────────
const DEVICE_FILE = join(DATA_DIR, 'device_id.txt');
export function loadDevice() {
  try { return readFileSync(DEVICE_FILE, 'utf8').trim(); } catch { return ''; }
}
export function saveDevice(id) { writeFileSync(DEVICE_FILE, id, 'utf8'); }

// ── Last played ───────────────────────────────────────────────────────────
const LAST_PLAY_FILE = join(DATA_DIR, 'last_played.json');
export function loadLastPlay() { return rj(LAST_PLAY_FILE, {}); }
export function saveLastPlay(d) { wj(LAST_PLAY_FILE, d); }

// ── Branding ──────────────────────────────────────────────────────────────
const BRANDING_FILE = join(DATA_DIR, 'branding.json');
const BRANDING_DEF  = {
  store_name: 'OUTLAND RADIO',
  store_subtitle: 'Outland Store · Accessori Camper',
  primary_color: '#d97706',
  bg_color: '#1c2b33',
  text_color: '#f0f4f5',
};
const LOGO_EXTS = ['png','jpg','jpeg','svg','webp','gif'];

export function logoPath() {
  for (const ext of LOGO_EXTS) {
    const p = join(DATA_DIR, `logo.${ext}`);
    if (existsSync(p)) return p;
  }
  return null;
}

export function loadBranding() {
  const b = { ...BRANDING_DEF, ...rj(BRANDING_FILE, {}) };
  b.has_logo = logoPath() !== null;
  return b;
}
export function saveBranding(d) { wj(BRANDING_FILE, d); }

// ── Settings (timezone) ───────────────────────────────────────────────────
const SETTINGS_FILE = join(DATA_DIR, 'settings.json');
const SETTINGS_DEF  = { timezone: 'Europe/Rome' };
export function loadSettings() { return { ...SETTINGS_DEF, ...rj(SETTINGS_FILE, {}) }; }
export function saveSettings(d) { wj(SETTINGS_FILE, d); }

// ── Schedule (auto-playlist) ──────────────────────────────────────────────
const SCHEDULE_FILE = join(DATA_DIR, 'schedule.json');
export function loadSchedule() { return rj(SCHEDULE_FILE, []); }
export function saveSchedule(d) { wj(SCHEDULE_FILE, d); }

// ── Jingle meta ───────────────────────────────────────────────────────────
const JINGLE_META_FILE = join(DATA_DIR, 'jingles_meta.json');
const JINGLE_CFG_FILE  = join(DATA_DIR, 'jingle_settings.json');
const ROTATION_FILE    = join(DATA_DIR, 'jingle_rotation.json');
const JINGLE_DEF       = { weight: 1, time_start: null, time_end: null, days: [], enabled: true };

export function loadJingles() {
  const raw = rj(JINGLE_META_FILE, []);
  return raw.map(j => ({ ...JINGLE_DEF, ...j }));
}
export function saveJingles(d) { wj(JINGLE_META_FILE, d); }

const JINGLE_CFG_DEF = {
  enabled: true, every_n_songs: 3, every_n_minutes: 0,
  rotation_mode: 'no_repeat', crossfade_ms: 1500,
};
export function loadJingleCfg() { return { ...JINGLE_CFG_DEF, ...rj(JINGLE_CFG_FILE, {}) }; }
export function saveJingleCfg(d) { wj(JINGLE_CFG_FILE, d); }

const ROT_DEF = { mode: 'no_repeat', seq_index: 0, played_ids: [], last_id: null };
export function loadRotation() { return { ...ROT_DEF, ...rj(ROTATION_FILE, {}) }; }
export function saveRotation(d) { wj(ROTATION_FILE, d); }

// ── Announcement meta ─────────────────────────────────────────────────────
const ANN_META_FILE = join(DATA_DIR, 'announce_meta.json');
const ANN_DEF = {
  duck_volume: 0.3, tolerance_sec: 60, times: [], interval_min: 0,
  interval_start: null, interval_end: null, days: [], cooldown_min: 5,
  enabled: true, last_played_at: null,
};
export function loadAnnouncements() {
  const raw = rj(ANN_META_FILE, []);
  return raw.map(a => ({ ...ANN_DEF, ...a }));
}
export function saveAnnouncements(d) { wj(ANN_META_FILE, d); }

// ── Time helpers ───────────────────────────────────────────────────────────
export function nowInTz() {
  const tz = loadSettings().timezone || 'Europe/Rome';
  // Return a Date-like object with local fields for the configured timezone
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, weekday: 'short',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  const DOW = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
  return {
    hour:    parseInt(parts.hour === '24' ? '0' : parts.hour),
    minute:  parseInt(parts.minute),
    second:  parseInt(parts.second),
    weekday: DOW[parts.weekday] ?? 0,   // 0=Sun,1=Mon,...,6=Sat
    hm: `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`,
  };
}

// ── Jingle active-now check ────────────────────────────────────────────────
const DAY_KEYS = ['sun','mon','tue','wed','thu','fri','sat']; // JS weekday 0=Sun

export function jingleActiveNow(j) {
  if (!j.enabled) return false;
  const now = nowInTz();
  const days = j.days || [];
  if (days.length && !days.includes(DAY_KEYS[now.weekday])) return false;
  if (j.time_start && j.time_end) {
    if (now.hm < j.time_start || now.hm > j.time_end) return false;
  }
  return true;
}

// ── Announce due check ─────────────────────────────────────────────────────
export function announceDue(ann) {
  if (!ann.enabled) return false;
  const now = nowInTz();
  const days = ann.days || [];
  if (days.length && !days.includes(DAY_KEYS[now.weekday])) return false;

  const cooldown = Math.max(1, ann.cooldown_min ?? 5);
  if (ann.last_played_at) {
    const elapsed = (Date.now() - new Date(ann.last_played_at).getTime()) / 60000;
    if (elapsed < cooldown) return false;
  }

  const nowMin = now.hour * 60 + now.minute;
  const tol    = ann.tolerance_sec ?? 60;
  for (const t of (ann.times || [])) {
    const [h, m] = t.split(':').map(Number);
    if (Math.abs(nowMin - (h * 60 + m)) * 60 <= tol) return true;
  }

  const interval = ann.interval_min ?? 0;
  if (interval > 0) {
    const start = ann.interval_start;
    const end   = ann.interval_end;
    const inWin = !start || !end || (now.hm >= start && now.hm <= end);
    if (inWin) {
      if (!ann.last_played_at) return true;
      const elapsed = (Date.now() - new Date(ann.last_played_at).getTime()) / 60000;
      if (elapsed >= interval) return true;
    }
  }
  return false;
}

// ── Jingle picker ─────────────────────────────────────────────────────────
export function pickJingle(active, mode, rot) {
  if (!active.length) return null;
  let chosen;

  if (mode === 'sequential') {
    const idx = (rot.seq_index ?? 0) % active.length;
    rot.seq_index = (idx + 1) % active.length;
    chosen = active[idx];

  } else if (mode === 'weighted') {
    const weights = active.map(j => Math.max(1, j.weight ?? 1));
    const total   = weights.reduce((a, b) => a + b, 0);
    let rand = Math.random() * total;
    chosen = active[active.length - 1];
    for (let i = 0; i < active.length; i++) {
      rand -= weights[i];
      if (rand <= 0) { chosen = active[i]; break; }
    }

  } else if (mode === 'no_repeat') {
    let played = new Set(rot.played_ids || []);
    let pool   = active.filter(j => !played.has(j.id));
    if (!pool.length) { played = new Set(); pool = [...active]; }
    if (pool.length > 1 && rot.last_id) pool = pool.filter(j => j.id !== rot.last_id) || pool;
    chosen = pool[Math.floor(Math.random() * pool.length)];
    played.add(chosen.id);
    rot.played_ids = [...played];

  } else { // random
    const pool = active.length > 1 && rot.last_id
      ? (active.filter(j => j.id !== rot.last_id) || active)
      : active;
    chosen = pool[Math.floor(Math.random() * pool.length)];
  }

  rot.last_id = chosen.id;
  saveRotation(rot);
  return chosen;
}
