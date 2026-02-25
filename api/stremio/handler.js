const TRAKT_BASE = 'https://api.trakt.tv';

class TraktAuthError extends Error {
  constructor(msg) { super(msg); this.name = 'TraktAuthError'; }
}

function decodeConfig(encoded) {
  try {
    const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(padded, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
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

function traktHeaders(clientId, accessToken) {
  return {
    'Content-Type': 'application/json',
    'trakt-api-version': '2',
    'trakt-api-key': clientId,
    'Authorization': `Bearer ${accessToken}`,
    'User-Agent': 'stremio-trakt-addon/1.0',
  };
}

async function traktFetch(url, headers) {
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
      client_id: config.clientId,
      client_secret: config.clientSecret || '',
      redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
      grant_type: 'refresh_token',
    }),
  });
  if (!response.ok) return null;
  const tokens = await response.json();
  return { ...config, accessToken: tokens.access_token, refreshToken: tokens.refresh_token };
}

// ── Manifest ──────────────────────────────────────────────────

const ALL_CATALOG_DEFS = [
  { type: 'movie', id: 'trakt-recommended',       name: 'Recommended For You',     extra: [{ name: 'skip', isRequired: false }, { name: 'genre', isRequired: false }] },
  { type: 'movie', id: 'trakt-watchlist',          name: 'Your Watchlist',          extra: [{ name: 'skip', isRequired: false }] },
  { type: 'movie', id: 'trakt-trending',           name: 'Trending on Trakt',       extra: [{ name: 'skip', isRequired: false }] },
  { type: 'movie', id: 'trakt-ai-picks',           name: 'AI Picks for You',        extra: [] },
  { type: 'show',  id: 'trakt-recommended-shows',  name: 'Recommended Shows',       extra: [{ name: 'skip', isRequired: false }] },
  { type: 'show',  id: 'trakt-watchlist-shows',    name: 'Your Show Watchlist',     extra: [{ name: 'skip', isRequired: false }] },
  { type: 'show',  id: 'trakt-trending-shows',     name: 'Trending Shows on Trakt', extra: [{ name: 'skip', isRequired: false }] },
  { type: 'show',  id: 'trakt-ai-picks-shows',     name: 'AI Show Picks',           extra: [] },
];

const AI_CATALOG_IDS = ['trakt-ai-picks', 'trakt-ai-picks-shows'];

