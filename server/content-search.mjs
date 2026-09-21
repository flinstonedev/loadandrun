import {repositoryURL} from './github.mjs';
import {normalizeVideoURL, resolveVideo} from './discovery.mjs';

const SOURCES = ['github', 'youtube'];
const MAX_QUERIES = 2;
const RESULTS_PER_QUERY = 5;
const MAX_RESPONSE_BYTES = 256 * 1024;
const CACHE_TTL_MS = 15 * 60_000;
const MAX_CACHE_ENTRIES = 256;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const text = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
const timestamp = now => typeof now === 'function' ? now() : typeof now === 'number' ? now : Date.now();

class SearchError extends Error {
  constructor(source, code = 'provider_unavailable', retryAfter) {
    super(code === 'rate_limited' ? `${source === 'github' ? 'GitHub' : 'YouTube'} discovery is rate-limited. Try again later.`
      : `${source === 'github' ? 'GitHub' : 'YouTube'} discovery is temporarily unavailable.`);
    this.code = code;
    if (retryAfter) this.retryAfter = retryAfter;
  }
}

function cleanQuery(value) {
  if (typeof value !== 'string') return '';
  // A model supplies topic words, never provider operators or private-repo scopes.
  return value.slice(0, 1000).replace(/\b[a-z][a-z_-]*:(?:"[^"]*"|\S+)/gi, ' ')
    .replace(/\b(?:AND|OR|NOT)\b/g, ' ').replace(/[^\p{L}\p{N}\s+#.-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
}

function queriesFor(queries, source) {
  const list = Array.isArray(queries) ? queries : [];
  const unique = new Set();
  for (const entry of list.slice(0, 20)) {
    if (typeof entry !== 'string' && (!entry || (entry.kind || entry.source) !== source)) continue;
    const query = cleanQuery(typeof entry === 'string' ? entry : entry.query);
    if (query) unique.add(query.toLowerCase());
    if (unique.size === MAX_QUERIES) break;
  }
  return [...unique];
}

async function digest(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function boundedText(response, source) {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel(); throw new SearchError(source);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new SearchError(source);
  const decoder = new TextDecoder();
  let size = 0, body = '';
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new SearchError(source); }
      body += decoder.decode(value, {stream: true});
    }
    return body + decoder.decode();
  } finally { reader.releaseLock(); }
}

const boundedJSON = async (response, source) => JSON.parse(await boundedText(response, source));

const cacheRequest = key => new Request(`https://load-and-run.invalid/__public-search/v1/${key}`);
async function cacheRead(cache, key, now) {
  if (!cache) return null;
  try {
    const entry = typeof cache.match === 'function'
      ? await cache.match(cacheRequest(key)).then(response => response ? boundedJSON(response, 'github') : null)
      : await cache.get(key);
    return entry && Number.isFinite(entry.expiresAt) && entry.expiresAt > now ? structuredClone(entry.value) : null;
  } catch { return null; }
}

async function cacheWrite(cache, key, value, ttl, now) {
  if (!cache) return;
  const entry = {expiresAt: now + ttl, value: structuredClone(value)};
  try {
    if (typeof cache.put === 'function') {
      await cache.put(cacheRequest(key), Response.json(entry, {headers: {'cache-control': `public, max-age=${Math.max(1, Math.ceil(ttl / 1000))}`}}));
    } else {
      if (cache instanceof Map && cache.size >= MAX_CACHE_ENTRIES && !cache.has(key)) cache.delete(cache.keys().next().value);
      await cache.set(key, entry);
    }
  } catch { /* The cache is optional. Values contain public metadata, not prompts, queries or credentials. */ }
}

function retryAfter(response, now) {
  const retry = response.headers.get('retry-after');
  const delay = retry && /^\d+$/.test(retry) ? Number(retry)
    : retry && Number.isFinite(Date.parse(retry)) ? Math.ceil((Date.parse(retry) - now) / 1000)
    : Number(response.headers.get('x-ratelimit-reset')) - Math.floor(now / 1000);
  return Math.max(60, Math.min(86400, Number.isFinite(delay) && delay > 0 ? delay : 60));
}

async function requestJSON(source, query, options, now) {
  const endpoint = new URL(source === 'github' ? 'https://api.github.com/search/repositories' : 'https://www.googleapis.com/youtube/v3/search');
  const headers = {'Accept': 'application/json', 'User-Agent': 'load-and-run'};
  if (source === 'github') {
    endpoint.searchParams.set('q', `${query} is:public archived:false fork:false`);
    endpoint.searchParams.set('per_page', String(RESULTS_PER_QUERY));
    headers.Accept = 'application/vnd.github+json';
    headers['X-GitHub-Api-Version'] = '2026-03-10';
    if (typeof options.githubToken === 'string' && options.githubToken.trim()) headers.Authorization = `Bearer ${options.githubToken.trim()}`;
  } else {
    endpoint.searchParams.set('part', 'snippet');
    endpoint.searchParams.set('type', 'video');
    endpoint.searchParams.set('q', query);
    endpoint.searchParams.set('maxResults', String(RESULTS_PER_QUERY));
    endpoint.searchParams.set('order', 'relevance');
    endpoint.searchParams.set('safeSearch', 'moderate');
    endpoint.searchParams.set('fields', 'items(id(kind,videoId),snippet(title,description,channelTitle,publishedAt))');
    endpoint.searchParams.set('key', options.youtubeApiKey.trim());
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, {once: true});
  if (options.signal?.aborted) abort();
  let timer;
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) ? Math.max(1, Math.min(10_000, options.timeoutMs)) : 10_000;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new SearchError(source)); }, timeoutMs);
  });
  try {
    return await Promise.race([timeout, (async () => {
      if (controller.signal.aborted) throw new SearchError(source);
      const response = await (options.fetcher || fetch)(endpoint.href, {method: 'GET', redirect: 'manual', headers, signal: controller.signal});
      if (response.status !== 200) {
        let reason = '';
        if (source === 'youtube' && response.status === 403) {
          try { reason = (await boundedJSON(response, source))?.error?.errors?.[0]?.reason || ''; } catch { /* Never expose the provider body. */ }
        } else await response.body?.cancel();
        if (response.status === 429 || (source === 'github' && response.status === 403)
          || ['quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded', 'userRateLimitExceeded'].includes(reason)) {
          throw new SearchError(source, 'rate_limited', retryAfter(response, now));
        }
        throw new SearchError(source);
      }
      const data = await boundedJSON(response, source);
      if (!data || !Array.isArray(data.items)) throw new SearchError(source);
      return data;
    })()]);
  } catch (error) { throw error instanceof SearchError ? error : new SearchError(source); }
  finally { clearTimeout(timer); controller.abort(); options.signal?.removeEventListener('abort', abort); }
}

