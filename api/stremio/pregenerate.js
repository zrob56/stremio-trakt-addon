import { getRedis, sleep } from './utils.js';
import { generateAndCacheAllGenres, resolveCacheNamespace, refreshToken } from './handler.js';

const AI_CATALOG_TTL = 2592000; // 30 days
const BUDGET_MS = 50000;       // stop generating after 50s (10s margin before Vercel's 60s kill)
const SLEEP_MS = 15000;        // 15s gap between Gemini calls → 4 RPM, safe under 5 RPM

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
  let processed = 0;
  let skipped = 0;
  let budgetExceeded = false;

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

  outer:
  for (const uuid of uuids) {
    let config;
    try {
      const raw = await redis.get(`user:${uuid}`);
      if (!raw) continue;
      config = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch { continue; }

    if (!config.geminiKey) continue;

    // Attempt token refresh if needed — pregenerate has no request context so we do it here
    try {
      const refreshed = await refreshToken(config, uuid);
      if (refreshed) {
        config = refreshed; // refreshToken already saves to Redis internally
      }
    } catch { /* non-fatal — proceed with existing token */ }

    const cacheNamespace = resolveCacheNamespace(config, uuid);
    if (!cacheNamespace) continue;

    const aiCatalogs = (config.enabledCatalogs || []).filter(isAiCatalog);
    if (aiCatalogs.length === 0) continue;

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

    if (!movieStale) skipped += movieCatalogs.length;
    if (!showStale)  skipped += showCatalogs.length;

    if (movieStale && movieCatalogs.length > 0) {
      try {
        await generateAndCacheAllGenres('movie', config, redis, cacheNamespace);
        processed += movieCatalogs.length;
      } catch (err) {
        console.error(`pregenerate movie error ${uuid}:`, err.message);
      }
      if (Date.now() - startTime > BUDGET_MS) { budgetExceeded = true; break outer; }
      await sleep(SLEEP_MS);
    }

    if (showStale && showCatalogs.length > 0) {
      try {
        await generateAndCacheAllGenres('series', config, redis, cacheNamespace);
        processed += showCatalogs.length;
      } catch (err) {
        console.error(`pregenerate show error ${uuid}:`, err.message);
      }
      if (Date.now() - startTime > BUDGET_MS) { budgetExceeded = true; break outer; }
      await sleep(SLEEP_MS);
    }
  }

  return res.json({
    processed,
    skipped,
    users: uuids.length,
    elapsed_ms: Date.now() - startTime,
    budget_exceeded: budgetExceeded,
  });
}
