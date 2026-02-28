import { Redis } from '@upstash/redis';

const TRAKT_BASE = 'https://api.trakt.tv';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

const AI_CATALOG_TTL = 2592000; // 30 days
const BUDGET_MS = 52000;       // stop generating after 52s (8s margin before 60s timeout)
const SLEEP_MS = 12500;        // 12.5s gap between Gemini calls → safe under 5 RPM

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
  const response = await fetch(url, { headers });
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isAiCatalog(id) {
  return (id.startsWith('ai-movie-') || id.startsWith('ai-show-')) &&
    id !== 'ai-search-movie' && id !== 'ai-search-series';
}

function parseCatalogId(id) {
  // "ai-movie-action" → { rawType: 'movie', genre: 'action' }
  // "ai-show-gems"    → { rawType: 'show',  genre: 'gems'   }
  const parts = id.split('-');
  const rawType = parts[1]; // 'movie' | 'show'
  const genre   = parts.slice(2).join('-');
  return { rawType, genre };
}

async function generateCatalogToCache(config, uuid, mediaType, genreKey, redis) {
  const isShow = mediaType === 'series';
  const headers = traktHeaders(config.clientId, config.accessToken);

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

  if (topRated.length === 0) return 0;

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
  const topRatedActive        = topRated.filter(t => !excluded.has(t.title));
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

  const prompt = isGems
    ? `You are a hidden gems ${mediaLabel} recommendation engine.\n\nLiked (7-10/10): ${ratedList}\n\nAlso watched (enjoyed): ${watchedList}\n\nDisliked (1-6/10): ${dislikedList}\n\nRecommend exactly 40 underrated, obscure, or cult classic ${mediaLabel} matching the user's taste — NOT mainstream blockbusters, franchises, or well-known Oscar winners. Do not recommend anything from the lists above.${customClause}\nReturn ONLY a valid JSON array of 40 objects with title and year, no other text:\n[{"title": "Movie Name", "year": 2023}, ...]`
    : `You are a ${mediaLabel} recommendation engine.\n\nLiked (7-10/10): ${ratedList}\n\nAlso watched (enjoyed): ${watchedList}\n\nDisliked (1-6/10): ${dislikedList}\n\nRecommend exactly 40 ${mediaLabel}${genreClause} matching the user's taste. Do not recommend anything from the lists above.${customClause}\nReturn ONLY a valid JSON array of 40 objects with title and year, no other text:\n[{"title": "Movie Name", "year": 2023}, ...]`;

  const geminiRes = await fetch(`${GEMINI_BASE}?key=${config.geminiKey}`, {
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
    return 0;
  }

  const traktType = isShow ? 'show' : 'movie';
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
  const items = parsed.filter(item => item && typeof item.title === 'string' && item.year);
  const resolved = await mapConcurrent(items, 5, async item => {
    try {
      const r = await fetch(`${TRAKT_BASE}/search/${traktType}?query=${encodeURIComponent(item.title)}&limit=5`, { headers });
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

  const imdbIds = resolved.filter(id => id && /^tt\d+$/.test(id));
  if (imdbIds.length > 0) {
    const cacheKey = `ai:${uuid}:ai-${mediaType === 'series' ? 'show' : 'movie'}-${genreKey}`;
    await redis.set(cacheKey, JSON.stringify(imdbIds), { ex: AI_CATALOG_TTL });
  }
  return imdbIds.length;
}

export default async function handler(req, res) {
  // Verify CRON_SECRET — Vercel sends it automatically; can also call manually
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization || '';
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const redis = getRedis();
  if (!redis) {
    return res.status(503).json({ error: 'Redis not configured' });
  }

  const startTime = Date.now();
  let processed = 0;
  let skipped = 0;
  let budgetExceeded = false;

  // Scan all user:* keys
  let cursor = 0;
  const uuids = [];
  do {
    const [nextCursor, keys] = await redis.scan(cursor, { match: 'user:*', count: 100 });
    for (const key of keys) {
      uuids.push(key.replace(/^user:/, ''));
    }
    cursor = parseInt(nextCursor, 10);
  } while (cursor !== 0);

  outer:
  for (const uuid of uuids) {
    let config;
    try {
      const raw = await redis.get(`user:${uuid}`);
      if (!raw) continue;
      config = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch { continue; }

    if (!config.geminiKey) continue;

    const aiCatalogs = (config.enabledCatalogs || []).filter(isAiCatalog);
    if (aiCatalogs.length === 0) continue;

    for (let i = 0; i < aiCatalogs.length; i++) {
      const catalogId = aiCatalogs[i];
      const { rawType, genre } = parseCatalogId(catalogId);
      const mediaType = rawType === 'show' ? 'series' : 'movie';
      const cacheKey  = `ai:${uuid}:ai-${rawType}-${genre}`;

      // Skip if cache was set within the last 23h (TTL still has >23h remaining out of 30d)
      try {
        const ttl = await redis.ttl(cacheKey);
        const ageSeconds = ttl >= 0 ? AI_CATALOG_TTL - ttl : AI_CATALOG_TTL;
        if (ageSeconds < 23 * 3600) { skipped++; continue; }
      } catch { skipped++; continue; }

      // Generate and cache
      try {
        await generateCatalogToCache(config, uuid, mediaType, genre, redis);
        processed++;
      } catch (err) {
        console.error(`pregenerate error ${uuid}/${catalogId}:`, err.message);
      }

      // Respect rate limit — sleep between calls (not after the last one overall)
      const isLast = i === aiCatalogs.length - 1;
      if (!isLast) await sleep(SLEEP_MS);

      // Check time budget
      if (Date.now() - startTime > BUDGET_MS) {
        budgetExceeded = true;
        break outer;
      }
    }
  }

  return res.json({
    processed,
    skipped,
    users: uuids.length,
    elapsed_ms: Date.now() - startTime,
    budget_exceeded: budgetExceeded,
  });
}
