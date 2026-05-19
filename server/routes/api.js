/**
 * api.js — Spotify API proxy + device management
 */
import { spotifyApi, getAccessToken } from './auth.js';
import {
  loadDevice, saveDevice,
  loadLastPlay, saveLastPlay,
} from '../storage.js';
import { onTrackChanged } from '../cron.js';

export default async function apiRoutes(fastify) {

  // ── Now playing ──────────────────────────────────────────────────────────
  fastify.get('/api/now-playing', async (req, reply) => {
    const { data, status } = await spotifyApi('get', '/me/player/currently-playing');
    if (status === 204 || !data) return reply.send({ playing: false });
    const item    = data.item ?? {};
    const artists = (item.artists ?? []).map(a => a.name).join(', ');
    const images  = item.album?.images ?? [];
    reply.send({
      playing:     data.is_playing ?? false,
      title:       item.name ?? '',
      artist:      artists,
      album:       item.album?.name ?? '',
      image:       images[0]?.url ?? '',
      progress_ms: data.progress_ms ?? 0,
      duration_ms: item.duration_ms ?? 0,
    });
  });

  // ── Register device (called by Spotify SDK on ready) ─────────────────────
  fastify.post('/api/register-device', async (req, reply) => {
    const device_id = req.body?.device_id ?? '';
    if (!device_id) return reply.send({ ok: false });
    saveDevice(device_id);

    // Auto-resume last playlist on new device (1.5s delay for SDK stabilisation)
    const last = loadLastPlay();
    if (last.uri) {
      setTimeout(() => {
        spotifyApi('put', `/me/player/play?device_id=${device_id}`, {
          data: { context_uri: last.uri },
        }).catch(() => {});
      }, 1500);
    }
    reply.send({ ok: true });
  });

  // ── Track-changed notification (from player JS) ──────────────────────────
  // The player POSTs here on every Spotify track change so the server can
  // count songs and fire jingles via SSE when the threshold is reached.
  fastify.post('/api/track-changed', async (req, reply) => {
    onTrackChanged();
    reply.send({ ok: true });
  });

  // ── Search playlists ─────────────────────────────────────────────────────
  fastify.get('/api/search-playlists', async (req, reply) => {
    const q = (req.query.q ?? '').trim();
    if (!q) return reply.send([]);
    const token = await getAccessToken();
    if (!token) return reply.status(401).send({ error: 'no_token', message: 'Vai su / per autenticarti con Spotify' });
    try {
      const { default: axios } = await import('axios');
      const r = await axios.get('https://api.spotify.com/v1/search', {
        headers: { Authorization: `Bearer ${token}` },
        params:  { q, type: 'playlist' },
        validateStatus: () => true,
      });
      if (r.status !== 200) return reply.send([]);
      const items = (r.data?.playlists?.items ?? []).filter(Boolean);
      return reply.send(items.slice(0, 24).map(p => ({
        name:        p.name ?? '',
        uri:         p.uri  ?? '',
        image:       p.images?.[0]?.url ?? '',
        owner:       p.owner?.display_name ?? '',
        track_count: p.tracks?.total ?? 0,
      })));
    } catch {
      return reply.send([]);
    }
  });

  // ── Playback controls ─────────────────────────────────────────────────────
  fastify.post('/api/play', { preHandler: fastify.adminGuard }, async (req, reply) => {
    const { context_uri, device_id: reqDevice } = req.body ?? {};
    const device_id = reqDevice || loadDevice();
    const qs     = device_id ? `?device_id=${device_id}` : '';
    const { status } = await spotifyApi('put', `/me/player/play${qs}`,
      { data: context_uri ? { context_uri } : {} });
    const ok = [200, 204].includes(status);
    if (ok && context_uri) saveLastPlay({ uri: context_uri });
    reply.send({ ok });
  });

  fastify.post('/api/pause', { preHandler: fastify.adminGuard }, async (req, reply) => {
    const { status } = await spotifyApi('put', '/me/player/pause');
    reply.send({ ok: [200, 204].includes(status) });
  });

  fastify.post('/api/next', { preHandler: fastify.adminGuard }, async (req, reply) => {
    const { status } = await spotifyApi('post', '/me/player/next');
    reply.send({ ok: [200, 204].includes(status) });
  });

  fastify.post('/api/prev', { preHandler: fastify.adminGuard }, async (req, reply) => {
    const { status } = await spotifyApi('post', '/me/player/previous');
    reply.send({ ok: [200, 204].includes(status) });
  });

  fastify.post('/api/volume', { preHandler: fastify.adminGuard }, async (req, reply) => {
    const vol = Math.max(0, Math.min(100, parseInt(req.body?.volume_percent ?? 80)));
    const { status } = await spotifyApi('put', `/me/player/volume?volume_percent=${vol}`);
    reply.send({ ok: [200, 204].includes(status) });
  });

  fastify.post('/api/shuffle', { preHandler: fastify.adminGuard }, async (req, reply) => {
    const state = req.body?.state ? 'true' : 'false';
    const { status } = await spotifyApi('put', `/me/player/shuffle?state=${state}`);
    reply.send({ ok: [200, 204].includes(status) });
  });

  // ── Public data ───────────────────────────────────────────────────────────
  fastify.get('/api/branding', async (req, reply) => {
    const { loadBranding } = await import('../storage.js');
    reply.send(loadBranding());
  });

  fastify.get('/api/settings', async (req, reply) => {
    const { loadSettings } = await import('../storage.js');
    reply.send(loadSettings());
  });
}
