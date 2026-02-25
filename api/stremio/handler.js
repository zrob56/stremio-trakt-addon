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

function handleManifest(res) {
  return res.json({
    id: 'com.zachr.trakt.recommendations',
    version: '1.1.0',
    name: 'Trakt Recommendations',
    description: 'Personalized movie & show recommendations from your Trakt history. Rate from within Stremio.',
    logo: 'https://walter.trakt.tv/hotlink-ok/public/favicon.svg',
    resources: ['catalog', 'stream'],
    types: ['movie', 'show'],
    catalogs: [
      {
        type: 'movie',
        id: 'trakt-recommended',
        name: 'Recommended For You',
        extra: [{ name: 'skip', isRequired: false }, { name: 'genre', isRequired: false }],
      },
      {
        type: 'movie',
        id: 'trakt-watchlist',
        name: 'Your Watchlist',
        extra: [{ name: 'skip', isRequired: false }],
      },
      {
        type: 'movie',
        id: 'trakt-trending',
        name: 'Trending on Trakt',
        extra: [{ name: 'skip', isRequired: false }],
      },
      {
        type: 'show',
        id: 'trakt-recommended-shows',
        name: 'Recommended Shows',
        extra: [{ name: 'skip', isRequired: false }],
      },
      {
        type: 'show',
        id: 'trakt-watchlist-shows',
        name: 'Your Show Watchlist',
        extra: [{ name: 'skip', isRequired: false }],
      },
      {
        type: 'show',
        id: 'trakt-trending-shows',
        name: 'Trending Shows on Trakt',
        extra: [{ name: 'skip', isRequired: false }],
      },
    ],
    behaviorHints: { configurable: true },
    idPrefixes: ['tt'],
  });
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
    default:
      return res.json({ metas: [] });
  }

  const metas = (traktData || [])
    .filter(item => item && item.ids && item.ids.imdb)
    .map(item => ({
      id: item.ids.imdb,
      type: itemType,
      name: item.title,
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

  if (resource === 'manifest') return handleManifest(res);

  const config = decodeConfig(configEncoded);
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
