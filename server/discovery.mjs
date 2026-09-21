import {fetchGitHubRepository, repositoryURL} from './github.mjs';

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 15 * 60_000;
const MAX_CANDIDATES = 30;
const MAX_CACHE_ENTRIES = 256;

export class DiscoveryError extends Error {
  constructor(message, status = 503, code = 'provider_unavailable', retryAfter) {
    super(message);
    this.name = 'DiscoveryError';
    this.status = status;
    this.code = code;
    if (retryAfter) this.retryAfter = retryAfter;
  }
}

const invalidVideo = () => new DiscoveryError('Use a YouTube video link such as https://www.youtube.com/watch?v=VIDEO_ID.', 400, 'invalid_url');
const unavailableVideo = () => new DiscoveryError('YouTube could not be checked right now. Try again shortly.');
const timestamp = now => typeof now === 'function' ? now() : typeof now === 'number' ? now : Date.now();

export const normalizeRepositoryURL = repositoryURL;

export function normalizeVideoURL(value) {
  // Validate the raw authority/path before URL parsing can normalize them.
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\\u0000-\u001f\u007f]/.test(value)
    || !/^https:\/\/(?:(?:www\.|m\.)?youtube\.com|youtu\.be)\//i.test(value)) throw invalidVideo();
  let parsed;
  try { parsed = new URL(value); } catch { throw invalidVideo(); }
  if (parsed.protocol !== 'https:' || parsed.port || parsed.username || parsed.password) throw invalidVideo();
  const rawPath = value.slice(value.indexOf('/', 8)).split(/[?#]/, 1)[0];
  if (rawPath !== parsed.pathname || rawPath.includes('%')) throw invalidVideo();
  let videoId;
  if (parsed.hostname === 'youtu.be') {
    const match = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(rawPath);
    videoId = match?.[1];
  } else if (rawPath === '/watch') {
    const values = parsed.searchParams.getAll('v');
    if (values.length !== 1) throw invalidVideo();
    videoId = values[0];
  } else {
    const match = /^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})\/?$/.exec(rawPath);
    videoId = match?.[1];
  }
  if (!videoId || !VIDEO_ID.test(videoId)) throw invalidVideo();
  // Tracking, playlist, and timestamp parameters do not enter provider requests.
  return {url: `https://www.youtube.com/watch?v=${videoId}`, videoId};
}

async function boundedJSON(response) {
  const length = response.headers.get('content-length');
  if (length && Number(length) > MAX_RESPONSE_BYTES) { await response.body?.cancel(); throw unavailableVideo(); }
  const reader = response.body?.getReader();
  if (!reader) throw unavailableVideo();
  const decoder = new TextDecoder();
  let bytes = 0, body = '';
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw unavailableVideo(); }
      body += decoder.decode(value, {stream: true});
    }
    return JSON.parse(body + decoder.decode());
  } finally { reader.releaseLock(); }
}

function publicCache(options) {
  return Object.hasOwn(options, 'cache') ? options.cache : globalThis.caches?.default;
}

function cacheRequest(key) {
  return new Request(`https://load-and-run.invalid/__public-metadata/v1/${encodeURIComponent(key)}`);
}

async function cacheRead(cache, key, now) {
  if (!cache) return null;
  try {
    const entry = typeof cache.match === 'function'
      ? await cache.match(cacheRequest(key)).then(response => response ? boundedJSON(response) : null)
      : await cache.get(key);
    if (!entry || !Number.isFinite(entry.expiresAt) || entry.expiresAt <= now) return null;
    return structuredClone(entry.value);
  } catch { return null; } // A cache outage must not turn a valid lookup into an error.
}

async function cacheWrite(cache, key, value, expiresAt, now) {
  if (!cache) return;
  const entry = {expiresAt, value: structuredClone(value)};
  try {
    if (typeof cache.put === 'function') {
      await cache.put(cacheRequest(key), Response.json(entry, {headers: {'cache-control': `public, max-age=${Math.max(1, Math.ceil((expiresAt - now) / 1000))}`}}));
    } else {
      // Injectable Map cache is useful to a caller processing one batch and in tests.
      if (cache instanceof Map && cache.size >= MAX_CACHE_ENTRIES && !cache.has(key)) cache.delete(cache.keys().next().value);
      await cache.set(key, entry);
    }
  } catch { /* Cache only public provider metadata; never candidate reasons/context. */ }
}

