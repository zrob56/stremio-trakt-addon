import { UUID_REGEX, setCors, getRedis } from './utils.js';
import { generateAndCacheAllGenres } from './handler.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    setCors(res);
    return res.status(204).end();
  }
  setCors(res);

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { uuid } = req.body || {};
  if (!uuid || !UUID_REGEX.test(uuid)) {
    return res.status(400).json({ error: 'Invalid uuid' });
  }

  const redis = getRedis();
  if (!redis) {
    return res.status(503).json({ error: 'Redis not configured' });
  }

  let cacheId = uuid;
  let config = null;
  try {
    const raw = await redis.get(`user:${uuid}`);
    if (raw) {
      const cfg = typeof raw === 'string' ? JSON.parse(raw) : raw;
      config = cfg;
      if (cfg?.traktUsername) cacheId = cfg.traktUsername;
    }
  } catch { /* fall back to uuid */ }

  // Fire-and-forget regeneration — overwrites cache on success, leaves old data on failure
  if (config?.geminiKey && config?.accessToken) {
    (async () => {
      let currentConfig = config;
      await generateAndCacheAllGenres('movie', currentConfig, redis, cacheId, uuid)
        .catch(e => console.error(`[refresh] background regen failed (movie):`, e.message));
      // Re-read config: if movie triggered a token refresh, series must use the new tokens
      try {
        const raw = await redis.get(`user:${uuid}`);
        if (raw) currentConfig = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch { /* non-fatal */ }
      await generateAndCacheAllGenres('series', currentConfig, redis, cacheId, uuid)
        .catch(e => console.error(`[refresh] background regen failed (series):`, e.message));
    })();
  }

  return res.json({ ok: true });
}
