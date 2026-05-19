/**
 * cron.js — Periodic scheduler for jingles and announcements.
 *
 * Uses BullMQ + Redis when REDIS_URL is available (robust, persistent cron).
 * Falls back to a simple setInterval when Redis is absent (dev / no-Redis).
 *
 * Broadcasts SSE events via sse.js so connected player tabs act immediately.
 */
import { broadcast } from './sse.js';
import {
  loadAnnouncements, saveAnnouncements,
  loadJingles, loadJingleCfg, loadRotation,
  jingleActiveNow, announceDue, pickJingle,
} from './storage.js';

// ── Jingle song-count state ───────────────────────────────────────────────
let songCount = 0;
let minuteJingleTimer = null;

export function onTrackChanged() {
  const cfg = loadJingleCfg();
  if (!cfg.enabled) return;
  songCount++;
  if (cfg.every_n_songs > 0 && songCount >= cfg.every_n_songs) {
    songCount = 0;
    fireJingle();
  }
}

export function resetSongCount() { songCount = 0; }

// ── Jingle fire ───────────────────────────────────────────────────────────
function fireJingle() {
  const cfg    = loadJingleCfg();
  if (!cfg.enabled) return;
  const meta   = loadJingles();
  const active = meta.filter(jingleActiveNow);
  if (!active.length) return;

  const rot    = loadRotation();
  const jingle = pickJingle(active, cfg.rotation_mode ?? 'no_repeat', rot);
  if (!jingle) return;

  broadcast({
    type:         'JINGLE',
    src:          `/jingles/files/${jingle.filename}`,
    name:         jingle.name,
    crossfade_ms: cfg.crossfade_ms ?? 1500,
    scheduledAt:  Date.now() / 1000 + 1.5,   // 1.5s buffer for SSE propagation
  });
}

// ── Announcement check ────────────────────────────────────────────────────
function checkAnnouncements() {
  const meta = loadAnnouncements();
  for (const ann of meta) {
    if (announceDue(ann)) {
      // Mark played NOW (before broadcast) so concurrent polls don't re-fire
      ann.last_played_at = new Date().toISOString();
      saveAnnouncements(meta);

      broadcast({
        type:         'ANNOUNCE',
        id:           ann.id,
        src:          `/announce/files/${ann.filename}`,
        name:         ann.name,
        duck_volume:  ann.duck_volume  ?? 0.3,
        crossfade_ms: 1000,
        scheduledAt:  Date.now() / 1000 + 1.5,
      });
      break; // one announcement per tick
    }
  }
}

// ── Minute-based jingle timer ─────────────────────────────────────────────
function restartMinuteTimer() {
  if (minuteJingleTimer) clearInterval(minuteJingleTimer);
  const cfg = loadJingleCfg();
  if (cfg.enabled && cfg.every_n_minutes > 0) {
    minuteJingleTimer = setInterval(fireJingle, cfg.every_n_minutes * 60 * 1000);
  }
}

// ── BullMQ (optional) ─────────────────────────────────────────────────────
async function tryBullMQ() {
  const url = process.env.REDIS_URL;
  if (!url) return false;

  try {
    const { Queue, Worker } = await import('bullmq');
    const { default: Redis } = await import('ioredis');

    const connection = new Redis(url, { maxRetriesPerRequest: null });

    const queue = new Queue('radio-cron', { connection });

    // Ensure unique repeatable jobs (safe to call on every start)
    await queue.add('check-announcements', {}, {
      repeat:          { every: 30_000 },
      removeOnComplete: { count: 1 },
      removeOnFail:    { count: 5 },
      jobId:           'announcements-tick',
    });

    new Worker('radio-cron', async (job) => {
      if (job.name === 'check-announcements') checkAnnouncements();
    }, { connection });

    console.log('[cron] BullMQ scheduler active (Redis:', url.split('@').pop(), ')');
    return true;
  } catch (e) {
    console.warn('[cron] BullMQ unavailable, using fallback setInterval —', e.message);
    return false;
  }
}

// ── Start ─────────────────────────────────────────────────────────────────
export async function startScheduler() {
  const bullOk = await tryBullMQ();
  if (!bullOk) {
    // Fallback: plain setInterval every 30 seconds
    setInterval(checkAnnouncements, 30_000);
    console.log('[cron] setInterval fallback scheduler active (30s)');
  }
  restartMinuteTimer();
  console.log('[cron] scheduler started');
}

// Allow admin to restart the minute timer after settings change
export { restartMinuteTimer };