async function cachedMetadata(provider, canonical, options, resolve) {
  const now = timestamp(options.now);
  const cache = publicCache(options);
  const key = `${provider}:${provider === 'github' ? canonical.url.toLowerCase() : canonical.url}`;
  const existing = await cacheRead(cache, key, now);
  if (existing) return existing;
  const cooldown = await cacheRead(cache, `${provider}:cooldown`, now);
  if (cooldown) throw new DiscoveryError(`${provider === 'github' ? 'GitHub' : 'YouTube'} is rate-limiting requests. Try again later.`, 503, 'rate_limited', Math.max(1, Math.ceil((cooldown.until - now) / 1000)));
  try {
    const data = await resolve(now);
    await cacheWrite(cache, key, data, now + CACHE_TTL_MS, now);
    // A GitHub rename should also populate its canonical cache entry.
    const canonicalKey = `${provider}:${provider === 'github' ? data.url.toLowerCase() : data.url}`;
    if (canonicalKey !== key) await cacheWrite(cache, canonicalKey, data, now + CACHE_TTL_MS, now);
    return data;
  } catch (error) {
    if (error.retryAfter) {
      const until = now + error.retryAfter * 1000;
      await cacheWrite(cache, `${provider}:cooldown`, {until}, until, now);
    }
    throw error;
  }
}

export async function resolveRepository(value, options = {}) {
  const canonical = normalizeRepositoryURL(value);
  return cachedMetadata('github', canonical, options, async now => {
    const repository = await fetchGitHubRepository(canonical.url, options.fetcher || fetch);
    return {...repository, id: `github:${repository.id}`, repositoryId: repository.id, kind: 'github', title: repository.fullName,
      verifiedAt: new Date(now).toISOString(), fetchedAt: new Date(now).toISOString()};
  });
}

function videoMetadata(data, canonical, now) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.type !== 'video' || String(data.version) !== '1.0'
    || data.provider_name !== 'YouTube' || typeof data.title !== 'string' || !data.title.trim() || data.title.length > 500
    || typeof data.author_name !== 'string' || !data.author_name.trim() || data.author_name.length > 200) throw unavailableVideo();
  let thumbnail = '';
  if (data.thumbnail_url !== undefined) {
    // Only the provider's image CDN, for this exact video; never use its embed HTML.
    const pattern = new RegExp(`^https://i\\.ytimg\\.com/(?:vi|vi_webp)/${canonical.videoId}/[A-Za-z0-9_-]+\\.(?:jpg|webp)$`);
    if (typeof data.thumbnail_url !== 'string' || !pattern.test(data.thumbnail_url)) throw unavailableVideo();
    thumbnail = data.thumbnail_url;
  }
  return {id: `youtube:${canonical.videoId}`, kind: 'youtube', ...canonical, title: data.title.trim(), channel: data.author_name.trim(),
    thumbnail, verifiedAt: new Date(now).toISOString()};
}

export async function resolveVideo(value, options = {}) {
  const canonical = normalizeVideoURL(value);
  return cachedMetadata('youtube', canonical, options, async now => {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(unavailableVideo()); }, REQUEST_TIMEOUT_MS);
    });
    const request = async () => {
      const endpoint = new URL('https://www.youtube.com/oembed');
      endpoint.searchParams.set('format', 'json');
      endpoint.searchParams.set('url', canonical.url);
      const response = await (options.fetcher || fetch)(endpoint.href, {method: 'GET', redirect: 'manual', signal: controller.signal,
        headers: {'Accept': 'application/json', 'User-Agent': 'load-and-run'}});
      if (response.status !== 200) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403 || response.status === 404) throw new DiscoveryError('That public YouTube video could not be found.', 404, 'not_found');
        if (response.status === 429) {
          const retry = response.headers.get('retry-after');
          const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : Math.ceil((Date.parse(retry || '') - now) / 1000);
          throw new DiscoveryError('YouTube is rate-limiting requests. Try again later.', 503, 'rate_limited', Math.max(60, Math.min(86400, Number.isFinite(seconds) ? seconds : 60)));
        }
        throw unavailableVideo();
      }
      return videoMetadata(await boundedJSON(response), canonical, now);
    };
    try { return await Promise.race([request(), timeout]); }
    catch (error) { throw error instanceof DiscoveryError ? error : unavailableVideo(); }
    finally { clearTimeout(timer); controller.abort(); }
  });
}

