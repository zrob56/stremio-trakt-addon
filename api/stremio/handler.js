import { Redis } from '@upstash/redis';

export const TRAKT_BASE = 'https://api.trakt.tv';

class TraktAuthError extends Error {
  constructor(msg) { super(msg); this.name = 'TraktAuthError'; }
}

// ── Config resolution (UUID → KV lookup) ──────────────────────

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getRedis() {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return null;
  return Redis.fromEnv();
}

async function resolveConfig(encoded) {
  if (!encoded) return { config: null, uuid: null };
  if (!UUID_REGEX.test(encoded)) return { config: null, uuid: null };
  const redis = getRedis();
  if (!redis) return { config: null, uuid: null };
  try {
    const raw = await redis.get(`user:${encoded}`);
    if (!raw) return { config: null, uuid: null };
    const config = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return { config, uuid: encoded };
  } catch {
    return { config: null, uuid: null };
  }
}

async function saveRefreshedConfig(uuid, newConfig) {
  if (!uuid) return;
  try {
    const redis = getRedis();
    if (!redis) return;
    await redis.set(`user:${uuid}`, JSON.stringify(newConfig), { ex: 63072000 });
  } catch { /* non-fatal — request already succeeded */ }
}

async function checkRateLimit(uuid) {
  const redis = getRedis();
  if (!redis) return false;
  const key = `rl:${uuid}:${Math.floor(Date.now() / 60000)}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 60);
  return count > 100;
}

async function mapConcurrent(items, concurrency, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = await Promise.all(items.slice(i, i + concurrency).map(fn));
    results.push(...batch);
  }
  return results;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function parseExtra(extraString) {
  if (!extraString) return {};
  const params = {};
  extraString.split('&').forEach(pair => {
    const [key, value] = pair.split('=');
    if (key && value !== undefined) params[key] = decodeURIComponent(value);
  });
  return params;
}

export function traktHeaders(clientId, accessToken) {
  return {
    'Content-Type': 'application/json',
    'trakt-api-version': '2',
    'trakt-api-key': clientId || process.env.TRAKT_CLIENT_ID,
    'Authorization': `Bearer ${accessToken}`,
    'User-Agent': 'stremio-trakt-addon/1.0',
  };
}

export async function traktFetch(url, headers) {
  const response = await fetch(url, { headers });
  if (response.status === 401) throw new TraktAuthError('Token expired');
  if (!response.ok) throw new Error(`Trakt API error: ${response.status}`);
  return response.json();
}

async function refreshToken(config) {
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
}

// ── Genre definitions ──────────────────────────────────────────

const GENRE_LABELS = {
  overall: null,
  action: 'Action', adventure: 'Adventure', animation: 'Animation',
  comedy: 'Comedy', crime: 'Crime', documentary: 'Documentary',
  drama: 'Drama', fantasy: 'Fantasy', horror: 'Horror',
  mystery: 'Mystery', romance: 'Romance', scifi: 'Science Fiction',
  thriller: 'Thriller', western: 'Western',
};

const MOVIE_GENRE_KEYS = ['overall','action','adventure','animation','comedy','crime','documentary','drama','fantasy','horror','mystery','romance','scifi','thriller','western'];
const SHOW_GENRE_KEYS  = ['overall','action','adventure','animation','comedy','crime','drama','fantasy','horror','mystery','romance','scifi','thriller'];

// ── Manifest ──────────────────────────────────────────────────

const AI_CATALOG_DEFS = [
  ...MOVIE_GENRE_KEYS.map(g => ({
    type: 'movie', id: `ai-movie-${g}`, extra: [{ name: 'skip', isRequired: false }],
    name: g === 'overall' ? 'Movie Picks' : `${GENRE_LABELS[g]}`,
  })),
  ...SHOW_GENRE_KEYS.map(g => ({
    type: 'series', id: `ai-show-${g}`, extra: [{ name: 'skip', isRequired: false }],
    name: g === 'overall' ? 'Show Picks' : `${GENRE_LABELS[g]}`,
  })),
  { type: 'movie',  id: 'ai-movie-gems',    extra: [{ name: 'skip', isRequired: false }],     name: 'Hidden Gem Movies' },
  { type: 'series', id: 'ai-show-gems',     extra: [{ name: 'skip', isRequired: false }],     name: 'Hidden Gem Shows'  },
  { type: 'movie',  id: 'ai-search-movie',  extra: [{ name: 'search', isRequired: false }],   name: 'AI Movie Search'   },
  { type: 'series', id: 'ai-search-series', extra: [{ name: 'search', isRequired: false }],   name: 'AI Show Search'    },
];

const ALL_CATALOG_DEFS = [
  { type: 'movie',  id: 'trakt-watchlist',          name: 'Your Watchlist',            extra: [{ name: 'skip', isRequired: false }] },
  { type: 'movie',  id: 'trakt-trending',            name: 'Trending on Trakt',         extra: [{ name: 'skip', isRequired: false }] },
  { type: 'movie',  id: 'trakt-popular',             name: 'Popular Movies',            extra: [{ name: 'skip', isRequired: false }] },
  { type: 'movie',  id: 'trakt-anticipated',         name: 'Most Anticipated Movies',   extra: [{ name: 'skip', isRequired: false }] },
  { type: 'movie',  id: 'trakt-boxoffice',           name: 'Box Office',                extra: [] },
  { type: 'movie',  id: 'trakt-recommended',         name: 'Trakt Picks For You',       extra: [{ name: 'skip', isRequired: false }] },
  { type: 'series', id: 'trakt-watchlist-shows',     name: 'Your Show Watchlist',       extra: [{ name: 'skip', isRequired: false }] },
  { type: 'series', id: 'trakt-trending-shows',      name: 'Trending Shows on Trakt',   extra: [{ name: 'skip', isRequired: false }] },
  { type: 'series', id: 'trakt-popular-shows',       name: 'Popular Shows',             extra: [{ name: 'skip', isRequired: false }] },
  { type: 'series', id: 'trakt-anticipated-shows',   name: 'Most Anticipated Shows',    extra: [{ name: 'skip', isRequired: false }] },
  { type: 'series', id: 'trakt-recommended-shows',   name: 'Trakt Show Picks',          extra: [{ name: 'skip', isRequired: false }] },
  ...AI_CATALOG_DEFS,
];

function handleManifest(config, res) {
  let catalogs;

  // Build lookup for user's Trakt list metadata
  const listMeta = {};
  for (const l of (config?.traktLists || [])) {
    listMeta[`trakt-list-${l.slug}`] = l.name;
  }

  if (config?.enabledCatalogs?.length) {
    catalogs = config.enabledCatalogs.flatMap(id => {
      if (listMeta[id]) {
        const name = listMeta[id];
        return [
          { type: 'movie',  id: `${id}-movies`, name: `${name} (Movies)`, extra: [{ name: 'skip', isRequired: false }] },
          { type: 'series', id: `${id}-shows`,  name: `${name} (Shows)`,  extra: [{ name: 'skip', isRequired: false }] },
        ];
      }
      const def = ALL_CATALOG_DEFS.find(c => c.id === id);
      return def ? [def] : [];
    });
  } else {
    // Backward compat: utility catalogs + AI overall if gemini key present
    catalogs = ALL_CATALOG_DEFS.filter(c =>
      ['trakt-watchlist','trakt-trending','trakt-watchlist-shows','trakt-trending-shows'].includes(c.id) ||
      (config?.geminiKey && ['ai-movie-overall','ai-show-overall'].includes(c.id))
    );
  }

  // Always append AI search catalogs when Gemini key is configured
  if (config?.geminiKey) {
    for (const id of ['ai-search-movie', 'ai-search-series']) {
      if (!catalogs.some(c => c.id === id)) {
        const def = ALL_CATALOG_DEFS.find(c => c.id === id);
        if (def) catalogs.push(def);
      }
    }
  }

  return res.json({
    id: 'com.zachr.trakt.recommendations',
    version: '2.0.0',
    name: 'Trakt Recommendations',
    description: 'AI-powered movie & show recommendations by genre, powered by your Trakt history.',
    logo: 'https://www.cnet.com/a/img/resize/0e9874cc9d6b18489f832793796d285141496106/hub/2021/10/16/11804578-0dbc-42af-bcd1-3bc7b1394962/the-batman-2022-teaser-poster-batman-01-promo.jpg?auto=webp&fit=bounds&height=900&precrop=1881,1411,x423,y0&width=1200',
    resources: ['catalog', 'meta'],
    types: ['movie', 'series'],
    catalogs,
    behaviorHints: { configurable: true },
    idPrefixes: ['tt'],
  });
}

// ── AI Catalog ────────────────────────────────────────────────

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const RPDB_FREE_KEY = 't0-free-rpdb';
function rpdbPoster(imdbId) {
  return `https://api.ratingposterdb.com/${RPDB_FREE_KEY}/imdb/poster-default/${imdbId}.jpg`;
}