function githubCandidate(item, now) {
  if (!item || item.private !== false || (item.visibility && item.visibility !== 'public') || item.archived !== false
    || !Number.isSafeInteger(item.id) || item.id < 1 || typeof item.full_name !== 'string') return null;
  let canonical;
  try { canonical = repositoryURL(`https://github.com/${item.full_name}`); } catch { return null; }
  if (canonical.fullName !== item.full_name) return null;
  // Search metadata is grounded in the public API; final selections still go through discovery.mjs.
  return {kind: 'github', url: canonical.url, title: canonical.fullName, description: text(item.description, 1000),
    language: text(item.language, 100), stars: Number.isSafeInteger(item.stargazers_count) && item.stargazers_count >= 0 ? item.stargazers_count : 0,
    discoveredAt: new Date(now).toISOString()};
}

function youtubeCandidate(item, now) {
  if (!item || item.id?.kind !== 'youtube#video' || typeof item.id.videoId !== 'string' || !VIDEO_ID.test(item.id.videoId)) return null;
  const title = text(item.snippet?.title, 500), channel = text(item.snippet?.channelTitle, 200);
  if (!title || !channel) return null;
  return {kind: 'youtube', url: `https://www.youtube.com/watch?v=${item.id.videoId}`, title,
    description: text(item.snippet?.description, 1000), channel,
    discoveredAt: new Date(now).toISOString()};
}

