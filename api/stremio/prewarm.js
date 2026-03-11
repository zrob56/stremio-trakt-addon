import { Redis } from '@upstash/redis';
import { fetchWithRetry, resolveCacheNamespace, generateAndCacheAllGenres } from './handler.js';

const TRAKT_BASE = 'https://api.trakt.tv';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const GENRE_LABELS = {
  overall: null,
  action: 'Action', adventure: 'Adventure', animation: 'Animation',
  comedy: 'Comedy', crime: 'Crime', documentary: 'Documentary',
  drama: 'Drama', fantasy: 'Fantasy', horror: 'Horror',
  mystery: 'Mystery', romance: 'Romance', scifi: 'Science Fiction',
  thriller: 'Thriller', western: 'Western',
};

function getRedis() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  return new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
}

class TraktAuthError extends Error {
  constructor(msg) { super(msg); this.name = 'TraktAuthError'; }
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function traktHeaders(clientId, accessToken) {
  return {
    'Content-Type': 'application/json',
    'trakt-api-version': '2',
    'trakt-api-key': clientId || process.env.TRAKT_CLIENT_ID,
    'Authorization': `Bearer ${accessToken}`,
    'User-Agent': 'stremio-trakt-addon/1.0',
  };
}

async function traktFetch(url, headers) {
  const response = await fetchWithRetry(url, { headers });
  if (response.status === 401) throw new TraktAuthError('Token expired');
  if (!response.ok) throw new Error(`Trakt API error: ${response.status}`);
  return response.json();
}

async function mapConcurrent(items, concurrency, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = await Promise.all(items.slice(i, i + concurrency).map(fn));
    results.push(...batch);
  }
  return results;
}

