import { Redis } from '@upstash/redis';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function getRedis() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    throw new Error('Upstash Redis not configured');
  }
  return new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
}

function createManageKey() {
  return `${crypto.randomUUID().replace(/-/g, '')}${crypto.randomUUID().replace(/-/g, '')}`;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    setCors(res);
    return res.status(204).end();
  }
  setCors(res);

  if (req.method === 'GET') {
    const uuid = new URL(req.url, `http://${req.headers.host}`).searchParams.get('uuid');
    if (!uuid || !UUID_REGEX.test(uuid)) {
      return res.status(400).json({ error: 'Invalid uuid' });
    }
    let redis;
    try { redis = getRedis(); } catch {
      return res.status(503).json({ error: 'Storage not configured' });
    }
    const raw = await redis.get(`user:${uuid}`);
    if (!raw) return res.status(404).json({ error: 'Not found' });
    const cfg = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return res.json({
      excludedFromFeed: cfg.excludedFromFeed || [],
      customInstructions: cfg.customInstructions || '',
      enabledCatalogs: cfg.enabledCatalogs || [],
      traktLists: cfg.traktLists || [],
    });
  }

  if (req.method === 'DELETE') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const uuid = url.searchParams.get('uuid');
    const providedManageKey = url.searchParams.get('k');
    if (!uuid || !UUID_REGEX.test(uuid)) return res.status(400).json({ error: 'Invalid uuid' });
    let redis;
    try { redis = getRedis(); } catch {
      return res.status(503).json({ error: 'Storage not configured' });
    }
    let cfg = null;
    try {
      const raw = await redis.get(`user:${uuid}`);
      if (!raw) return res.status(404).json({ error: 'Not found' });
      cfg = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return res.status(404).json({ error: 'Not found' });
    }
    if (cfg?.manageKey && providedManageKey !== cfg.manageKey) {
      return res.status(403).json({ error: 'Invalid management key' });
    }
    await redis.del(`user:${uuid}`);
    return res.status(200).json({ deleted: true });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    uuid: existingUuid,
    clientId, clientSecret, geminiKey,
    accessToken, refreshToken,
    enabledCatalogs, customInstructions, excludedFromFeed,
  } = req.body || {};

  if ((!clientId && !process.env.TRAKT_CLIENT_ID) || !accessToken || !refreshToken) {
    return res.status(400).json({ error: 'Missing required fields: accessToken, refreshToken (and clientId if no shared app configured)' });
  }
  if (existingUuid && !UUID_REGEX.test(existingUuid)) {
    return res.status(400).json({ error: 'Invalid uuid' });
  }

  let redis;
  try {
    redis = getRedis();
  } catch {
    return res.status(503).json({ error: 'Storage not configured. Set KV_REST_API_URL and KV_REST_API_TOKEN env vars.' });
  }

  let existingConfig = null;
  if (existingUuid) {
    try {
      const rawExisting = await redis.get(`user:${existingUuid}`);
      if (rawExisting) existingConfig = typeof rawExisting === 'string' ? JSON.parse(rawExisting) : rawExisting;
    } catch { /* non-fatal */ }
  }

  const config = {
    // Only store clientId/clientSecret if user provided their own (not relying on shared env vars)
    ...(clientId ? { clientId, clientSecret: clientSecret || '' } : {}),
    ...(geminiKey ? { geminiKey } : {}),
    accessToken,
    refreshToken,
    enabledCatalogs: enabledCatalogs || [],
    ...(customInstructions?.trim() ? { customInstructions: customInstructions.trim() } : {}),
    ...(excludedFromFeed?.length ? { excludedFromFeed } : {}),
    manageKey: existingConfig?.manageKey || createManageKey(),
    ...(existingConfig?.traktLists?.length ? { traktLists: existingConfig.traktLists } : {}),
  };

  // Fetch Trakt username to use as shared cache namespace across installs
  try {
    const meRes = await fetch('https://api.trakt.tv/users/me', {
      headers: {
        'Content-Type': 'application/json',
        'trakt-api-version': '2',
        'trakt-api-key': clientId || process.env.TRAKT_CLIENT_ID,
        'Authorization': `Bearer ${accessToken}`,
      },
    });
    if (meRes.ok) {
      const me = await meRes.json();
      if (me?.username) config.traktUsername = me.username;
    }
  } catch { /* non-fatal */ }
  if (!config.traktUsername && existingConfig?.traktUsername) {
    config.traktUsername = existingConfig.traktUsername;
  }

  // Re-use existing UUID (update) or generate a new one
  const uuid = existingUuid || crypto.randomUUID();

  // 2-year sliding TTL — reset on every valid request; orphaned UUIDs expire automatically
  await redis.set(`user:${uuid}`, JSON.stringify(config), { ex: 63072000 });

  return res.json({ uuid, manageKey: config.manageKey });
}