async function readmeVideoLinks(repository, options, cache, now) {
  const canonical = repositoryURL(repository.url);
  const key = `readme-${await digest(canonical.url.toLowerCase())}`;
  const cached = await cacheRead(cache, key, now);
  if (cached) return cached;
  const cooldown = await cacheRead(cache, 'readme-cooldown', now);
  if (cooldown) throw new SearchError('github', 'rate_limited', Math.max(1, Math.ceil((cooldown.until - now) / 1000)));
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, {once: true});
  if (options.signal?.aborted) abort();
  let timer;
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) ? Math.max(1, Math.min(10_000, options.timeoutMs)) : 10_000;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new SearchError('github')); }, timeoutMs);
  });
  try {
    const links = await Promise.race([timeout, (async () => {
      if (controller.signal.aborted) throw new SearchError('github');
      // Public, anonymous reads avoid disclosing a README if the repository became private after search.
      const response = await (options.fetcher || fetch)(`https://api.github.com/repos/${canonical.fullName}/readme`, {
        method: 'GET', redirect: 'manual', signal: controller.signal,
        headers: {'Accept': 'application/vnd.github.raw+json', 'User-Agent': 'load-and-run', 'X-GitHub-Api-Version': '2026-03-10'},
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        if (response.status === 404) return [];
        if (response.status === 403 || response.status === 429) throw new SearchError('github', 'rate_limited', retryAfter(response, now));
        throw new SearchError('github');
      }
      const readme = await boundedText(response, 'github');
      const urls = new Set();
      const pattern = /https:\/\/(?:(?:www\.|m\.)?youtube\.com|youtu\.be)\/[^\s<>"'`\])}]+/gi;
      for (const match of readme.matchAll(pattern)) {
        try { urls.add(normalizeVideoURL(match[0].replace(/[.,;!]+$/, '')).url); } catch { /* README links are untrusted inputs. */ }
        if (urls.size >= 5) break;
      }
      return [...urls];
    })()]);
    // Cache extracted public links, never README text or its instructions.
    await cacheWrite(cache, key, links, CACHE_TTL_MS, now);
    return links;
  } catch (error) {
    if (error.retryAfter) await cacheWrite(cache, 'readme-cooldown', {until: now + error.retryAfter * 1000}, error.retryAfter * 1000, now);
    throw error instanceof SearchError ? error : new SearchError('github');
  } finally { clearTimeout(timer); controller.abort(); options.signal?.removeEventListener('abort', abort); }
}

async function relatedProjectVideos(repositories, options, cache, now) {
  const candidates = [], warnings = [{source: 'youtube', code: 'youtube_related_projects',
    message: 'Video suggestions come from related public GitHub project documentation.'}];
  const seenRepos = new Set(), links = new Map();
  let readmes = 0;
  for (const repository of repositories) {
    if (options.signal?.aborted || readmes >= 3 || links.size >= 5) break;
    if (seenRepos.has(repository.url.toLowerCase())) continue;
    seenRepos.add(repository.url.toLowerCase()); readmes++;
    try {
      for (const url of await readmeVideoLinks(repository, options, cache, now)) {
        if (!links.has(url)) links.set(url, repository);
        if (links.size >= 5) break;
      }
    } catch (error) {
      warnings.push({source: 'github', code: error.code, message: error.message, ...(error.retryAfter ? {retryAfter: error.retryAfter} : {})});
      if (error.retryAfter) break;
    }
  }
  for (const [url, repository] of links) {
    if (options.signal?.aborted) break;
    try {
      const metadata = await resolveVideo(url, {...options, cache, now});
      candidates.push({...metadata, description: `Linked from ${repository.title}: ${repository.description}`.slice(0, 1000),
        fromRepository: repository.url, discoveredAt: new Date(now).toISOString()});
    } catch (error) {
      warnings.push({source: 'youtube', code: error.retryAfter ? 'rate_limited' : 'provider_unavailable',
        message: 'Some project videos could not be checked. Try again later.', ...(error.retryAfter ? {retryAfter: error.retryAfter} : {})});
      if (error.retryAfter) break;
    }
  }
  return {candidates, warnings, searched: readmes > 0};
}

/** Finds bounded, provider-sourced URLs for the model to rank; it never treats model URLs as search results. */
export async function discoverCandidates(queries, options = {}) {
  const sources = [...new Set(Array.isArray(options.sources) ? options.sources.filter(source => SOURCES.includes(source)) : SOURCES)];
  const relatedVideos = sources.includes('youtube') && !(typeof options.youtubeApiKey === 'string' && options.youtubeApiKey.trim());
  const searchSources = [...new Set([...sources.filter(source => source !== 'youtube' || !relatedVideos), ...(relatedVideos ? ['github'] : [])])];
  const cache = Object.hasOwn(options, 'cache') ? options.cache : globalThis.caches?.default || new Map();
  const now = timestamp(options.now);
  const results = await Promise.all(searchSources.map(async source => {
    const candidates = [], warnings = [];
    const planned = source === 'github' && relatedVideos
      ? [...new Set([...(sources.includes('github') ? queriesFor(queries, 'github') : []), ...queriesFor(queries, 'youtube')])].slice(0, MAX_QUERIES)
      : queriesFor(queries, source);
    if (!planned.length) return {candidates, warnings, searched: false};
    // Keep rate-limit buckets separate when an optional provider credential changes.
    const credential = source === 'github' ? options.githubToken || '' : options.youtubeApiKey || '';
    const cooldownKey = `${source}-cooldown-${await digest(credential)}`;
    let searched = false;
    for (const query of planned) {
      if (options.signal?.aborted) break;
      const key = `${source}-${await digest(query)}`;
      const cached = await cacheRead(cache, key, now);
      if (cached) { candidates.push(...cached); searched = true; continue; }
      const cooldown = await cacheRead(cache, cooldownKey, now);
      if (cooldown) {
        const error = new SearchError(source, 'rate_limited', Math.max(1, Math.ceil((cooldown.until - now) / 1000)));
        warnings.push({source, code: error.code, message: error.message, retryAfter: error.retryAfter});
        break;
      }
      try {
        const data = await requestJSON(source, query, options, now);
        searched = true;
        const found = data.items.slice(0, RESULTS_PER_QUERY).map(item => (source === 'github' ? githubCandidate : youtubeCandidate)(item, now)).filter(Boolean);
        candidates.push(...found);
        await cacheWrite(cache, key, found, CACHE_TTL_MS, now);
        if (source === 'github' && data.incomplete_results === true) warnings.push({source, code: 'incomplete_results', message: 'GitHub returned partial search results.'});
      } catch (error) {
        warnings.push({source, code: error.code || 'provider_unavailable', message: error.message,
          ...(error.retryAfter ? {retryAfter: error.retryAfter} : {})});
        if (error.retryAfter) await cacheWrite(cache, cooldownKey, {until: now + error.retryAfter * 1000}, error.retryAfter * 1000, now);
        break; // No retry storm during an outage or exhausted provider quota.
      }
    }
    return {candidates, warnings, searched};
  }));
  if (relatedVideos && queriesFor(queries, 'youtube').length && !options.signal?.aborted) {
    const github = results[searchSources.indexOf('github')];
    results.push(await relatedProjectVideos(github.candidates, options, cache, now));
    searchSources.push('youtube');
  }
  const seen = new Set();
  return {
    candidates: results.flatMap(result => result.candidates).filter(candidate => {
      if (!sources.includes(candidate.kind)) return false;
      const key = candidate.kind === 'github' ? candidate.url.toLowerCase() : candidate.url;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }),
    warnings: results.flatMap(result => result.warnings).filter((warning, index, all) => all.findIndex(other => other.source === warning.source && other.code === warning.code) === index),
    searchedSources: searchSources.filter((source, index) => sources.includes(source) && results[index].searched),
  };
}