async function refreshToken(config) {
  try {
    const response = await fetch(`${TRAKT_BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        refresh_token: config.refreshToken,
        client_id: config.clientId || process.env.TRAKT_CLIENT_ID,
        client_secret: config.clientSecret || process.env.TRAKT_CLIENT_SECRET || '',
        redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
        grant_type: 'refresh_token',
      }),
    });
    if (!response.ok) return null;
    const tokens = await response.json();
    return { ...config, accessToken: tokens.access_token, refreshToken: tokens.refresh_token };
  } catch {
    return null;
  }
}

async function saveRefreshedConfig(redis, uuid, newConfig) {
  if (!redis || !uuid) return;
  try {
    await redis.set(`user:${uuid}`, JSON.stringify(newConfig), { ex: 63072000 });
  } catch { /* non-fatal */ }
}

async function generateCatalog(config, mediaType, genreKey) {
  const isShow = mediaType === 'series';
  const headers = traktHeaders(config.clientId, config.accessToken);

  // Temperature cycles weekly: 0.7 → 0.8 → 0.9 → 1.0 → repeat
  const weekNum = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
  const temperature = [0.7, 0.8, 0.9, 1.0][weekNum % 4];

  const ratingsUrl = isShow
    ? `${TRAKT_BASE}/users/me/ratings/shows?limit=100&extended=full`
    : `${TRAKT_BASE}/users/me/ratings/movies?limit=100&extended=full`;
  const ratingsRaw = await traktFetch(ratingsUrl, headers);
  const getItem = r => isShow ? r.show : r.movie;
  const topRated = ratingsRaw
    .filter(r => r.rating >= 7)
    .map(r => ({ title: getItem(r).title, year: getItem(r).year }));
  const disliked = ratingsRaw
    .filter(r => r.rating <= 6)
    .slice(0, 20)
    .map(r => ({ title: getItem(r).title, year: getItem(r).year }));

  if (topRated.length === 0) return [];

  const watchedUrl = isShow
    ? `${TRAKT_BASE}/users/me/watched/shows?limit=100`
    : `${TRAKT_BASE}/users/me/watched/movies?limit=100`;
  let watchedTitles = [];
  try {
    const watchedRaw = await traktFetch(watchedUrl, headers);
    watchedTitles = watchedRaw.map(w => isShow ? w.show.title : w.movie.title);
  } catch { /* non-fatal */ }

  const ratedTitleSet = new Set([...topRated.map(t => t.title), ...disliked.map(d => d.title)]);
  const watchedNotRated = watchedTitles.filter(t => !ratedTitleSet.has(t)).slice(0, 40);

  const excluded = new Set(config.excludedFromFeed || []);
  const topRatedActive = topRated.filter(t => !excluded.has(t.title));
  const watchedNotRatedActive = watchedNotRated.filter(t => !excluded.has(t));

  const ratedList    = topRatedActive.slice(0, 25).map(m => m.title).join(', ') || 'None';
  const watchedList  = watchedNotRatedActive.slice(0, 20).join(', ') || 'None';
  const dislikedList = disliked.slice(0, 15).map(m => `${m.title} (${m.year})`).join(', ') || 'None';
  const mediaLabel   = isShow ? 'TV shows' : 'movies';
  const isGems       = genreKey === 'gems';
  const genreLabel   = (!isGems && GENRE_LABELS[genreKey]) || null;
  const genreClause  = genreLabel ? ` that are specifically in the ${genreLabel} genre` : '';
  const customClause = config.customInstructions?.trim()
    ? `\n\nAdditional instructions from the user: ${config.customInstructions.trim()}`
    : '';

  const excludedList = (config.excludedFromFeed || []).slice(0, 50).join(', ');
  const excludedClause = excludedList
    ? `\n\nAlso do not recommend any of these titles the user has excluded: ${excludedList}`
    : '';

  const prompt = isGems
    ? `You are a hidden gems ${mediaLabel} recommendation engine.\n\nLiked (7-10/10): ${ratedList}\n\nAlso watched (enjoyed): ${watchedList}\n\nDisliked (1-6/10): ${dislikedList}\n\nRecommend exactly 40 underrated, obscure, or cult classic ${mediaLabel} matching the user's taste — NOT mainstream blockbusters, franchises, or well-known Oscar winners. Do not recommend anything from the lists above.${customClause}${excludedClause}\nReturn ONLY a valid JSON array of 40 objects with title and year, no other text:\n[{"title": "Movie Name", "year": 2023}, ...]`
    : `You are a ${mediaLabel} recommendation engine.\n\nLiked (7-10/10): ${ratedList}\n\nAlso watched (enjoyed): ${watchedList}\n\nDisliked (1-6/10): ${dislikedList}\n\nRecommend exactly 40 ${mediaLabel}${genreClause} matching the user's taste. Do not recommend anything from the lists above.${customClause}${excludedClause}\nReturn ONLY a valid JSON array of 40 objects with title and year, no other text:\n[{"title": "Movie Name", "year": 2023}, ...]`;

  const geminiRes = await fetchWithRetry(`${GEMINI_BASE}?key=${config.geminiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature, responseMimeType: 'application/json' },
    }),
  });
  if (!geminiRes.ok) throw new Error(`Gemini error ${geminiRes.status}`);

  const geminiData = await geminiRes.json();
  let parsed;
  try {
    parsed = JSON.parse(geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '[]');
  } catch {
    return [];
  }

  const traktType = isShow ? 'show' : 'movie';
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
  const items = parsed.filter(item => item && typeof item.title === 'string' && item.year);
  const resolved = await mapConcurrent(items, 5, async item => {
    try {
      const r = await fetchWithRetry(`${TRAKT_BASE}/search/${traktType}?query=${encodeURIComponent(item.title)}&limit=5`, { headers });
      if (!r.ok) return null;
      const data = await r.json();
      if (!data?.length) return null;
      const q = norm(item.title);
      const exact = data.find(d => {
        const t = d[traktType];
        return t?.ids?.imdb && norm(t.title || '') === q && Math.abs((t.year || 0) - item.year) <= 1;
      });
      if (exact) return exact[traktType].ids.imdb;
      const top = data[0]?.[traktType];
      if (top?.ids?.imdb && Math.abs((top.year || 0) - item.year) <= 1) return top.ids.imdb;
      return null;
    } catch { return null; }
  });

  return resolved.filter(id => id && /^tt\d+$/.test(id));
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    setCors(res);
    return res.status(204).end();
  }
  setCors(res);
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const uuid  = url.searchParams.get('uuid');
  const type  = url.searchParams.get('type');   // 'movie' | 'show'
  const genre = url.searchParams.get('genre');  // 'action', 'overall', 'gems', etc.

  if (!uuid || !UUID_REGEX.test(uuid)) {
    return res.status(400).json({ error: 'Invalid uuid' });
  }
  if (!type || !['movie', 'show'].includes(type)) {
    return res.status(400).json({ error: 'Invalid type — must be movie or show' });
  }

  const redis = getRedis();
  if (!redis) {
    return res.status(503).json({ error: 'Redis not configured' });
  }

  // Validate UUID exists and has geminiKey
  let config;
  try {
    const raw = await redis.get(`user:${uuid}`);
    if (!raw) return res.status(404).json({ error: 'UUID not found' });
    config = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return res.status(500).json({ error: 'Failed to load config' });
  }

  if (!config.geminiKey) {
    return res.json({ status: 'skipped', reason: 'no geminiKey' });
  }

  const cacheNamespace = resolveCacheNamespace(config, uuid);
  if (!cacheNamespace) {
    return res.status(400).json({ error: 'Invalid cache namespace' });
  }

  // Batch mode: no genre param → warm all genres for this type in one Gemini call
  if (!genre) {
    const mediaType = type === 'show' ? 'series' : 'movie';
    const result = await generateAndCacheAllGenres(mediaType, config, redis, cacheNamespace);
    const total = Object.values(result).reduce((s, arr) => s + arr.length, 0);
    return res.json({ status: 'generated', genres: Object.keys(result).length, total });
  }

  const cacheKey = `ai:${cacheNamespace}:ai-${type}-${genre}`;

  // Return immediately if already cached
  try {
    const exists = await redis.exists(cacheKey);
    if (exists) return res.json({ status: 'cached' });
  } catch { /* non-fatal — proceed to generate */ }

  // Generate and cache
  try {
    const mediaType = type === 'show' ? 'series' : 'movie';
    const imdbIds = await generateCatalog(config, mediaType, genre);
    if (imdbIds.length > 0) {
      await redis.set(cacheKey, JSON.stringify(imdbIds), { ex: 2592000 });
    }
    return res.json({ status: 'generated', count: imdbIds.length });
  } catch (err) {
    console.error('prewarm error:', err.message);
    return res.json({ status: 'error', error: err.message });
  }
}
