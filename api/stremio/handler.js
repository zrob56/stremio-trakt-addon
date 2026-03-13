import { TRAKT_BASE, UUID_REGEX, TraktAuthError, getRedis, setCors,
         traktHeaders, traktFetch, sleep, mapConcurrent, fetchWithRetry } from './utils.js';

export { TRAKT_BASE, traktHeaders, traktFetch, fetchWithRetry } from './utils.js';

async function resolveConfig(encoded) {
  if (!encoded) return { config: null, uuid: null };
  if (!UUID_REGEX.test(encoded)) {
    try {
      const decoded = Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      return { config: JSON.parse(decoded), uuid: null };
    } catch {
      return { config: null, uuid: null };
    }
  }
  const redis = getRedis();
  if (!redis) return { config: null, uuid: null };
  try {
    const raw = await redis.get(`user:${encoded}`);
    if (!raw) return { config: null, uuid: null };
    const config = typeof raw === 'string' ? JSON.parse(raw) : raw;
    redis.expire(`user:${encoded}`, 63072000).catch(() => {}); // sliding 2-year TTL
    return { config, uuid: encoded };
  } catch {
    return { config: null, uuid: null };
  }
}


export function resolveCacheNamespace(config, uuid) {
  return config?.traktUsername || uuid || null;
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


function parseExtra(extraString, searchParams = null) {
  if (!extraString && !searchParams) return {};
  const params = {};
  if (extraString) {
    extraString.split('&').forEach(pair => {
      const [key, value] = pair.split('=');
      if (key && value !== undefined) params[key] = decodeURIComponent(value);
    });
  }
  if (searchParams) {
    for (const key of ['skip', 'search', 'genre']) {
      if (params[key] === undefined && searchParams.has(key)) {
        params[key] = searchParams.get(key);
      }
    }
  }
  return params;
}


export async function refreshToken(config, uuid) {
  const redis = getRedis();
  const lockKey = uuid ? `refresh-lock:${uuid}` : null;

  if (redis && lockKey) {
    const acquired = await redis.set(lockKey, '1', { nx: true, ex: 10 });
    if (!acquired) {
      await new Promise(r => setTimeout(r, 2000));
      const { config: newConfig } = await resolveConfig(uuid);
      return newConfig;
    }
  }

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
  } finally {
    if (redis && lockKey) await redis.del(lockKey).catch(() => {});
  }
}

// ── Genre definitions ──────────────────────────────────────────

const GENRE_LABELS = {
  overall: null,
  action: 'Action', adventure: 'Adventure', animation: 'Animation',
  comedy: 'Comedy', crime: 'Crime', documentary: 'Documentary',
  drama: 'Drama', fantasy: 'Fantasy', horror: 'Horror',
  mystery: 'Mystery', romance: 'Romance', scifi: 'Science Fiction',
  thriller: 'Thriller', western: 'Western',
  bingeable: 'Binge-worthy',
};

const MOVIE_GENRE_KEYS = ['overall','action','adventure','animation','comedy','crime','documentary','drama','fantasy','horror','mystery','romance','scifi','thriller','western'];
const SHOW_GENRE_KEYS  = ['overall','action','adventure','animation','comedy','crime','drama','fantasy','horror','mystery','romance','scifi','thriller'];