async function handleAICatalog(config, mediaType, genreKey, skip, res, uuid = null) {
  const redis = uuid ? getRedis() : null;
  const cacheKey = uuid ? `ai:${uuid}:ai-${mediaType === 'series' ? 'show' : 'movie'}-${genreKey}` : null;
  if (redis && cacheKey) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const data = typeof cached === 'string' ? JSON.parse(cached) : cached;
        // Normalize: old format is object[], new format is string[]
        const ids = (data.length > 0 && typeof data[0] !== 'string')
          ? data.map(m => m.id).filter(Boolean)
          : data;
        const page = ids.slice(skip, skip + 40);
        return res.json({ metas: page.map(id => ({ id, type: mediaType, poster: rpdbPoster(id) })) });
      }
    } catch { /* non-fatal */ }
  }

  // Don't call Gemini for non-first pages when cache is cold
  if (skip > 0) return res.json({ metas: [] });

  const headers = traktHeaders(config.clientId, config.accessToken);
  const isShow = mediaType === 'series';

  // Temperature cycles weekly: 0.7 → 0.8 → 0.9 → 1.0 → repeat
  const weekNum = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
  const temperature = [0.7, 0.8, 0.9, 1.0][weekNum % 4];

  // Fetch all ratings at once, split into liked (≥7) and disliked (≤6)
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

  if (topRated.length === 0) return res.json({ metas: [] });

  // Fetch watched history — used as both positive signal and exclusion list
  const watchedUrl = isShow
    ? `${TRAKT_BASE}/users/me/watched/shows?limit=100`
    : `${TRAKT_BASE}/users/me/watched/movies?limit=100`;
  let watchedTitles = [];
  try {
    const watchedRaw = await traktFetch(watchedUrl, headers);
    watchedTitles = watchedRaw.map(w => isShow ? w.show.title : w.movie.title);
  } catch { /* non-fatal */ }

  // Watched-but-not-rated = secondary positive signal (user watched it, implied interest)
  const ratedTitleSet = new Set([...topRated.map(t => t.title), ...disliked.map(d => d.title)]);
  const watchedNotRated = watchedTitles.filter(t => !ratedTitleSet.has(t)).slice(0, 40);

  // Filter user-excluded titles from positive signal (still kept in allSeenList so they won't be recommended)
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

  // Call Gemini
  const geminiRes = await fetch(`${GEMINI_BASE}?key=${config.geminiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature, responseMimeType: 'application/json' } }),
  });
  if (!geminiRes.ok) return res.json({ metas: [] });

  const geminiData = await geminiRes.json();

  let parsed;
  try {
    parsed = JSON.parse(geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '[]');
  } catch {
    return res.json({ metas: [] });
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
      // Tier 1: normalized exact title + year within 1
      const exact = data.find(d => {
        const t = d[traktType];
        return t?.ids?.imdb && norm(t.title || '') === q && Math.abs((t.year || 0) - item.year) <= 1;
      });
      if (exact) return exact[traktType].ids.imdb;
      // Tier 2: top result if year within 1
      const top = data[0]?.[traktType];
      if (top?.ids?.imdb && Math.abs((top.year || 0) - item.year) <= 1) return top.ids.imdb;
      return null;
    } catch { return null; }
  });
  const imdbIds = resolved.filter(id => id && /^tt\d+$/.test(id));

  if (redis && cacheKey && imdbIds.length > 0) {
    try { await redis.set(cacheKey, JSON.stringify(imdbIds), { ex: 172800 }); } catch { /* non-fatal */ }
  }

  res.setHeader('Cache-Control', 'public, max-age=14400, s-maxage=86400, stale-while-revalidate=604800');
  return res.json({ metas: imdbIds.slice(0, 40).map(id => ({ id, type: mediaType, poster: rpdbPoster(id) })) });
}

// ── AI Search ─────────────────────────────────────────────────

async function handleAISearch(config, mediaType, query, res, uuid = null) {
  if (!query?.trim()) return res.json({ metas: [] });

  const redis = uuid ? getRedis() : null;
  const cacheKey = uuid ? `ai-search:${uuid}:${query.trim().toLowerCase()}` : null;
  if (redis && cacheKey) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const data = typeof cached === 'string' ? JSON.parse(cached) : cached;
        // Normalize: old format is object[], new format is string[]
        const ids = (data.length > 0 && typeof data[0] !== 'string')
          ? data.map(m => m.id).filter(Boolean)
          : data;
        return res.json({ metas: ids.map(id => ({ id, type: mediaType, poster: rpdbPoster(id) })) });
      }
    } catch { /* non-fatal */ }
  }

  const isShow = mediaType === 'series';
  const mediaLabel = isShow ? 'TV shows' : 'movies';
  const traktType = isShow ? 'show' : 'movie';
  const headers = traktHeaders(config.clientId, config.accessToken);

  const prompt = `You are a ${mediaLabel} search engine that understands natural language queries.\n\nThe user searched for: "${query.trim()}"\n\nReturn exactly 10 ${mediaLabel} that best match this search. Interpret the query broadly — include titles, themes, time periods, styles, and subgenres that fit.\n\nReturn ONLY a valid JSON array of 10 objects with title and year, no other text:\n[{"title": "Movie Name", "year": 2023}, ...]`;

  const geminiRes = await fetch(`${GEMINI_BASE}?key=${config.geminiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.7, responseMimeType: 'application/json' } }),
  });
  if (!geminiRes.ok) return res.json({ metas: [] });

  const geminiData = await geminiRes.json();

  let parsed;
  try {
    parsed = JSON.parse(geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '[]');
  } catch {
    return res.json({ metas: [] });
  }

  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
  const items = parsed.filter(item => item && typeof item.title === 'string' && item.year);
  const resolved = await mapConcurrent(items, 5, async item => {
    try {
      const r = await fetch(`${TRAKT_BASE}/search/${traktType}?query=${encodeURIComponent(item.title)}&limit=5`, { headers });
      if (!r.ok) return null;
      const data = await r.json();
      if (!data?.length) return null;
      const q = norm(item.title);
      // Tier 1: normalized exact title + year within 1
      const exact = data.find(d => {
        const t = d[traktType];
        return t?.ids?.imdb && norm(t.title || '') === q && Math.abs((t.year || 0) - item.year) <= 1;
      });
      if (exact) return exact[traktType].ids.imdb;
      // Tier 2: top result if year within 1
      const top = data[0]?.[traktType];
      if (top?.ids?.imdb && Math.abs((top.year || 0) - item.year) <= 1) return top.ids.imdb;
      return null;
    } catch { return null; }
  });
  const imdbIds = resolved.filter(id => id && /^tt\d+$/.test(id));

  if (redis && cacheKey && imdbIds.length > 0) {
    try { await redis.set(cacheKey, JSON.stringify(imdbIds), { ex: 3600 }); } catch { /* non-fatal */ }
  }

  res.setHeader('Cache-Control', 'public, max-age=14400, s-maxage=86400, stale-while-revalidate=604800');
  return res.json({ metas: imdbIds.map(id => ({ id, type: mediaType, poster: rpdbPoster(id) })) });
}