function kindOf(kind) {
  if (kind === 'github' || kind === 'repository') return 'github';
  if (kind === 'youtube' || kind === 'video') return 'youtube';
  return null;
}

function normalizeCandidateURL(kind, url) {
  return kind === 'github' ? normalizeRepositoryURL(url).url.toLowerCase() : normalizeVideoURL(url).url;
}

function exclusionKeys(urls) {
  const keys = new Set();
  for (const url of urls || []) {
    for (const kind of ['github', 'youtube']) {
      try { keys.add(normalizeCandidateURL(kind, url)); break; } catch { /* Ignore old or unsupported saved URLs. */ }
    }
  }
  return keys;
}

/** Verifies public metadata. Agent-supplied titles/images/HTML are never trusted. */
export async function validateRecommendations(candidates, options = {}) {
  if (!Array.isArray(candidates) || candidates.length > MAX_CANDIDATES) throw new DiscoveryError('The agent returned an invalid recommendation list.', 400, 'invalid_results');
  const allowedSources = new Set(options.sourceWidgetIds || []);
  const allowedTargets = options.recommendationWidgetIds ? new Set(options.recommendationWidgetIds) : null;
  const excluded = exclusionKeys([...(options.savedUrls || []), ...(options.dismissedUrls || [])]);
  const limit = Number.isSafeInteger(options.limit) ? Math.max(1, Math.min(30, options.limit)) : 6;
  const maxPerKind = Number.isSafeInteger(options.maxPerKind) ? Math.max(1, Math.min(15, options.maxPerKind)) : 3;
  const items = [], errors = [], seen = new Set(), count = {github: 0, youtube: 0};
  // Per-batch cache also ensures one provider rate limit halts further calls in this run.
  const resolveOptions = {...options, cache: publicCache(options) || new Map()};
  for (const [index, candidate] of candidates.entries()) {
    if (items.length >= limit) break;
    const kind = candidate && kindOf(candidate.kind);
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || !kind
      || typeof candidate.reason !== 'string' || !candidate.reason.trim() || candidate.reason.length > 2000
      || !Array.isArray(candidate.sourceWidgetIds) || !candidate.sourceWidgetIds.length || candidate.sourceWidgetIds.length > 50
      || candidate.sourceWidgetIds.some(id => typeof id !== 'string' || !allowedSources.has(id))
      || (candidate.widgetId != null && (typeof candidate.widgetId !== 'string' || candidate.widgetId.length > 100 || (allowedTargets && !allowedTargets.has(candidate.widgetId))))) {
      errors.push({index, code: 'invalid_recommendation', message: 'A suggestion had invalid content or referenced unavailable widgets.'});
      continue;
    }
    if (count[kind] >= maxPerKind) continue;
    let key;
    try { key = normalizeCandidateURL(kind, candidate.url); }
    catch { errors.push({index, code: 'invalid_url', message: 'A suggestion did not contain a supported public link.'}); continue; }
    if (excluded.has(key) || seen.has(key)) continue;
    seen.add(key);
    try {
      const data = await (kind === 'github' ? resolveRepository(candidate.url, resolveOptions) : resolveVideo(candidate.url, resolveOptions));
      const canonicalKey = normalizeCandidateURL(kind, data.url);
      if (excluded.has(canonicalKey) || items.some(item => item.id === data.id || normalizeCandidateURL(item.kind, item.url) === canonicalKey)) continue;
      seen.add(canonicalKey);
      items.push({...data, reason: candidate.reason.trim(), sourceWidgetIds: [...new Set(candidate.sourceWidgetIds)],
        ...(candidate.widgetId != null ? {widgetId: candidate.widgetId} : {})});
      count[kind]++;
    } catch (error) {
      errors.push({index, code: error.retryAfter ? 'rate_limited' : error.status === 404 ? 'not_found' : 'provider_unavailable',
        message: error.retryAfter ? 'A provider is rate-limiting requests. Try again later.' : 'A suggestion could not be verified. Try again shortly.',
        ...(error.retryAfter ? {retryAfter: error.retryAfter} : {})});
    }
  }
  return {items, errors};
}
