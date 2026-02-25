import { Redis } from '@upstash/redis';

const MOVIE_GENRE_KEYS = ['overall','action','adventure','animation','comedy','crime','documentary','drama','fantasy','horror','mystery','romance','scifi','thriller','western'];
const SHOW_GENRE_KEYS  = ['overall','action','adventure','animation','comedy','crime','drama','fantasy','horror','mystery','romance','scifi','thriller'];

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function getRedis() {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return null;
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

  const { uuid } = req.body || {};
  if (!uuid) {
    return res.status(400).json({ error: 'uuid is required' });
  }

  const redis = getRedis();
  if (!redis) {
    return res.status(503).json({ error: 'Redis not configured' });
  }

  const keys = [
    ...MOVIE_GENRE_KEYS.map(g => `ai:${uuid}:ai-movie-${g}`),
    ...SHOW_GENRE_KEYS.map(g => `ai:${uuid}:ai-show-${g}`),
    `ai:${uuid}:ai-movie-gems`,
    `ai:${uuid}:ai-show-gems`,
  ];

  try {
    const cleared = await redis.del(...keys);
    return res.json({ ok: true, cleared });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to clear cache' });
  }
}
