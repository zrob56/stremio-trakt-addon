import { Redis } from '@upstash/redis';
import { TRAKT_BASE, traktFetch, traktHeaders } from './handler.js';

// GET /api/stremio/trakt-lists?uuid={uuid}
// Returns: [{ slug, name }]  — user's Trakt custom lists
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const { uuid } = req.query;
  if (!uuid) return res.status(400).json({ error: 'uuid required' });

  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return res.status(500).json({ error: 'redis not configured' });
  }

  let config;
  try {
    const redis = Redis.fromEnv();
    const raw = await redis.get(`user:${uuid}`);
    if (!raw) return res.status(404).json({ error: 'not found' });
    config = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return res.status(500).json({ error: 'redis error' });
  }

  const headers = traktHeaders(config.clientId, config.accessToken);
  try {
    const lists = await traktFetch(`${TRAKT_BASE}/users/me/lists`, headers);
    return res.json(lists.map(l => ({ slug: l.ids.slug, name: l.name })));
  } catch {
    return res.json([]);
  }
}