function handleManifest(config, res) {
  let catalogs;
  if (config?.enabledCatalogs?.length) {
    catalogs = config.enabledCatalogs
      .map(id => ALL_CATALOG_DEFS.find(c => c.id === id))
      .filter(Boolean);
  } else {
    // Backward compat: all non-AI catalogs, plus AI if geminiKey present
    catalogs = ALL_CATALOG_DEFS.filter(c => !AI_CATALOG_IDS.includes(c.id) || config?.geminiKey);
  }

  return res.json({
    id: 'com.zachr.trakt.recommendations',
    version: '1.2.0',
    name: 'Trakt Recommendations',
    description: 'Personalized movie & show recommendations from your Trakt history. Rate from within Stremio.',
    logo: 'https://walter.trakt.tv/hotlink-ok/public/favicon.svg',
    resources: ['catalog', 'stream'],
    types: ['movie', 'show'],
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

async function handleAICatalog(config, mediaType, res) {
  const headers = traktHeaders(config.clientId, config.accessToken);
  const isShow = mediaType === 'show';

  // Fetch top-rated items (≥7/10) from Trakt
  const ratingsUrl = isShow
    ? `${TRAKT_BASE}/users/me/ratings/shows?limit=50&extended=full`
    : `${TRAKT_BASE}/users/me/ratings/movies?limit=50&extended=full`;
  const ratingsRaw = await traktFetch(ratingsUrl, headers);
  const topRated = ratingsRaw
    .filter(r => r.rating >= 7)
    .map(r => ({ title: isShow ? r.show.title : r.movie.title, year: isShow ? r.show.year : r.movie.year }));

  if (topRated.length === 0) return res.json({ metas: [] });

  // Fetch watched history to exclude from recommendations
  const watchedUrl = isShow
    ? `${TRAKT_BASE}/users/me/watched/shows?limit=50`
    : `${TRAKT_BASE}/users/me/watched/movies?limit=50`;
  let watchedTitles = [];
  try {
    const watchedRaw = await traktFetch(watchedUrl, headers);
    watchedTitles = watchedRaw.map(w => isShow ? w.show.title : w.movie.title);
  } catch { /* non-fatal */ }

  const ratedList = topRated.map(m => `- ${m.title} (${m.year})`).join('\n');
  const watchedList = watchedTitles.slice(0, 30).map(t => `- ${t}`).join('\n') || 'None';
  const mediaLabel = isShow ? 'TV shows' : 'movies';

  const prompt = `You are a ${mediaLabel} recommendation engine.\n\nThe user has rated these ${mediaLabel} highly (7-10/10):\n${ratedList}\n\nThey have already watched these (do NOT recommend any of these):\n${watchedList}\n\nRecommend exactly 20 ${mediaLabel} they would likely enjoy that are NOT in either list above. Focus on similar themes, tone, directors, or genres.\nReturn ONLY a valid JSON array, no other text:\n[{"title": "Title Here", "year": 2020}, ...]`;

  // Call Gemini
  const geminiRes = await fetch(`${GEMINI_BASE}?key=${config.geminiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  if (!geminiRes.ok) return res.json({ metas: [] });

  const geminiData = await geminiRes.json();
  const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';

  let suggestions;
  try {
    const jsonMatch = rawText.match(/\[[\s\S]*\]/);
    suggestions = JSON.parse(jsonMatch ? jsonMatch[0] : rawText);
  } catch {
    return res.json({ metas: [] });
  }

  // Look up each suggestion in Trakt in parallel
  const searchType = isShow ? 'show' : 'movie';
  const lookups = await Promise.allSettled(
    suggestions.slice(0, 20).map(async ({ title, year }) => {
      const query = encodeURIComponent(title);
      const url = `${TRAKT_BASE}/search/${searchType}?query=${query}&years=${year}&limit=1&extended=full`;
      const searchRes = await fetch(url, { headers });
      if (!searchRes.ok) return null;
      const results = await searchRes.json();
      if (!results || results.length === 0) return null;
      const item = results[0][searchType];
      if (!item || !item.ids?.imdb) return null;
      return {
        id: item.ids.imdb,
        type: mediaType,
        name: item.title,
        poster: rpdbPoster(item.ids.imdb),
        releaseInfo: item.year ? String(item.year) : undefined,
        description: item.overview || undefined,
        imdbRating: item.rating ? item.rating.toFixed(1) : undefined,
        genres: item.genres || undefined,
      };
    })
  );

  const metas = lookups
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value);

  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
  return res.json({ metas });
}

// ── Catalog ───────────────────────────────────────────────────

async function handleCatalog(config, type, id, extra, res) {
  const params = parseExtra(extra);
  const page = Math.floor((parseInt(params.skip) || 0) / 20) + 1;
  const headers = traktHeaders(config.clientId, config.accessToken);

  let traktData;
  let itemType = type;

  switch (id) {
    case 'trakt-recommended': {
      let url = `${TRAKT_BASE}/recommendations/movies?limit=20&page=${page}&extended=full`;
      if (params.genre) url += `&genres=${encodeURIComponent(params.genre)}`;
      traktData = await traktFetch(url, headers);
      break;
    }
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
    case 'trakt-recommended-shows': {
      traktData = await traktFetch(
        `${TRAKT_BASE}/recommendations/shows?limit=20&page=${page}&extended=full`, headers
      );
      itemType = 'show';
      break;
    }
    case 'trakt-watchlist-shows': {
      const raw = await traktFetch(
        `${TRAKT_BASE}/sync/watchlist/shows?sort=added&limit=20&page=${page}&extended=full`, headers
      );
      traktData = raw.map(item => item.show);
      itemType = 'show';
      break;
    }
    case 'trakt-trending-shows': {
      const raw = await traktFetch(
        `${TRAKT_BASE}/shows/trending?limit=20&page=${page}&extended=full`, headers
      );
      traktData = raw.map(item => item.show);
      itemType = 'show';
      break;
    }
    case 'trakt-ai-picks':
    case 'trakt-ai-picks-shows': {
      if (!config.geminiKey) return res.json({ metas: [] });
      const aiMediaType = id === 'trakt-ai-picks-shows' ? 'show' : 'movie';
      return await handleAICatalog(config, aiMediaType, res);
    }
    default:
      return res.json({ metas: [] });
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

  return res.json({ metas });
}

// ── Stream ─────────────────────────────────────────────────────

function handleStream(configEncoded, type, id, req, res) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const base = `${proto}://${host}`;

  return res.json({
    streams: [
      {
        name: 'Trakt',
        title: '👍 Add to Watchlist',
        externalUrl: `${base}/api/stremio/action?a=watchlist&type=${type}&id=${id}&config=${configEncoded}`,
      },
      {
        name: 'Trakt',
        title: '👎 Not Interested',
        externalUrl: `${base}/api/stremio/action?a=dismiss&type=${type}&id=${id}&config=${configEncoded}`,
      },
    ],
  });
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

  const config = decodeConfig(configEncoded);

  if (resource === 'manifest') return handleManifest(config, res);

  if (!config || !config.accessToken || !config.clientId) {
    return res.status(400).json({ metas: [], streams: [] });
  }

  if (resource === 'stream') {
    return handleStream(configEncoded, type, id, req, res);
  }

  if (resource === 'catalog') {
    try {
      return await handleCatalog(config, type, id, extra, res);
    } catch (err) {
      if (err instanceof TraktAuthError && config.refreshToken) {
        const newConfig = await refreshToken(config);
        if (newConfig) {
          try {
            return await handleCatalog(newConfig, type, id, extra, res);
          } catch {
            return res.json({ metas: [] });
          }
        }
      }
      return res.json({ metas: [] });
    }
  }

  if (resource === 'meta') return res.json({ meta: null });

  return res.status(404).json({ error: 'Not found' });
}
