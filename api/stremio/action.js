import { Redis } from '@upstash/redis';

const TRAKT_BASE = 'https://api.trakt.tv';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getRedis() {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return null;
  return Redis.fromEnv();
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

function htmlPage(title, emoji, message, color = '#10b981') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #0a0a0a; color: #e5e5e5; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { text-align: center; padding: 2.5rem 2rem; background: #111; border: 1px solid #222; border-radius: 1rem; max-width: 340px; width: 90%; }
    .emoji { font-size: 3.5rem; margin-bottom: 1.25rem; display: block; }
    h1 { font-size: 1.25rem; font-weight: 600; color: ${color}; margin-bottom: 0.5rem; }
    p { font-size: 0.875rem; color: #888; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <span class="emoji">${emoji}</span>
    <h1>${title}</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;
}

async function lookupTraktId(imdbId, type, headers) {
  const searchType = type === 'show' ? 'show' : 'movie';
  const res = await fetch(`${TRAKT_BASE}/search/imdb/${imdbId}?type=${searchType}`, { headers });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data || data.length === 0) return null;
  return data[0][searchType]?.ids?.trakt || null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = url.searchParams.get('a');
  const type = url.searchParams.get('type') || 'movie';
  const imdbId = url.searchParams.get('id');
  const uuid = url.searchParams.get('uuid');

  if (!uuid || !UUID_REGEX.test(uuid)) {
    return res.status(400).send(htmlPage('Configuration Error', '⚠️', 'Invalid or missing addon configuration.', '#ef4444'));
  }
  const redis = getRedis();
  if (!redis) {
    return res.status(500).send(htmlPage('Configuration Error', '⚠️', 'Server configuration error.', '#ef4444'));
  }
  let config;
  try {
    const raw = await redis.get(`user:${uuid}`);
    if (!raw) throw new Error('Not found');
    config = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return res.status(400).send(htmlPage('Configuration Error', '⚠️', 'Invalid or missing addon configuration.', '#ef4444'));
  }
  if (!config.accessToken || (!config.clientId && !process.env.TRAKT_CLIENT_ID)) {
    return res.status(400).send(htmlPage('Configuration Error', '⚠️', 'Invalid or missing addon configuration.', '#ef4444'));
  }

  if (!imdbId) {
    return res.status(400).send(htmlPage('Missing ID', '⚠️', 'No title ID provided.', '#f59e0b'));
  }

  const headers = traktHeaders(config.clientId, config.accessToken);

  try {
    const traktId = await lookupTraktId(imdbId, type, headers);
    if (!traktId) {
      return res.status(404).send(htmlPage('Not Found', '🔍', 'Could not find this title on Trakt.', '#f59e0b'));
    }

    if (action === 'watchlist') {
      const body = type === 'show'
        ? { shows: [{ ids: { trakt: traktId, imdb: imdbId } }] }
        : { movies: [{ ids: { trakt: traktId, imdb: imdbId } }] };
      const r = await fetch(`${TRAKT_BASE}/sync/watchlist`, {
        method: 'POST', headers, body: JSON.stringify(body),
      });
      if (r.ok) {
        return res.send(htmlPage('Added to Watchlist', '👍', 'This title has been added to your Trakt watchlist.'));
      }
      return res.status(500).send(htmlPage('Failed', '❌', 'Could not add to watchlist. Try again.', '#ef4444'));
    }

    if (action === 'dismiss') {
      const endpoint = type === 'show'
        ? `${TRAKT_BASE}/recommendations/shows/${traktId}`
        : `${TRAKT_BASE}/recommendations/movies/${traktId}`;
      const r = await fetch(endpoint, { method: 'DELETE', headers });
      if (r.ok || r.status === 204) {
        return res.send(htmlPage('Dismissed', '👎', 'This title has been removed from your recommendations.', '#6366f1'));
      }
      return res.status(500).send(htmlPage('Failed', '❌', 'Could not dismiss. Try again.', '#ef4444'));
    }

    if (action === 'unwatchlist') {
      const body = type === 'show'
        ? { shows: [{ ids: { trakt: traktId, imdb: imdbId } }] }
        : { movies: [{ ids: { trakt: traktId, imdb: imdbId } }] };
      const r = await fetch(`${TRAKT_BASE}/sync/watchlist/remove`, { method: 'POST', headers, body: JSON.stringify(body) });
      if (r.ok) return res.send(htmlPage('Removed from Watchlist', '🗑️', 'Removed from your Trakt watchlist.', '#6366f1'));
      return res.status(500).send(htmlPage('Failed', '❌', 'Could not remove. Try again.', '#ef4444'));
    }

    return res.status(400).send(htmlPage('Unknown Action', '⚠️', 'Invalid action requested.', '#f59e0b'));
  } catch {
    return res.status(502).send(htmlPage('Connection Error', '❌', 'Could not reach Trakt API. Please try again.', '#ef4444'));
  }
}
