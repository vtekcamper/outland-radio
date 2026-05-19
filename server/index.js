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
  logger:               { level: process.env.LOG_LEVEL || 'info' },
  bodyLimit:            110 * 1024 * 1024,   // 110 MB for audio uploads
  ignoreTrailingSlash:  true,                // /admin and /admin/ treated as the same route
});

// ── Plugins ────────────────────────────────────────────────────────────────
// Cookie plugin with signing secret — used for admin auth cookie
const COOKIE_SECRET = process.env.FLASK_SECRET_KEY || 'outland-radio-cookie-secret-32chars!!';
await fastify.register(fastifyCookie, { secret: COOKIE_SECRET });
await fastify.register(fastifyFormbody);

await fastify.register(fastifyMultipart, {
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB per file
});

// Configure nunjucks manually so we can register custom filters via addFilter()
// (@fastify/view passes options to nunjucks.configure() but nunjucks ignores unknown keys like
// "filters" — filters must be added on the Environment object returned by configure())
const njkEnv = nunjucks.configure(join(ROOT, 'templates'), { autoescape: true });
njkEnv.addFilter('tojson', (v) => JSON.stringify(v));
njkEnv.addFilter('int',    (v) => Math.floor(Number(v)));

await fastify.register(fastifyView, {
  // Shim: @fastify/view calls shim.configure() → we return our pre-configured env
  engine: { nunjucks: { configure: (_root, _opts) => njkEnv } },
  root:   join(ROOT, 'templates'),
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
// Uses a signed cookie instead of server-side sessions (simpler, no store needed)
const ADMIN_COOKIE = 'adminAuth';
fastify.decorate('ADMIN_COOKIE', ADMIN_COOKIE);
fastify.decorate('adminGuard', async function (req, reply) {
  const raw    = req.cookies?.[ADMIN_COOKIE] ?? '';
  const result = raw ? req.unsignCookie(raw) : { valid: false };
  if (!result.valid) {
    if (req.headers.accept?.includes('text/html')) {
      return reply.redirect('/admin/login');
    }
    return reply.status(401).send({ error: 'Unauthorized' });
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
  return reply.view('player.html', { branding: loadBranding() });
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