// ── Meta ──────────────────────────────────────────────────────

async function handleMeta(config, type, id, res) {
  const imdbId = id;
  const traktType = type === 'series' ? 'show' : 'movie';

  // Check Redis cache
  const redis = getRedis();
  const cacheKey = `meta:${imdbId}:${traktType}`;
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        res.setHeader('Cache-Control', 'public, s-maxage=604800');
        return res.json({ meta: typeof cached === 'string' ? JSON.parse(cached) : cached });
      }
    } catch { /* non-fatal */ }
  }

  const headers = traktHeaders(config.clientId, config.accessToken);

  // Look up by IMDB ID to get Trakt slug
  let slug;
  try {
    const searchRes = await fetch(`${TRAKT_BASE}/search/imdb/${imdbId}?type=${traktType}`, { headers });
    if (!searchRes.ok) return res.json({ meta: null });
    const searchData = await searchRes.json();
    if (!searchData?.length) return res.json({ meta: null });
    slug = searchData[0][traktType]?.ids?.slug;
    if (!slug) return res.json({ meta: null });
  } catch {
    return res.json({ meta: null });
  }

  // Parallel: detail + people
  let detail, peopleData;
  try {
    const [detailRes, peopleRes] = await Promise.all([
      fetch(`${TRAKT_BASE}/${traktType}s/${slug}?extended=full`, { headers }),
      fetch(`${TRAKT_BASE}/${traktType}s/${slug}/people`, { headers }),
    ]);
    detail = detailRes.ok ? await detailRes.json() : null;
    peopleData = peopleRes.ok ? await peopleRes.json() : null;
  } catch {
    return res.json({ meta: null });
  }

  if (!detail) return res.json({ meta: null });

  const cast = (peopleData?.cast || []).slice(0, 5).map(c => c.person?.name).filter(Boolean);
  const directors = (peopleData?.crew?.directing || [])
    .filter(c => c.jobs?.includes('Director'))
    .slice(0, 2)
    .map(c => c.person?.name)
    .filter(Boolean);

  // Extract YouTube trailer ID if present
  let trailers;
  if (detail.trailer) {
    const ytMatch = detail.trailer.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\s]+)/);
    if (ytMatch) trailers = [{ source: 'yt', key: ytMatch[1] }];
  }

  const meta = {
    id: imdbId,
    type,
    name: detail.title,
    description: detail.overview || undefined,
    releaseInfo: detail.year ? String(detail.year) : undefined,
    imdbRating: detail.rating ? detail.rating.toFixed(1) : undefined,
    poster: rpdbPoster(imdbId),
    genres: detail.genres || undefined,
    cast: cast.length > 0 ? cast : undefined,
    ...(traktType === 'movie' && directors.length > 0 ? { director: directors } : {}),
    ...(traktType === 'movie' && detail.runtime ? { runtime: `${detail.runtime} min` } : {}),
    ...(trailers ? { trailers } : {}),
  };

  if (redis) {
    try { await redis.set(cacheKey, JSON.stringify(meta), { ex: 604800 }); } catch { /* non-fatal */ }
  }

  res.setHeader('Cache-Control', 'public, s-maxage=604800');
  return res.json({ meta });
}

