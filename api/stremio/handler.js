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
  if (response.status === 401) {
    throw new TraktAuthError('Token expired');
  }
  if (!response.ok) {
    throw new Error(`Trakt API error: ${response.status}`);
  }
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
  return {
    ...config,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
  };
}

// ── Manifest ──────────────────────────────────────────────────

function handleManifest(res) {
  return res.json({
    id: 'com.zachr.trakt.recommendations',
    version: '1.0.0',
    name: 'Trakt Recommendations',
    description: 'Personalized movie recommendations powered by your Trakt watch history. Curate with thumbs up/down.',
    logo: 'https://walter.trakt.tv/hotlink-ok/public/favicon.svg',
    resources: ['catalog'],
    types: ['movie'],
    catalogs: [
      {
        type: 'movie',
        id: 'trakt-recommended',
        name: 'Recommended For You',
        extra: [
          { name: 'skip', isRequired: false },
          { name: 'genre', isRequired: false },
        ],
      },
      {
        type: 'movie',
        id: 'trakt-watchlist',
        name: 'Your Watchlist',
        extra: [
          { name: 'skip', isRequired: false },
        ],
      },
      {
        type: 'movie',
        id: 'trakt-trending',
        name: 'Trending on Trakt',
        extra: [
          { name: 'skip', isRequired: false },
        ],
      },
    ],
    behaviorHints: {
      configurable: true,
      configurationRequired: true,
    },
    idPrefixes: ['tt'],
  });
}

// ── Catalog ───────────────────────────────────────────────────

async function handleCatalog(config, type, id, extra, res) {
  if (type !== 'movie') return res.json({ metas: [] });

  const params = parseExtra(extra);
  const page = Math.floor((parseInt(params.skip) || 0) / 20) + 1;
  const headers = traktHeaders(config.clientId, config.accessToken);

  let traktData;

  switch (id) {
    case 'trakt-recommended': {
      let url = `${TRAKT_BASE}/recommendations/movies?limit=20&page=${page}&extended=full`;
      if (params.genre) url += `&genres=${encodeURIComponent(params.genre)}`;
      traktData = await traktFetch(url, headers);
      break;
    }
    case 'trakt-watchlist': {
      const raw = await traktFetch(
        `${TRAKT_BASE}/sync/watchlist/movies?sort=added&limit=20&page=${page}&extended=full`,
        headers
      );
      traktData = raw.map(item => item.movie);
      break;
    }
    case 'trakt-trending': {
      const raw = await traktFetch(
        `${TRAKT_BASE}/movies/trending?limit=20&page=${page}&extended=full`,
        headers
      );
      traktData = raw.map(item => item.movie);
      break;
    }
    default:
      return res.json({ metas: [] });
  }

  const metas = (traktData || [])
    .filter(movie => movie && movie.ids && movie.ids.imdb)
    .map(movie => ({
      id: movie.ids.imdb,
      type: 'movie',
      name: movie.title,
      releaseInfo: movie.year ? String(movie.year) : undefined,
      description: movie.overview || undefined,
      imdbRating: movie.rating ? movie.rating.toFixed(1) : undefined,
      genres: movie.genres || undefined,
    }));

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

  // Manifest doesn't need config
  if (resource === 'manifest') {
    return handleManifest(res);
  }

  // All other resources need valid config
  const config = decodeConfig(configEncoded);
  if (!config || !config.accessToken || !config.clientId) {
    return res.status(400).json({ metas: [] });
  }

  if (resource === 'catalog') {
    try {
      return await handleCatalog(config, type, id, extra, res);
    } catch (err) {
      if (err instanceof TraktAuthError && config.refreshToken) {
        // Try token refresh
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

  if (resource === 'meta') {
    // Cinemeta handles metadata from IMDb IDs, return empty
    return res.json({ meta: null });
  }

  return res.status(404).json({ error: 'Not found' });
}