const ALL_MOVIE_GENRE_KEYS = [...MOVIE_GENRE_KEYS, 'gems'];
const ALL_SHOW_GENRE_KEYS  = [...SHOW_GENRE_KEYS,  'gems', 'bingeable'];

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
  { type: 'movie',  id: 'ai-movie-gems',      extra: [{ name: 'skip', isRequired: false }],   name: 'Hidden Gem Movies'  },
  { type: 'series', id: 'ai-show-gems',      extra: [{ name: 'skip', isRequired: false }],   name: 'Hidden Gem Shows'   },
  { type: 'series', id: 'ai-show-bingeable', extra: [{ name: 'skip', isRequired: false }],   name: 'Binge-worthy Shows' },
  { type: 'movie',  id: 'ai-search-movie',  extra: [{ name: 'search', isRequired: true }],    name: 'AI Movie Search'   },
  { type: 'series', id: 'ai-search-series', extra: [{ name: 'search', isRequired: true }],    name: 'AI Show Search'    },
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
  const hasGemini = !!config?.geminiKey;

  // Build lookup for user's Trakt list metadata
  const listMeta = {};
  for (const l of (config?.traktLists || [])) {
    listMeta[`trakt-list-${l.slug}`] = l.name;
  }

  const defaultCatalogs = ALL_CATALOG_DEFS.filter(c =>
    ['trakt-watchlist','trakt-trending','trakt-watchlist-shows','trakt-trending-shows'].includes(c.id) ||
    (hasGemini && ['ai-movie-overall','ai-show-overall'].includes(c.id))
  );

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
      if (!def) return [];
      if (def.id.startsWith('ai-') && !hasGemini) return [];
      return [def];
    });
    catalogs = catalogs.filter(Boolean);
    if (catalogs.length === 0) catalogs = defaultCatalogs;
  } else {
    // Backward compat: utility catalogs + AI overall if gemini key present
    catalogs = defaultCatalogs;
  }

  // Always append AI search catalogs when Gemini key is configured
  if (hasGemini) {
    for (const id of ['ai-search-movie', 'ai-search-series']) {
      if (!catalogs.some(c => c.id === id)) {
        const def = ALL_CATALOG_DEFS.find(c => c.id === id);
        if (def) catalogs.push(def);
      }
    }
  }

  return res.json({
    id: 'com.zachr.trakt.recommendations',
    version: '2.0.1',
    name: 'Trakt Recommendations',
    description: 'AI-powered movie & show recommendations by genre, powered by your Trakt history.',
    logo: 'https://www.cnet.com/a/img/resize/0e9874cc9d6b18489f832793796d285141496106/hub/2021/10/16/11804578-0dbc-42af-bcd1-3bc7b1394962/the-batman-2022-teaser-poster-batman-01-promo.jpg?auto=webp&fit=bounds&height=900&precrop=1881,1411,x423,y0&width=1200',
    resources: ['catalog'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs,
    behaviorHints: { configurable: true },
  });
}

// ── AI Catalog ────────────────────────────────────────────────

export const GEMINI_CATALOG_MODEL = 'gemini-3.1-flash-lite-preview';
export const GEMINI_SEARCH_MODEL  = 'gemini-3.1-flash-lite-preview';
export const GEMINI_CATALOG_BASE = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_CATALOG_MODEL}:generateContent`;
const GEMINI_SEARCH_BASE  = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_SEARCH_MODEL}:generateContent`;

// Fetch Trakt history for the given media type and return formatted lists.
async function fetchTraktHistory(config, isShow) {
  const headers = traktHeaders(config.clientId, config.accessToken);
  const ratingsUrl = isShow
    ? `${TRAKT_BASE}/users/me/ratings/shows?limit=100&extended=full`
    : `${TRAKT_BASE}/users/me/ratings/movies?limit=100&extended=full`;
  const ratingsRaw = await traktFetch(ratingsUrl, headers);
  const getItem = r => isShow ? r.show : r.movie;
  const topRated = ratingsRaw
    .filter(r => r.rating >= 7)
    .map(r => ({ title: getItem(r).title, year: getItem(r).year, rating: r.rating }));
  const disliked = ratingsRaw
    .filter(r => r.rating <= 6)
    .slice(0, 30)
    .map(r => ({ title: getItem(r).title, year: getItem(r).year, rating: r.rating }));

  const watchedUrl = isShow
    ? `${TRAKT_BASE}/users/me/watched/shows?limit=500`
    : `${TRAKT_BASE}/users/me/watched/movies?limit=500`;
  let watchedTitles = [];
  try {
    const watchedRaw = await traktFetch(watchedUrl, headers);
    watchedTitles = watchedRaw
      .filter(w => !isShow || w.plays > 5)
      .map(w => isShow ? w.show.title : w.movie.title);
  } catch { /* non-fatal */ }

  const ratedTitleSet = new Set([...topRated.map(t => t.title), ...disliked.map(d => d.title)]);
  const watchedNotRated = watchedTitles.filter(t => !ratedTitleSet.has(t)).slice(0, 60);

  const excluded = new Set(config.excludedFromFeed || []);
  const topRatedActive        = topRated.filter(t => !excluded.has(t.title));
  const watchedNotRatedActive = watchedNotRated.filter(t => !excluded.has(t));

  return {
    headers,
    topRated,
    disliked,
    topRatedActive,
    watchedNotRatedActive,
    watchedTitles,
  };
}

