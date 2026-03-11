import { Redis } from '@upstash/redis';

// ── Constants ────────────────────────────────────────────────────────────────
export const TRAKT_BASE = 'https://api.trakt.tv';
export const UUID_REGEX  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RETRY_MAX_ATTEMPTS = 2;
const RETRY_MIN_DELAY_MS = 250;
const RETRY_MAX_DELAY_MS = 400;
const RETRY_AFTER_CAP_MS = 2000;

// ── Error class ──────────────────────────────────────────────────────────────
export class TraktAuthError extends Error {
  constructor(msg) { super(msg); this.name = 'TraktAuthError'; }
}

// ── Redis ────────────────────────────────────────────────────────────────────
export function getRedis() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  return new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
}

// ── CORS ─────────────────────────────────────────────────────────────────────
export function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── Trakt helpers ─────────────────────────────────────────────────────────────
export function traktHeaders(clientId, accessToken) {
  return {
    'Content-Type': 'application/json',
    'trakt-api-version': '2',
    'trakt-api-key': clientId || process.env.TRAKT_CLIENT_ID,
    'Authorization': `Bearer ${accessToken}`,
    'User-Agent': 'stremio-trakt-addon/1.0',
  };
}

export async function traktFetch(url, headers) {
  const response = await fetchWithRetry(url, { headers });
  if (response.status === 401) throw new TraktAuthError('Token expired');
  if (!response.ok) throw new Error(`Trakt API error: ${response.status}`);
  return response.json();
}

// ── Async utilities ───────────────────────────────────────────────────────────
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function mapConcurrent(items, concurrency, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = await Promise.all(items.slice(i, i + concurrency).map(fn));
    results.push(...batch);
  }
  return results;
}

// ── fetchWithRetry ────────────────────────────────────────────────────────────
function parseRetryAfterMs(response) {
  const retryAfter = response.headers.get('retry-after');
  if (!retryAfter) return null;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
  }
  const dateMs = Date.parse(retryAfter);
  if (!Number.isFinite(dateMs)) return null;
  const delta = Math.max(0, dateMs - Date.now());
  return Math.min(delta, RETRY_AFTER_CAP_MS);
}

function randomRetryDelayMs() {
  return RETRY_MIN_DELAY_MS + Math.floor(Math.random() * (RETRY_MAX_DELAY_MS - RETRY_MIN_DELAY_MS + 1));
}

function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

export async function fetchWithRetry(url, init = {}) {
  let lastError;
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, init);
      if (attempt < RETRY_MAX_ATTEMPTS && isRetryableStatus(response.status)) {
        const delayMs = parseRetryAfterMs(response) ?? randomRetryDelayMs();
        await sleep(delayMs);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt >= RETRY_MAX_ATTEMPTS) throw error;
      await sleep(randomRetryDelayMs());
    }
  }
  throw lastError || new Error('Request failed');
}
