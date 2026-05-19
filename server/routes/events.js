/**
 * events.js — SSE endpoint + jingle/announce API
 *
 * GET /api/stream   → SSE connection (player tab subscribes here)
 * GET /api/jingles/settings → jingle config (used by player on load)
 */
import { addClient, removeClient, clientCount } from '../sse.js';
import {
  loadJingles, saveJingles, loadJingleCfg, saveJingleCfg,
  loadRotation, saveRotation,
  loadAnnouncements, saveAnnouncements,
  JINGLES_DIR, ANN_DIR,
} from '../storage.js';
import { restartMinuteTimer } from '../cron.js';
import { randomUUID } from 'crypto';
import { join, extname } from 'path';
import { createWriteStream, unlinkSync, existsSync } from 'fs';
import { pipeline } from 'stream/promises';

const AUDIO_EXTS = new Set(['.mp3', '.wav', '.ogg', '.m4a']);

function sanitize(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

export default async function eventsRoutes(fastify) {

  // ── SSE stream ───────────────────────────────────────────────────────────
  fastify.get('/api/stream', (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Initial heartbeat so the browser knows the connection is alive
    reply.raw.write(': connected\n\n');

    const send = (data) => { try { reply.raw.write(data); } catch {} };
    addClient(send);

    // Keepalive ping every 20s to prevent Railway / nginx from closing idle SSE
    const ping = setInterval(() => { try { reply.raw.write(': ping\n\n'); } catch {} }, 20_000);

    req.raw.on('close', () => {
      clearInterval(ping);
      removeClient(send);
    });

    // Don't call reply.send() — keep the response open
  });

  fastify.get('/api/stream/clients', async (req, reply) => {
    reply.send({ clients: clientCount() });
  });

  // ── Jingle settings (read by player on load) ──────────────────────────────
  fastify.get('/api/jingles/settings', async (req, reply) => {
    reply.send(loadJingleCfg());
  });

  fastify.post('/admin/jingles/settings', { preHandler: fastify.adminGuard }, async (req, reply) => {
    const body = req.body ?? {};
    const cfg  = loadJingleCfg();
    if ('enabled'         in body) cfg.enabled         = !!body.enabled;
    if ('every_n_songs'   in body) cfg.every_n_songs   = Math.max(0, parseInt(body.every_n_songs));
    if ('every_n_minutes' in body) cfg.every_n_minutes = Math.max(0, parseInt(body.every_n_minutes));
    if (body.rotation_mode in { random:1, no_repeat:1, sequential:1, weighted:1 }) {
      cfg.rotation_mode = body.rotation_mode;
      const rot = loadRotation();
      rot.seq_index = 0; rot.played_ids = []; rot.last_id = null;
      saveRotation(rot);
    }
    if ('crossfade_ms' in body) cfg.crossfade_ms = Math.max(0, Math.min(5000, parseInt(body.crossfade_ms)));
    saveJingleCfg(cfg);
    restartMinuteTimer();
    reply.send({ ok: true });
  });

  // ── Jingle CRUD ───────────────────────────────────────────────────────────
  fastify.get('/api/jingles', async (req, reply) => {
    reply.send(loadJingles());
  });

  fastify.post('/admin/jingles/upload', { preHandler: fastify.adminGuard }, async (req, reply) => {
    const data = await req.file();
    if (!data) return reply.status(400).send({ ok: false, error: 'Nessun file' });
    const ext = extname(data.filename).toLowerCase();
    if (!AUDIO_EXTS.has(ext)) return reply.status(400).send({ ok: false, error: 'Formato non supportato' });
    const uid      = randomUUID().slice(0, 8);
    const filename = `${uid}_${sanitize(data.filename)}`;
    await pipeline(data.file, createWriteStream(join(JINGLES_DIR, filename)));
    const name = data.filename.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ');
    const meta = loadJingles();
    meta.push({ id: uid, filename, name, enabled: true, weight: 1, time_start: null, time_end: null, days: [] });
    saveJingles(meta);
    reply.send({ ok: true, id: uid, name });
  });

  fastify.post('/admin/jingles/:id/toggle', { preHandler: fastify.adminGuard }, async (req, reply) => {
    const meta = loadJingles();
    const j = meta.find(x => x.id === req.params.id);
    if (j) j.enabled = !j.enabled;
    saveJingles(meta);
    reply.send({ ok: true });
  });

  fastify.post('/admin/jingles/:id/rename', { preHandler: fastify.adminGuard }, async (req, reply) => {
    const name = (req.body?.name ?? '').trim();
    if (!name) return reply.status(400).send({ ok: false });
    const meta = loadJingles();
    const j = meta.find(x => x.id === req.params.id);
    if (j) j.name = name;
    saveJingles(meta);
    reply.send({ ok: true });
  });

  fastify.post('/admin/jingles/:id/settings', { preHandler: fastify.adminGuard }, async (req, reply) => {
    const body = req.body ?? {};
    const meta = loadJingles();
    const j    = meta.find(x => x.id === req.params.id);
    if (j) {
      if ('weight'     in body) j.weight     = Math.max(1, Math.min(10, parseInt(body.weight)));
      if ('time_start' in body) j.time_start = body.time_start || null;
      if ('time_end'   in body) j.time_end   = body.time_end   || null;
      if ('days'       in body) j.days       = (body.days ?? []).filter(d => 'mon tue wed thu fri sat sun'.includes(d));
    }
    saveJingles(meta);
    reply.send({ ok: true });
  });

  fastify.post('/admin/jingles/:id/delete', { preHandler: fastify.adminGuard }, async (req, reply) => {
    const meta   = loadJingles();
    const target = meta.find(x => x.id === req.params.id);
    if (target) {
      const fp = join(JINGLES_DIR, target.filename);
      if (existsSync(fp)) unlinkSync(fp);
      saveJingles(meta.filter(x => x.id !== req.params.id));
    }
    reply.send({ ok: true });
  });

  // ── Announcement CRUD ──────────────────────────────────────────────────────
  fastify.post('/admin/announce/upload', { preHandler: fastify.adminGuard }, async (req, reply) => {
    const data = await req.file();
    if (!data) return reply.status(400).send({ ok: false, error: 'Nessun file' });
    const ext = extname(data.filename).toLowerCase();
    if (!AUDIO_EXTS.has(ext)) return reply.status(400).send({ ok: false, error: 'Formato non supportato' });
    const uid      = randomUUID().slice(0, 8);
    const filename = `${uid}_${sanitize(data.filename)}`;
    await pipeline(data.file, createWriteStream(join(ANN_DIR, filename)));
    const name = data.filename.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ');
    const meta = loadAnnouncements();
    meta.push({
      id: uid, filename, name, enabled: true,
      duck_volume: 0.3, tolerance_sec: 60, times: [], interval_min: 0,
      interval_start: null, interval_end: null, days: [], cooldown_min: 5,
      last_played_at: null,
    });
    saveAnnouncements(meta);
    reply.send({ ok: true, id: uid, name });
  });

  fastify.post('/admin/announce/:id/toggle', { preHandler: fastify.adminGuard }, async (req, reply) => {
    const meta = loadAnnouncements();
    const a = meta.find(x => x.id === req.params.id);
    if (a) a.enabled = !a.enabled;
    saveAnnouncements(meta);
    reply.send({ ok: true });
  });

  fastify.post('/admin/announce/:id/rename', { preHandler: fastify.adminGuard }, async (req, reply) => {
    const name = (req.body?.name ?? '').trim();
    if (!name) return reply.status(400).send({ ok: false });
    const meta = loadAnnouncements();
    const a = meta.find(x => x.id === req.params.id);
    if (a) a.name = name;
    saveAnnouncements(meta);
    reply.send({ ok: true });
  });

  fastify.post('/admin/announce/:id/settings', { preHandler: fastify.adminGuard }, async (req, reply) => {
    const body = req.body ?? {};
    const meta = loadAnnouncements();
    const a    = meta.find(x => x.id === req.params.id);
    if (a) {
      if ('duck_volume'    in body) a.duck_volume    = Math.max(0, Math.min(1, parseFloat(body.duck_volume)));
      if ('tolerance_sec'  in body) a.tolerance_sec  = Math.max(10, Math.min(600, parseInt(body.tolerance_sec)));
      if ('times'          in body) a.times          = (body.times ?? []).filter(t => /^\d{2}:\d{2}$/.test(t));
      if ('interval_min'   in body) a.interval_min   = Math.max(0, parseInt(body.interval_min));
      if ('interval_start' in body) a.interval_start = body.interval_start || null;
      if ('interval_end'   in body) a.interval_end   = body.interval_end   || null;
      if ('cooldown_min'   in body) a.cooldown_min   = Math.max(1, parseInt(body.cooldown_min));
      if ('days'           in body) a.days           = (body.days ?? []).filter(d => 'mon tue wed thu fri sat sun'.includes(d));
    }
    saveAnnouncements(meta);
    reply.send({ ok: true });
  });

  fastify.post('/admin/announce/:id/delete', { preHandler: fastify.adminGuard }, async (req, reply) => {
    const meta   = loadAnnouncements();
    const target = meta.find(x => x.id === req.params.id);
    if (target) {
      const fp = join(ANN_DIR, target.filename);
      if (existsSync(fp)) unlinkSync(fp);
      saveAnnouncements(meta.filter(x => x.id !== req.params.id));
    }
    reply.send({ ok: true });
  });
}