// Make ONE Gemini call covering ALL genre keys for the given media type.
// Parses the JSON object response, resolves IMDB IDs for each genre, writes
// each genre to its own cache key, and returns a { genre: imdbIds[] } map.
export async function generateAndCacheAllGenres(mediaType, config, redis, cacheNamespace) {
  const isShow = mediaType === 'series';
  const weekNum = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
  const temperature = [0.7, 0.8, 0.9, 1.0][weekNum % 4];

  let history;
  try {
    history = await fetchTraktHistory(config, isShow);
  } catch (err) {
    console.error('[generateAndCacheAllGenres] Trakt history fetch failed:', err.message);
    return {};
  }
  const { headers, topRatedActive, watchedNotRatedActive, disliked, watchedTitles } = history;

  const allRatedTitles = [...history.topRated.map(t => t.title), ...history.disliked.map(t => t.title)];
  const allWatchedSet = new Set([...allRatedTitles, ...watchedTitles]);
  const alreadyWatchedList = [...allWatchedSet].slice(0, 500).join(', ');
  if (history.topRated.length === 0) {
    console.error('[generateAndCacheAllGenres] No top-rated items found, skipping');
    return {};
  }

  const ratedList    = topRatedActive.slice(0, 40)
    .map(m => `${m.title} (${m.year}) [${m.rating}/10]`).join(', ') || 'None';
  const watchedList  = watchedNotRatedActive.slice(0, 35).join(', ') || 'None';
  const dislikedList = disliked.slice(0, 25)
    .map(m => `${m.title} (${m.year}) [${m.rating}/10]`).join(', ') || 'None';
  const mediaLabel   = isShow ? 'TV shows' : 'movies';
  const customClause = config.customInstructions?.trim()
    ? `\n\nAdditional instructions from the user: ${config.customInstructions.trim()}`
    : '';

  const genreKeys = isShow ? ALL_SHOW_GENRE_KEYS : ALL_MOVIE_GENRE_KEYS;
  const categoryRules = genreKeys.map(k => {
    if (k === 'overall')   return `- overall: best matches for the user's taste, any genre`;
    if (k === 'gems')      return `- gems: underrated, obscure, or cult classics — NOT mainstream blockbusters or well-known franchises`;
    if (k === 'bingeable') return `- bingeable: series designed for binge-watching — short seasons (6–10 episodes), strong episode-to-episode hooks, high completion rates — NOT long-running procedurals, soap operas, or shows with 20+ episode seasons`;
    if (k === 'documentary') return `- documentary: documentaries, docuseries, true crime, investigative journalism, and nature/science docs — broad factual content including crime investigations, exposés, and real-event storytelling`;
    if (k === 'comedy' && isShow) return `- comedy: scripted comedy series, sitcoms, and comedy talk shows — NOT generic interview shows, variety shows, or sketch shows`;
    return `- ${k}: specifically ${GENRE_LABELS[k]} genre`;
  }).join('\n');

  const excludedList = (config.excludedFromFeed || []).slice(0, 50).join(', ');
  const excludedClause = excludedList
    ? `\n\nAlso do not recommend any of these titles the user has excluded: ${excludedList}`
    : '';
  const alreadyWatchedClause = alreadyWatchedList
    ? `\n\nDo NOT recommend any of these — the user has already watched them: ${alreadyWatchedList}`
    : '';

  const batchSize = isShow ? 80 : 60;
  const prompt = `You are a ${mediaLabel} recommendation engine.\n\nLiked: ${ratedList}\n\nAlso watched (no rating): ${watchedList}\n\nDisliked: ${dislikedList}\n\nRecommend exactly ${batchSize} ${mediaLabel} for EACH of the following categories. Do not recommend anything from the lists above.${customClause}${excludedClause}${alreadyWatchedClause}\n\nCategories and their rules:\n${categoryRules}\n\nReturn ONLY a valid JSON object where each key is a category and the value is an array of ${batchSize} objects with title and year. No other text:\n{"overall": [{"title": "...", "year": 2023}, ...], ...}`;

  const geminiRes = await fetchWithRetry(`${GEMINI_CATALOG_BASE}?key=${config.geminiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature, responseMimeType: 'application/json' },
    }),
  });
  if (!geminiRes.ok) {
    const errText = await geminiRes.text().catch(() => '');
    console.error(`[generateAndCacheAllGenres] Gemini error ${geminiRes.status}:`, errText.slice(0, 300));
    return {};
  }

  const geminiData = await geminiRes.json();
  let parsed;
  try {
    const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const objMatch = rawText.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(objMatch ? objMatch[0] : '{}');
  } catch (err) {
    console.error('[generateAndCacheAllGenres] JSON parse failed:', err.message);
    return {};
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error('[generateAndCacheAllGenres] Unexpected Gemini response shape:', typeof parsed);
    return {};
  }

  const traktType = isShow ? 'show' : 'movie';
  const rawType   = isShow ? 'show' : 'movie';
  const result = {};

  const genreResults = await Promise.all(genreKeys.map(async genre => {
    const items = parsed[genre];
    if (!Array.isArray(items)) return [genre, []];
    const validItems = items.filter(item => item && typeof item.title === 'string' && item.year);
    const resolved = await mapConcurrent(validItems, 10, async item => {
      try {
        const r = await fetchWithRetry(`${TRAKT_BASE}/search/${traktType}?query=${encodeURIComponent(item.title)}&limit=5`, { headers });
        if (!r.ok) return null;
        const data = await r.json();
        if (!data?.length) return null;
        const q = normTitle(item.title);
        const exact = data.find(d => {
          const t = d[traktType];
          return t?.ids?.imdb && normTitle(t.title || '') === q && Math.abs((t.year || 0) - item.year) <= 1;
        });
        if (exact) {
          const t = exact[traktType];
          return { id: t.ids.imdb, name: t.title, year: t.year, rating: t.rating, overview: t.overview, genres: t.genres };
        }
        const top = data[0]?.[traktType];
        if (top?.ids?.imdb) {
          return { id: top.ids.imdb, name: top.title, year: top.year, rating: top.rating, overview: top.overview, genres: top.genres };
        }
        return null;
      } catch { return null; }
    });
    const genreItems = resolved.filter(item => item && /^tt\d+$/.test(item.id));
    return [genre, genreItems];
  }));

  for (const [genre, genreItems] of genreResults) {
    result[genre] = genreItems;
    if (redis && cacheNamespace && genreItems.length > 0) {
      const cacheKey = `ai:${cacheNamespace}:ai-${rawType}-${genre}`;
      try {
        await redis.set(cacheKey, JSON.stringify(genreItems.map(item => item.id)), { ex: 2592000 });
        console.log(`[generateAndCacheAllGenres] Cached ${genreItems.length} items → ${cacheKey}`);
      } catch { /* non-fatal */ }
    }
  }

  return result;
}

const RPDB_FREE_KEY = 't0-free-rpdb-rounded-blocks';
function rpdbPoster(imdbId) {
  return `https://api.ratingposterdb.com/${RPDB_FREE_KEY}/imdb/poster-default/${imdbId}.jpg`;
}

async function handleAICatalog(config, mediaType, genreKey, skip, res, cacheNamespace = null) {
  const redis = cacheNamespace ? getRedis() : null;
  const cacheKey = cacheNamespace ? `ai:${cacheNamespace}:ai-${mediaType === 'series' ? 'show' : 'movie'}-${genreKey}` : null;
  if (redis && cacheKey) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const data = typeof cached === 'string' ? JSON.parse(cached) : cached;
        const cachedItems = Array.isArray(data)
          ? data.map(m => (typeof m === 'string' ? { id: m } : m)).filter(m => m.id)
          : [];
        const page = cachedItems.slice(skip);
        const result = { metas: page.map(m => ({
          id: m.id,
          type: mediaType,
          name: m.name || undefined,
          poster: rpdbPoster(m.id),
          releaseInfo: m.year ? String(m.year) : undefined,
          description: m.overview || undefined,
          imdbRating: m.rating ? m.rating.toFixed(1) : undefined,
          genres: m.genres || undefined,
          behaviorHints: mediaType === 'movie' ? { defaultVideoId: m.id } : undefined,
        })) };

        // Stale-while-revalidate: if cache older than ~20 days (< 10 days TTL remaining), refresh in background
        redis.ttl(cacheKey).then(ttl => {
          if (ttl >= 0 && ttl < 864000) {
            const swrLockKey = `ai-lock:${cacheNamespace}:${mediaType === 'series' ? 'show' : 'movie'}`;
            redis.set(swrLockKey, '1', { nx: true, ex: 300 })
              .then(lockResult => {
                if (lockResult === 'OK') {
                  return generateAndCacheAllGenres(mediaType, config, redis, cacheNamespace)
                    .finally(() => redis.del(swrLockKey).catch(() => {}));
                }
              })
              .catch(() => {});
          }
        }).catch(() => {});

        return res.json(result);
      }
    } catch { /* non-fatal */ }
  }

  // Don't call Gemini for non-first pages when cache is cold
  if (skip > 0) return res.json({ metas: [] });

  // Redis lock: only one request per user+mediaType triggers Gemini generation.
  // All other parallel requests return empty immediately; Stremio retries automatically.
  const lockKey = redis && cacheNamespace
    ? `ai-lock:${cacheNamespace}:${mediaType === 'series' ? 'show' : 'movie'}`
    : null;
  let lockAcquired = false;
  if (lockKey) {
    try {
      const lockResult = await redis.set(lockKey, '1', { nx: true, ex: 300 }); // 5min safety TTL
      lockAcquired = lockResult === 'OK';
    } catch { /* non-fatal */ }
    if (!lockAcquired) {
      return res.json({ metas: [] });
    }
  }

  try {
    // Batched call: one Gemini request warms all genre keys for this media type at once
    const allResults = await generateAndCacheAllGenres(mediaType, config, redis, cacheNamespace);
    const genItems = allResults?.[genreKey] ?? [];
    res.setHeader('Cache-Control', 'public, max-age=14400, s-maxage=86400, stale-while-revalidate=604800');
    return res.json({ metas: genItems.map(m => ({
      id: m.id,
      type: mediaType,
      name: m.name || undefined,
      poster: rpdbPoster(m.id),
      releaseInfo: m.year ? String(m.year) : undefined,
      description: m.overview || undefined,
      imdbRating: m.rating ? m.rating.toFixed(1) : undefined,
      genres: m.genres || undefined,
      behaviorHints: mediaType === 'movie' ? { defaultVideoId: m.id } : undefined,
    })) });
  } finally {
    if (lockKey && lockAcquired) {
      try { await redis.del(lockKey); } catch { /* non-fatal */ }
    }
  }
}

