import { getRedis, mapConcurrent } from './utils.js';
import { generateAndCacheAllGenres, resolveCacheNamespace, refreshToken } from './handler.js';

const AI_CATALOG_TTL = 2592000; // 30 days
const BUDGET_MS = 50000;       // stop generating after 50s (10s margin before Vercel's 60s kill)

function isAiCatalog(id) {
  return (id.startsWith('ai-movie-') || id.startsWith('ai-show-')) &&
    id !== 'ai-search-movie' && id !== 'ai-search-series';
}

function parseCatalogId(id) {
  // "ai-movie-action" → { rawType: 'movie', genre: 'action' }
  // "ai-show-gems"    → { rawType: 'show',  genre: 'gems'   }
  const parts = id.split('-');
  const rawType = parts[1]; // 'movie' | 'show'
  const genre   = parts.slice(2).join('-');
  return { rawType, genre };
}

async function isStale(redis, cacheKey) {
  try {
    const ttl = await redis.ttl(cacheKey);
    const ageSeconds = ttl >= 0 ? AI_CATALOG_TTL - ttl : AI_CATALOG_TTL;
    return ageSeconds >= 23 * 3600;
  } catch {
    return true;
  }
}

async function processUser(uuid, redis) {
  let config;
  try {
    const raw = await redis.get(`user:${uuid}`);
    if (!raw) return { processed: 0, skipped: 0, reason: 'no_config' };
    config = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch { return { processed: 0, skipped: 0, reason: 'config_parse_error' }; }

  if (!config.geminiKey) return { processed: 0, skipped: 0, reason: 'no_gemini_key' };

  // Attempt token refresh if needed — pregenerate has no request context so we do it here
  try {
    const refreshed = await refreshToken(config, uuid);
    if (refreshed) {
      config = refreshed; // refreshToken already saves to Redis internally
    }
  } catch { /* non-fatal — proceed with existing token */ }

  const cacheNamespace = resolveCacheNamespace(config, uuid);
  if (!cacheNamespace) return { processed: 0, skipped: 0, reason: 'no_namespace' };

  const aiCatalogs = (config.enabledCatalogs || []).filter(isAiCatalog);
  if (aiCatalogs.length === 0) return { processed: 0, skipped: 0, reason: 'no_ai_catalogs' };

  const movieCatalogs = aiCatalogs.filter(c => c.startsWith('ai-movie-'));
  const showCatalogs  = aiCatalogs.filter(c => c.startsWith('ai-show-'));

  // Check staleness: if any genre for a type is stale, regenerate all genres for that type
  let movieStale = false;
  for (const catalogId of movieCatalogs) {
    const { rawType, genre } = parseCatalogId(catalogId);
    if (await isStale(redis, `ai:${cacheNamespace}:ai-${rawType}-${genre}`)) { movieStale = true; break; }
  }

  let showStale = false;
  for (const catalogId of showCatalogs) {
    const { rawType, genre } = parseCatalogId(catalogId);
    if (await isStale(redis, `ai:${cacheNamespace}:ai-${rawType}-${genre}`)) { showStale = true; break; }
  }

  if (!movieStale && !showStale) {
    return { processed: 0, skipped: aiCatalogs.length, reason: 'cache_fresh' };
  }

  let processed = 0;
  let skipped = 0;
  let errors = 0;

  if (!movieStale) skipped += movieCatalogs.length;
  if (!showStale)  skipped += showCatalogs.length;

  // Run movie and show generation concurrently — each uses its own Gemini key, no shared rate limit
  await Promise.all([
    movieStale && movieCatalogs.length > 0
      ? generateAndCacheAllGenres('movie', config, redis, cacheNamespace)
          .then(() => { processed += movieCatalogs.length; })
          .catch(err => { errors++; console.error(`pregenerate movie error ${uuid}:`, err.message); })
      : Promise.resolve(),
    showStale && showCatalogs.length > 0
      ? generateAndCacheAllGenres('series', config, redis, cacheNamespace)
          .then(() => { processed += showCatalogs.length; })
          .catch(err => { errors++; console.error(`pregenerate show error ${uuid}:`, err.message); })
      : Promise.resolve(),
  ]);

  return { processed, skipped, errors };
}

export default async function handler(req, res) {
  // Verify CRON_SECRET — Vercel sends it automatically; can also call manually
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization || '';
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const redis = getRedis();
  if (!redis) {
    return res.status(503).json({ error: 'Redis not configured' });
  }

  const startTime = Date.now();

  // Scan all user:* keys
  let cursor = 0;
  const uuids = [];
  do {
    const [nextCursor, keys] = await redis.scan(cursor, { match: 'user:*', count: 100 });
    for (const key of keys) {
      uuids.push(key.replace(/^user:/, ''));
    }
    cursor = parseInt(nextCursor, 10);
  } while (cursor !== 0);

  // Process all users concurrently (concurrency=5 to avoid Vercel memory pressure)
  // Each user has their own Gemini key so there is no shared rate limit across users
  let budget_exceeded = false;
  const results = await mapConcurrent(uuids, 5, uuid => {
    if (Date.now() - startTime > BUDGET_MS) {
      budget_exceeded = true;
      return { processed: 0, skipped: 0, reason: 'budget_exceeded' };
    }
    return processUser(uuid, redis);
  });

  const processed   = results.reduce((sum, r) => sum + r.processed,    0);
  const skipped     = results.reduce((sum, r) => sum + r.skipped,      0);
  const errors      = results.reduce((sum, r) => sum + (r.errors || 0), 0);

  const skip_reasons = {};
  for (const r of results) {
    if (r.reason) skip_reasons[r.reason] = (skip_reasons[r.reason] || 0) + 1;
  }

  return res.json({
    processed,
    skipped,
    errors,
    budget_exceeded,
    users: uuids.length,
    skip_reasons,
    elapsed_ms: Date.now() - startTime,
  });
}
