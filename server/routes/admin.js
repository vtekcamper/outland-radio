/**
 * admin.js — Admin panel routes (login, branding, schedule, settings, logo)
 */
import { join, extname } from 'path';
import { createWriteStream, createReadStream, unlinkSync, readdirSync } from 'fs';
import { pipeline } from 'stream/promises';
import {
  loadBranding, saveBranding, logoPath, DATA_DIR,
  loadSchedule, saveSchedule,
  loadSettings, saveSettings,
  loadJingles, loadJingleCfg, loadAnnouncements,
} from '../storage.js';

const LOGO_EXTS = new Set(['.png','.jpg','.jpeg','.svg','.webp','.gif']);
const ADMIN_PW  = process.env.ADMIN_PASSWORD || 'outland2024';

export default async function adminRoutes(fastify) {

  // ── Auth ──────────────────────────────────────────────────────────────────
  fastify.get('/admin/login', async (req, reply) => {
    const error = req.query.error ? 'Password errata' : null;
    return reply.view('admin_login.html', { error });
  });

  fastify.post('/admin/login', async (req, reply) => {
    const pw = req.body?.password;
    if (pw === ADMIN_PW) {
      // Set a signed cookie that survives across requests without a server-side store
      return reply
        .setCookie(fastify.ADMIN_COOKIE, '1', {
          httpOnly: true,
          path:     '/',
          maxAge:   86400,          // 24 h (seconds for setCookie)
          signed:   true,
          sameSite: 'lax',
          secure:   process.env.NODE_ENV === 'production',
        })
        .redirect('/admin');
    }
    return reply.redirect('/admin/login?error=1');
  });

  fastify.get('/admin/logout', async (req, reply) => {
    return reply.clearCookie(fastify.ADMIN_COOKIE, { path: '/' }).redirect('/');
  });

  // ── Admin panel ───────────────────────────────────────────────────────────
  fastify.get('/admin', { preHandler: fastify.adminGuard }, async (req, reply) => {
    return reply.view('admin.html', {
      jingles:       loadJingles(),
      jingle_cfg:    loadJingleCfg(),
      branding:      loadBranding(),
      schedule:      loadSchedule(),
      announcements: loadAnnouncements(),
      settings:      loadSettings(),
    });
  });

  // ── Branding ──────────────────────────────────────────────────────────────
  fastify.post('/admin/branding', { preHandler: fastify.adminGuard }, async (req, reply) => {
    const body = req.body ?? {};
    const b    = loadBranding();
    for (const key of ['store_name','store_subtitle','primary_color','bg_color','text_color']) {
      if (key in body) b[key] = String(body[key]).slice(0, 200);
    }
    saveBranding(b);
    reply.send({ ok: true });
  });

  fastify.post('/admin/branding/logo', { preHandler: fastify.adminGuard }, async (req, reply) => {
    const data = await req.file();
    if (!data) return reply.status(400).send({ ok: false, error: 'Nessun file' });
    const ext = extname(data.filename).toLowerCase();
    if (!LOGO_EXTS.has(ext)) return reply.status(400).send({ ok: false, error: 'Formato non supportato' });
    // Remove any existing logo file
    try {
      readdirSync(DATA_DIR).filter(f => /^logo\.[a-z]+$/.test(f)).forEach(f => {
        try { unlinkSync(join(DATA_DIR, f)); } catch {}
      });
    } catch {}
    const dest = join(DATA_DIR, `logo${ext}`);
    await pipeline(data.file, createWriteStream(dest));
    reply.send({ ok: true, url: `/api/logo?v=${Date.now()}` });
  });

  fastify.post('/admin/branding/logo/delete', { preHandler: fastify.adminGuard }, async (req, reply) => {
    try {
      readdirSync(DATA_DIR).filter(f => /^logo\.[a-z]+$/.test(f)).forEach(f => {
        try { unlinkSync(join(DATA_DIR, f)); } catch {}
      });
    } catch {}
    reply.send({ ok: true });
  });

  // ── Settings (timezone) ───────────────────────────────────────────────────
  fastify.post('/admin/settings', { preHandler: fastify.adminGuard }, async (req, reply) => {
    const tz = (req.body?.timezone ?? '').trim();
    if (!tz) return reply.send({ ok: true });
    // Validate by trying to format with this timezone
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz }).format(new Date());
    } catch {
      return reply.status(400).send({ ok: false, error: 'Fuso orario non valido' });
    }
    const cfg = loadSettings();
    cfg.timezone = tz;
    saveSettings(cfg);
    reply.send({ ok: true });
  });

  // ── Schedule ──────────────────────────────────────────────────────────────
  fastify.get('/api/schedule', async (req, reply) => {
    reply.send(loadSchedule());
  });

  fastify.post('/admin/schedule', { preHandler: fastify.adminGuard }, async (req, reply) => {
    const entries = req.body;
    if (!Array.isArray(entries)) return reply.status(400).send({ ok: false });
    saveSchedule(entries);
    reply.send({ ok: true });
  });

  // ── Logo serve ────────────────────────────────────────────────────────────
  fastify.get('/api/logo', async (req, reply) => {
    const p = logoPath();
    if (!p) return reply.status(404).send();
    const ext  = extname(p).slice(1).toLowerCase();
    const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
                   svg: 'image/svg+xml', webp: 'image/webp', gif: 'image/gif' };
    reply.type(mime[ext] || 'image/png').send(createReadStream(p));
  });
}
