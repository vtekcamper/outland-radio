/**
 * auth.js — Spotify OAuth routes + token API
 */
import axios from 'axios';
import { loadTokens, saveTokens } from '../storage.js';

const CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI  = process.env.SPOTIFY_REDIRECT_URI;

const SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
  'playlist-read-private',
  'playlist-read-collaborative',
].join(' ');

// ── Token helpers (exported for other routes) ─────────────────────────────
export async function refreshAccessToken() {
  const tokens = loadTokens();
  if (!tokens.refresh_token) return null;
  try {
    const { data } = await axios.post(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    tokens.access_token = data.access_token;
    tokens.expires_at   = Date.now() / 1000 + data.expires_in - 60;
    if (data.refresh_token) tokens.refresh_token = data.refresh_token;
    saveTokens(tokens);
    return tokens.access_token;
  } catch {
    return null;
  }
}

export async function getAccessToken() {
  const tokens = loadTokens();
  if (!tokens.access_token && !tokens.refresh_token) return null;
  if (Date.now() / 1000 >= (tokens.expires_at ?? 0)) return refreshAccessToken();
  return tokens.access_token;
}

export async function isAuthenticated() {
  return !!(await getAccessToken());
}

export async function spotifyApi(method, endpoint, opts = {}) {
  const token = await getAccessToken();
  if (!token) return { data: null, status: 401 };
  try {
    const resp = await axios({
      method,
      url: `https://api.spotify.com/v1${endpoint}`,
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true,
      ...opts,
    });
    return { data: resp.data, status: resp.status };
  } catch (e) {
    return { data: null, status: 500 };
  }
}

// ── Routes ────────────────────────────────────────────────────────────────
export default async function authRoutes(fastify) {
  // Redirect to Spotify OAuth
  fastify.get('/auth', async (req, reply) => {
    const params = new URLSearchParams({
      client_id:     CLIENT_ID,
      response_type: 'code',
      redirect_uri:  REDIRECT_URI,
      scope:         SCOPES,
      show_dialog:   'false',
    });
    reply.redirect(`https://accounts.spotify.com/authorize?${params}`);
  });

  // OAuth callback
  fastify.get('/callback', async (req, reply) => {
    const { code, error } = req.query;
    if (error) return reply.status(400).send(`Errore Spotify: ${error}`);
    try {
      const { data } = await axios.post(
        'https://accounts.spotify.com/api/token',
        new URLSearchParams({
          grant_type:   'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
          client_id:     CLIENT_ID,
          client_secret: CLIENT_SECRET,
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      saveTokens({
        access_token:  data.access_token,
        refresh_token: data.refresh_token,
        expires_at:    Date.now() / 1000 + data.expires_in - 60,
      });
      reply.redirect('/');
    } catch (e) {
      reply.status(400).send(`Errore token Spotify: ${e.message}`);
    }
  });

  // Token endpoint for the Web Playback SDK
  fastify.get('/api/token', async (req, reply) => {
    const token = await getAccessToken();
    if (!token) return reply.status(401).send({ error: 'not_authenticated' });
    reply.send({ access_token: token });
  });
}