// ── AI Search ─────────────────────────────────────────────────

const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
// norm() but also strips leading articles ("the ", "a ", "an ")
const normTitle = s => norm(s).replace(/^(the|a|an) /, '');

async function resolveImdbIds(items, traktType, headers) {
  if (!Array.isArray(items)) return [];
  const validItems = items.filter(item => item && typeof item.title === 'string' && item.year);
  const resolved = await Promise.all(validItems.map(async item => {
    try {
      const r = await fetchWithRetry(`${TRAKT_BASE}/search/${traktType}?query=${encodeURIComponent(item.title)}&limit=5`, { headers });
      if (!r.ok) return null;
      const data = await r.json();
      if (!data?.length) return null;
      const q = normTitle(item.title);
      const exact = data.find(d => {
        const t = d[traktType];
        return t?.ids?.imdb && normTitle(t.title || '') === q && Math.abs((t.year || 0) - item.year) <= 1;
      });
      if (exact) {
        const t = exact[traktType];
        return { id: t.ids.imdb, name: t.title, year: t.year, rating: t.rating, overview: t.overview, genres: t.genres };
      }
      const top = data[0]?.[traktType];
      if (top?.ids?.imdb && Math.abs((top.year || 0) - item.year) <= 1) {
        return { id: top.ids.imdb, name: top.title, year: top.year, rating: top.rating, overview: top.overview, genres: top.genres };
      }
      return null;
    } catch { return null; }
  }));
  return resolved.filter(item => item && /^tt\d+$/.test(item.id));
}