// ── Catalog ───────────────────────────────────────────────────

async function handleCatalog(config, type, id, extra, res, uuid = null) {
  const params = parseExtra(extra);
  const page = Math.floor((parseInt(params.skip) || 0) / 20) + 1;
  const headers = traktHeaders(config.clientId, config.accessToken);

  let traktData;
  let itemType = type;

  switch (id) {
    case 'trakt-watchlist': {
      const raw = await traktFetch(
        `${TRAKT_BASE}/sync/watchlist/movies?sort=added&limit=20&page=${page}&extended=full`, headers
      );
      traktData = raw.map(item => item.movie);
      break;
    }
    case 'trakt-trending': {
      const raw = await traktFetch(
        `${TRAKT_BASE}/movies/trending?limit=20&page=${page}&extended=full`, headers
      );
      traktData = raw.map(item => item.movie);
      break;
    }
    case 'trakt-popular': {
      traktData = await traktFetch(
        `${TRAKT_BASE}/movies/popular?limit=20&page=${page}&extended=full`, headers
      );
      break;
    }
    case 'trakt-anticipated': {
      const raw = await traktFetch(
        `${TRAKT_BASE}/movies/anticipated?limit=20&page=${page}&extended=full`, headers
      );
      traktData = raw.map(item => item.movie);
      break;
    }
    case 'trakt-boxoffice': {
      const raw = await traktFetch(
        `${TRAKT_BASE}/movies/boxoffice?extended=full`, headers
      );
      traktData = raw.map(item => item.movie);
      break;
    }
    case 'trakt-recommended': {
      traktData = await traktFetch(
        `${TRAKT_BASE}/recommendations/movies?limit=20&extended=full`, headers
      );
      break;
    }
    case 'trakt-watchlist-shows': {
      const raw = await traktFetch(
        `${TRAKT_BASE}/sync/watchlist/shows?sort=added&limit=20&page=${page}&extended=full`, headers
      );
      traktData = raw.map(item => item.show);
      itemType = 'series';
      break;
    }
    case 'trakt-trending-shows': {
      const raw = await traktFetch(
        `${TRAKT_BASE}/shows/trending?limit=20&page=${page}&extended=full`, headers
      );
      traktData = raw.map(item => item.show);
      itemType = 'series';
      break;
    }
    case 'trakt-popular-shows': {
      traktData = await traktFetch(
        `${TRAKT_BASE}/shows/popular?limit=20&page=${page}&extended=full`, headers
      );
      itemType = 'series';
      break;
    }
    case 'trakt-anticipated-shows': {
      const raw = await traktFetch(
        `${TRAKT_BASE}/shows/anticipated?limit=20&page=${page}&extended=full`, headers
      );
      traktData = raw.map(item => item.show);
      itemType = 'series';
      break;
    }
    case 'trakt-recommended-shows': {
      traktData = await traktFetch(
        `${TRAKT_BASE}/recommendations/shows?limit=20&extended=full`, headers
      );
      itemType = 'series';
      break;
    }
    default: {
      if (id.startsWith('trakt-list-')) {
        const suffix = id.replace(/^trakt-list-/, '');
        const isMovies = suffix.endsWith('-movies');
        const slug = isMovies
          ? suffix.replace(/-movies$/, '')
          : suffix.replace(/-shows$/, '');
        const traktMediaType = isMovies ? 'movies' : 'shows';
        itemType = isMovies ? 'movie' : 'series';
        const raw = await traktFetch(
          `${TRAKT_BASE}/users/me/lists/${slug}/items/${traktMediaType}?extended=full&page=${page}&limit=20`,
          headers
        );
        traktData = raw.map(item => item.movie || item.show);
        break;
      }
      if (id.startsWith('ai-') && config.geminiKey) {
        const cacheId = config.traktUsername || uuid;
        if (id === 'ai-search-movie')  return handleAISearch(config, 'movie',  params.search, res, cacheId);
        if (id === 'ai-search-series') return handleAISearch(config, 'series', params.search, res, cacheId);
        const parts = id.split('-');
        const aiMediaType = parts[1] === 'show' ? 'series' : parts[1];
        const genreKey = parts[2] || 'overall';
        const skip = parseInt(params.skip) || 0;
        return await handleAICatalog(config, aiMediaType, genreKey, skip, res, cacheId);
      }
      return res.json({ metas: [] });
    }
  }

  const metas = (traktData || [])
    .filter(item => item && item.ids && item.ids.imdb)
    .map(item => ({
      id: item.ids.imdb,
      type: itemType,
      name: item.title,
      poster: rpdbPoster(item.ids.imdb),
      releaseInfo: item.year ? String(item.year) : undefined,
      description: item.overview || undefined,
      imdbRating: item.rating ? item.rating.toFixed(1) : undefined,
      genres: item.genres || undefined,
    }));

  res.setHeader('Cache-Control', 'public, max-age=14400, s-maxage=86400, stale-while-revalidate=604800');
  return res.json({ metas });
}

