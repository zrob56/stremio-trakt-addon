import { UUID_REGEX, setCors, getRedis } from './utils.js';

const MOVIE_GENRE_KEYS = ['overall','action','adventure','animation','comedy','crime','documentary','drama','fantasy','horror','mystery','romance','scifi','thriller','western'];
const SHOW_GENRE_KEYS  = ['overall','action','adventure','animation','comedy','crime','drama','fantasy','horror','mystery','romance','scifi','thriller'];

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
  try {
    const raw = await redis.get(`user:${uuid}`);
    if (raw) {
      const cfg = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (cfg?.traktUsername) cacheId = cfg.traktUsername;
    }
  } catch { /* fall back to uuid */ }

  const keys = [
    ...MOVIE_GENRE_KEYS.map(g => `ai:${cacheId}:ai-movie-${g}`),
    ...SHOW_GENRE_KEYS.map(g => `ai:${cacheId}:ai-show-${g}`),
    `ai:${cacheId}:ai-movie-gems`,
    `ai:${cacheId}:ai-show-gems`,
  ];

  try {
    const cleared = await redis.del(...keys);
    return res.json({ ok: true, cleared });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to clear cache' });
  }
}
