import { Redis } from '@upstash/redis';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function getRedis() {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    throw new Error('Upstash Redis not configured');
  }
  return Redis.fromEnv();
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

  const {
    uuid: existingUuid,
    clientId, clientSecret, geminiKey,
    accessToken, refreshToken,
    enabledCatalogs, customInstructions, excludedFromFeed,
  } = req.body || {};

  if ((!clientId && !process.env.TRAKT_CLIENT_ID) || !accessToken || !refreshToken) {
    return res.status(400).json({ error: 'Missing required fields: accessToken, refreshToken (and clientId if no shared app configured)' });
  }

  let redis;
  try {
    redis = getRedis();
  } catch {
    return res.status(503).json({ error: 'Storage not configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN env vars.' });
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
  };

  // Re-use existing UUID (update) or generate a new one
  const uuid = existingUuid || crypto.randomUUID();

  // 2-year TTL — tokens are refreshed automatically so the entry stays alive
  await redis.set(`user:${uuid}`, JSON.stringify(config), { ex: 63072000 });

  return res.json({ uuid });
}