async function handleAISearch(config, mediaType, query, res, cacheNamespace = null) {
  if (!query?.trim()) return res.json({ metas: [] });

  const redis = cacheNamespace ? getRedis() : null;
  const normalizedQuery = query.trim().toLowerCase().replace(/\s+/g, ' ');
  const cacheKey = cacheNamespace ? `ai-search:${cacheNamespace}:${normalizedQuery}` : null;

  // Check cache — new format is { movie: [...], series: [...] }
  if (redis && cacheKey) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const data = typeof cached === 'string' ? JSON.parse(cached) : cached;
        if (data && typeof data === 'object' && !Array.isArray(data) && (data.movie || data.series)) {
          const cachedSearchItems = (data[mediaType] || []).map(m => (typeof m === 'string' ? { id: m } : m)).filter(m => m.id);
          return res.json({ metas: cachedSearchItems.map(m => ({
            id: m.id,
            type: mediaType,
            name: m.name || undefined,
            poster: rpdbPoster(m.id),
            releaseInfo: m.year ? String(m.year) : undefined,
            description: m.overview || undefined,
            imdbRating: m.rating ? m.rating.toFixed(1) : undefined,
            genres: m.genres || undefined,
            behaviorHints: mediaType === 'movie' ? { defaultVideoId: m.id } : undefined,
          })) });
        }
      }
    } catch { /* non-fatal */ }
  }

  const headers = traktHeaders(config.clientId, config.accessToken);
  const q = query.trim();

  const customClause = config.customInstructions?.trim()
    ? `\n\nUser preferences: ${config.customInstructions.trim()}`
    : '';
  const excludedList = (config.excludedFromFeed || []).slice(0, 50).join(', ');
  const excludedClause = excludedList
    ? `\n\nDo not include any of these titles the user has excluded: ${excludedList}`
    : '';

  const prompt = `You are a movie and TV show search engine that understands natural language queries.\n\nThe user searched for: "${q}"\n\nReturn exactly 10 movies and 10 TV shows that best match this search. Interpret the query broadly — include titles, themes, time periods, styles, and subgenres that fit. If the query looks like a specific title (possibly with a typo or missing article like "the"), prioritize returning that exact corrected title as the first result.${customClause}${excludedClause}\n\nReturn ONLY a valid JSON object with title and year arrays, no other text:\n{"movies": [{"title": "Movie Name", "year": 2023}], "shows": [{"title": "Show Name", "year": 2023}]}`;

  // Run exact Trakt title search + Gemini call concurrently
  const [exactMovieData, exactShowData, geminiRes] = await Promise.all([
    fetchWithRetry(`${TRAKT_BASE}/search/movie?query=${encodeURIComponent(q)}&limit=5`, { headers }).then(r => r.ok ? r.json() : []).catch(() => []),
    fetchWithRetry(`${TRAKT_BASE}/search/show?query=${encodeURIComponent(q)}&limit=5`, { headers }).then(r => r.ok ? r.json() : []).catch(() => []),
    fetchWithRetry(`${GEMINI_SEARCH_BASE}?key=${config.geminiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.7, responseMimeType: 'application/json' } }),
    }),
  ]);

  // Exact Trakt matches (normalized title match, article-stripped)
  const normTitleQ = normTitle(q);
  const exactMovieItems = (Array.isArray(exactMovieData) ? exactMovieData : [])
    .filter(d => d?.movie?.ids?.imdb && normTitle(d.movie.title || '') === normTitleQ && /^tt\d+$/.test(d.movie.ids.imdb))
    .map(d => ({ id: d.movie.ids.imdb, name: d.movie.title, year: d.movie.year, rating: d.movie.rating, overview: d.movie.overview, genres: d.movie.genres }));
  const exactShowItems = (Array.isArray(exactShowData) ? exactShowData : [])
    .filter(d => d?.show?.ids?.imdb && normTitle(d.show.title || '') === normTitleQ && /^tt\d+$/.test(d.show.ids.imdb))
    .map(d => ({ id: d.show.ids.imdb, name: d.show.title, year: d.show.year, rating: d.show.rating, overview: d.show.overview, genres: d.show.genres }));

  // Parse Gemini response
  let parsed = { movies: [], shows: [] };
  if (geminiRes.ok) {
    try {
      const geminiData = await geminiRes.json();
      const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const objMatch = rawText.match(/\{[\s\S]*\}/);
      const raw = JSON.parse(objMatch ? objMatch[0] : '{}');
      if (Array.isArray(raw.movies)) parsed.movies = raw.movies;
      if (Array.isArray(raw.shows)) parsed.shows = raw.shows;
    } catch { /* use empty */ }
  }

  // Resolve Gemini suggestions to IMDb items for both types concurrently
  const [aiMovieItems, aiShowItems] = await Promise.all([
    resolveImdbIds(parsed.movies, 'movie', headers),
    resolveImdbIds(parsed.shows, 'show', headers),
  ]);

  // Merge: exact match first, then AI results (deduplicated by id)
  const mergeItems = (exact, ai) => {
    const seen = new Set(exact.map(m => m.id));
    const result = [...exact];
    for (const m of ai) { if (!seen.has(m.id)) { seen.add(m.id); result.push(m); } }
    return result;
  };

  const movieItems = mergeItems(exactMovieItems, aiMovieItems);
  const showItems  = mergeItems(exactShowItems,  aiShowItems);

  if (redis && cacheKey && (movieItems.length > 0 || showItems.length > 0)) {
    try { await redis.set(cacheKey, JSON.stringify({ movie: movieItems, series: showItems }), { ex: 3600 }); } catch { /* non-fatal */ }
  }

  res.setHeader('Cache-Control', 'public, max-age=14400, s-maxage=86400, stale-while-revalidate=604800');
  const searchItems = mediaType === 'movie' ? movieItems : showItems;
  return res.json({ metas: searchItems.map(m => ({
    id: m.id,
    type: mediaType,
    name: m.name || undefined,
    poster: rpdbPoster(m.id),
    releaseInfo: m.year ? String(m.year) : undefined,
    description: m.overview || undefined,
    imdbRating: m.rating ? m.rating.toFixed(1) : undefined,
    genres: m.genres || undefined,
    behaviorHints: mediaType === 'movie' ? { defaultVideoId: m.id } : undefined,
  })) });
}

// ── Catalog ───────────────────────────────────────────────────

async function handleCatalog(config, type, id, extra, res, uuid = null, searchParams = null) {
  const params = parseExtra(extra, searchParams);
  const page = Math.floor((parseInt(params.skip) || 0) / 20) + 1;
  const headers = traktHeaders(config.clientId, config.accessToken);

  let traktData;
  let itemType = type;

switch (id) {
    case 'trakt-watchlist': {
      const raw = await traktFetch(`${TRAKT_BASE}/sync/watchlist/movies?sort=added&limit=20&page=${page}&extended=full`, headers);
      traktData = raw.map(item => item.movie);
      break;
    }
    case 'trakt-trending': {
      const raw = await traktFetch(`${TRAKT_BASE}/movies/trending?limit=20&page=${page}&extended=full`, headers);
      traktData = raw.map(item => item.movie);
      break;
    }
    case 'trakt-popular': {
      traktData = await traktFetch(`${TRAKT_BASE}/movies/popular?limit=20&page=${page}&extended=full`, headers);
      break;
    }
    case 'trakt-anticipated': {
      const raw = await traktFetch(`${TRAKT_BASE}/movies/anticipated?limit=20&page=${page}&extended=full`, headers);
      traktData = raw.map(item => item.movie);
      break;
    }
    case 'trakt-boxoffice': {
      const raw = await traktFetch(`${TRAKT_BASE}/movies/boxoffice?extended=full`, headers);
      traktData = raw.map(item => item.movie);
      break;
    }
    case 'trakt-recommended': {
      traktData = await traktFetch(`${TRAKT_BASE}/recommendations/movies?limit=20&extended=full`, headers);
      break;
    }
    case 'trakt-watchlist-shows': {
      const raw = await traktFetch(`${TRAKT_BASE}/sync/watchlist/shows?sort=added&limit=20&page=${page}&extended=full`, headers);
      traktData = raw.map(item => item.show);
      itemType = 'series';
      break;
    }
    case 'trakt-trending-shows': {
      const raw = await traktFetch(`${TRAKT_BASE}/shows/trending?limit=20&page=${page}&extended=full`, headers);
      traktData = raw.map(item => item.show);
      itemType = 'series';
      break;
    }
    case 'trakt-popular-shows': {
      traktData = await traktFetch(`${TRAKT_BASE}/shows/popular?limit=20&page=${page}&extended=full`, headers);
      itemType = 'series';
      break;
    }
    case 'trakt-anticipated-shows': {
      const raw = await traktFetch(`${TRAKT_BASE}/shows/anticipated?limit=20&page=${page}&extended=full`, headers);
      traktData = raw.map(item => item.show);
      itemType = 'series';
      break;
    }
    case 'trakt-recommended-shows': {
      traktData = await traktFetch(`${TRAKT_BASE}/recommendations/shows?limit=20&extended=full`, headers);
      itemType = 'series';
      break;
    }
    // ... keep your default case exactly as it is ...
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
        const cacheNamespace = resolveCacheNamespace(config, uuid);
        if (id === 'ai-search-movie')  return handleAISearch(config, 'movie',  params.search, res, cacheNamespace);
        if (id === 'ai-search-series') return handleAISearch(config, 'series', params.search, res, cacheNamespace);
        const parts = id.split('-');
        const aiMediaType = parts[1] === 'show' ? 'series' : parts[1];
        const genreKey = parts[2] || 'overall';
        const skip = parseInt(params.skip) || 0;
        return await handleAICatalog(config, aiMediaType, genreKey, skip, res, cacheNamespace);
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
      behaviorHints: itemType === 'movie' ? { defaultVideoId: item.ids.imdb } : undefined,
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

  if (!config || !config.accessToken || (!config.clientId && !process.env.TRAKT_CLIENT_ID)) {
    if (resource === 'meta') return res.json({ meta: null });
    return res.json({ metas: [] });
  }

  if (resource === 'catalog') {
    try {
      return await handleCatalog(config, type, id, extra, res, uuid, url.searchParams);
    } catch (err) {
      if (err instanceof TraktAuthError && config.refreshToken) {
        const newConfig = await refreshToken(config, uuid);
        if (newConfig) {
          // Persist the new tokens so subsequent requests don't loop on refresh
          await saveRefreshedConfig(uuid, newConfig);
          try {
            return await handleCatalog(newConfig, type, id, extra, res, uuid, url.searchParams);
          } catch {
            return res.json({ metas: [] });
          }
        }
      }
      return res.json({ metas: [] });
    }
  }


  return res.status(404).json({ error: 'Not found' });
}