// ── Main Handler ──────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    setCors(res);
    return res.status(204).end();
  }
  setCors(res);
  res.setHeader('Content-Type', 'application/json');

  const url = new URL(req.url, `http://${req.headers.host}`);
  const configEncoded = url.searchParams.get('config');
  const resource = url.searchParams.get('resource');
  const type = url.searchParams.get('type');
  const id = url.searchParams.get('id');
  const extra = url.searchParams.get('extra');

  const { config, uuid } = await resolveConfig(configEncoded);

  if (resource === 'manifest') return handleManifest(config, res);

  if (uuid) {
    const limited = await checkRateLimit(uuid);
    if (limited) return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  if (!config || !config.accessToken || (!config.clientId && !process.env.TRAKT_CLIENT_ID)) {
    return res.status(400).json({ metas: [] });
  }

  if (resource === 'catalog') {
    try {
      return await handleCatalog(config, type, id, extra, res, uuid);
    } catch (err) {
      if (err instanceof TraktAuthError && config.refreshToken) {
        const newConfig = await refreshToken(config);
        if (newConfig) {
          // Persist the new tokens so subsequent requests don't loop on refresh
          await saveRefreshedConfig(uuid, newConfig);
          try {
            return await handleCatalog(newConfig, type, id, extra, res, uuid);
          } catch {
            return res.json({ metas: [] });
          }
        }
      }
      return res.json({ metas: [] });
    }
  }

  if (resource === 'meta') {
    try {
      return await handleMeta(config, type, id, res);
    } catch {
      return res.json({ meta: null });
    }
  }

  return res.status(404).json({ error: 'Not found' });
}
