const TRAKT_BASE = 'https://api.trakt.tv';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function setCors(res) {
  Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v));
}

function traktHeaders(clientId, accessToken) {
  return {
    'Content-Type': 'application/json',
    'trakt-api-version': '2',
    'trakt-api-key': clientId,
    'Authorization': `Bearer ${accessToken}`,
  };
}

async function handleThumbsUp(traktId, imdbId, accessToken, clientId) {
  const response = await fetch(`${TRAKT_BASE}/sync/watchlist`, {
    method: 'POST',
    headers: traktHeaders(clientId, accessToken),
    body: JSON.stringify({
      movies: [{ ids: { trakt: traktId, imdb: imdbId } }],
    }),
  });
  return response.ok;
}

async function handleThumbsDown(traktId, accessToken, clientId) {
  const response = await fetch(`${TRAKT_BASE}/recommendations/movies/${traktId}`, {
    method: 'DELETE',
    headers: traktHeaders(clientId, accessToken),
  });
  return response.status === 204 || response.ok;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    setCors(res);
    return res.status(204).end();
  }
  setCors(res);

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action, traktId, imdbId, accessToken, clientId } = req.body || {};

  if (!action || !traktId || !accessToken || !clientId) {
    return res.status(400).json({ error: 'Missing required fields: action, traktId, accessToken, clientId' });
  }

  try {
    if (action === 'thumbsUp') {
      const ok = await handleThumbsUp(traktId, imdbId, accessToken, clientId);
      return res.json({ success: ok, message: ok ? 'Added to watchlist' : 'Failed to add' });
    }
    if (action === 'thumbsDown') {
      const ok = await handleThumbsDown(traktId, accessToken, clientId);
      return res.json({ success: ok, message: ok ? 'Dismissed from recommendations' : 'Failed to dismiss' });
    }
    return res.status(400).json({ error: 'Invalid action. Use thumbsUp or thumbsDown' });
  } catch (err) {
    return res.status(502).json({ error: 'Failed to reach Trakt API', details: err.message });
  }
}
