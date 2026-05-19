/**
 * index.js — Fastify entry point for Outland Radio
 *
 * Features:
 *  - Spotify OAuth + Web Playback SDK
 *  - SSE push for jingles and announcements (replaces client polling)
 *  - BullMQ + Redis scheduling (falls back to setInterval when Redis absent)
 *  - Nunjucks templates (Jinja2-compatible syntax)
 *  - JSON file persistence on Railway Volume
 */
import 'dotenv/config';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import fastifySession from '@fastify/session';
import fastifyFormbody from '@fastify/formbody';
import fastifyMultipart from '@fastify/multipart';
import fastifyView from '@fastify/view';
import nunjucks from 'nunjucks';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { isAuthenticated } from './routes/auth.js';
import { loadBranding } from './storage.js';
import { startScheduler } from './cron.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');

// ── Fastify ────────────────────────────────────────────────────────────────
const fastify = Fastify({
  logger: { level: process.env.NODE_ENV === 'production' ? 'warn' : 'info' },
  bodyLimit: 110 * 1024 * 1024,   // 110 MB for audio uploads
});

// ── Plugins ────────────────────────────────────────────────────────────────
await fastify.register(fastifyCookie);
await fastify.register(fastifyFormbody);

await fastify.register(fastifySession, {
  secret:      process.env.FLASK_SECRET_KEY || 'outland-radio-change-in-production-32ch',
  cookie:      { secure: process.env.NODE_ENV === 'production', httpOnly: true, maxAge: 86400000 },
  saveUninitialized: false,
});

await fastify.register(fastifyMultipart, {
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB per file
});

await fastify.register(fastifyView, {
  engine: { nunjucks },                     // pass the MODULE, not a pre-configured env
  root:   join(ROOT, 'templates'),
  options: {
    autoescape: true,
    filters: {
      tojson: (v) => JSON.stringify(v),
      int:    (v) => Math.floor(Number(v)),
    },
  },
});

await fastify.register(fastifyStatic, {
  root:   join(ROOT, 'static'),
  prefix: '/static/',
});

// Serve audio files from DATA_DIR subdirs
const DATA_DIR = process.env.DATA_DIR || '/programmatic-seo';
await fastify.register(fastifyStatic, {
  root:        join(DATA_DIR, 'jingles'),
  prefix:      '/jingles/files/',
  decorateReply: false,
});
await fastify.register(fastifyStatic, {
  root:        join(DATA_DIR, 'announcements'),
  prefix:      '/announce/files/',
  decorateReply: false,
});

// ── Decorators ─────────────────────────────────────────────────────────────

// Admin guard — preHandler for protected routes
fastify.decorate('adminGuard', async function (req, reply) {
  if (!req.session?.admin) {
    if (req.headers.accept?.includes('text/html')) {
      reply.redirect('/admin/login');
    } else {
      reply.status(401).send({ error: 'Unauthorized' });
    }
    return reply;
  }
});

// ── Routes ─────────────────────────────────────────────────────────────────
import authRoutes  from './routes/auth.js';
import apiRoutes   from './routes/api.js';
import adminRoutes from './routes/admin.js';
import eventsRoutes from './routes/events.js';

await fastify.register(authRoutes);
await fastify.register(apiRoutes);
await fastify.register(adminRoutes);
await fastify.register(eventsRoutes);

// ── Player ─────────────────────────────────────────────────────────────────
fastify.get('/', async (req, reply) => {
  if (!(await isAuthenticated())) return reply.redirect('/auth');
  reply.view('player.html', { branding: loadBranding() });
});

// ── Health ─────────────────────────────────────────────────────────────────
fastify.get('/health', async (req, reply) => reply.send({ ok: true }));

// Content-type for JSON bodies
fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  try { done(null, JSON.parse(body)); } catch (e) { done(e); }
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '5000');

await fastify.listen({ port: PORT, host: '0.0.0.0' });
fastify.log.info(`Outland Radio listening on port ${PORT}`);

await startScheduler();
