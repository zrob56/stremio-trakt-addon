const TRAKT_BASE = 'https://api.trakt.tv';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function setCors(res) {
  Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v));
}

async function handleStart(req, res) {
  const { clientId: bodyClientId } = req.body || {};
  const clientId = bodyClientId || process.env.TRAKT_CLIENT_ID;
  if (!clientId) {
    return res.status(400).json({ error: 'clientId is required' });
  }

  const response = await fetch(`${TRAKT_BASE}/oauth/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId }),
  });

  if (!response.ok) {
    const err = await response.text();
    return res.status(response.status).json({ error: 'Trakt API error', details: err });
  }

  const data = await response.json();
  // Returns: { device_code, user_code, verification_url, expires_in, interval }
  return res.json(data);
}

async function handlePoll(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const clientId = url.searchParams.get('clientId') || process.env.TRAKT_CLIENT_ID;
  const clientSecret = url.searchParams.get('clientSecret') || process.env.TRAKT_CLIENT_SECRET;
  const deviceCode = url.searchParams.get('deviceCode');

  if (!clientId || !deviceCode) {
    return res.status(400).json({ error: 'clientId and deviceCode are required' });
  }

  const response = await fetch(`${TRAKT_BASE}/oauth/device/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code: deviceCode,
      client_id: clientId,
      client_secret: clientSecret || '',
      redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
      grant_type: 'device_code',
    }),
  });

  if (response.status === 400) return res.json({ status: 'pending' });
  if (response.status === 404) return res.json({ status: 'not_found' });
  if (response.status === 409) return res.json({ status: 'already_used' });
  if (response.status === 410) return res.json({ status: 'expired' });
  if (response.status === 418) return res.json({ status: 'denied' });
  if (response.status === 429) return res.json({ status: 'slow_down' });

  if (response.ok) {
    const tokens = await response.json();
    return res.json({
      status: 'success',
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
      createdAt: tokens.created_at,
    });
  }

  return res.status(response.status).json({ error: 'Unexpected Trakt response' });
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    setCors(res);
    return res.status(204).end();
  }
  setCors(res);

  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = url.searchParams.get('action');

  if (action === 'start' && req.method === 'POST') {
    return handleStart(req, res);
  }
  if (action === 'poll' && req.method === 'GET') {
    return handlePoll(req, res);
  }

  return res.status(400).json({ error: 'Use ?action=start (POST) or ?action=poll (GET)' });
}
