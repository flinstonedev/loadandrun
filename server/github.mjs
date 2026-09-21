const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const OWNER = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?';
const REPOSITORY = '[A-Za-z0-9_.-]{1,100}';
const REPOSITORY_PATH = new RegExp(`^/(${OWNER})/(${REPOSITORY})/?$`);

class GitHubError extends Error {
  constructor(message, status) {super(message); this.status = status;}
}
const unavailable = () => new GitHubError('GitHub could not be checked right now. Try again shortly.', 503);
const invalid = () => new GitHubError('Use a public repository link such as https://github.com/owner/repository.', 400);

export function repositoryURL(value) {
  // Check the original input too: URL parsing normalizes dot segments, escapes,
  // whitespace, and default ports before its properties can be inspected.
  if (typeof value !== 'string' || value.length > 300 || !/^https:\/\/github\.com\//i.test(value) || /[\s%\\?#]/.test(value)) throw invalid();
  let parsed;
  try {parsed = new URL(value);} catch {throw invalid();}
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.port || parsed.username || parsed.password) throw invalid();
  const rawPath = value.slice(value.indexOf('/', 8));
  const match = REPOSITORY_PATH.exec(rawPath);
  if (!match) throw invalid();
  const [, owner, suppliedRepo] = match;
  const repo = suppliedRepo.replace(/\.git$/i, '');
  if (!repo || repo === '.' || repo === '..') throw invalid();
  return {url: `https://github.com/${owner}/${repo}`, fullName: `${owner}/${repo}`};
}

function redirectURL(location, current) {
  if (!location || /[\s%\\?#]/.test(location)) throw unavailable();
  let target;
  try {target = new URL(location, current);} catch {throw unavailable();}
  if (target.protocol !== 'https:' || target.host !== 'api.github.com' || target.username || target.password || target.search || target.hash) throw unavailable();
  const path = target.pathname;
  if (!new RegExp(`^/repos/${OWNER}/${REPOSITORY}$`).test(path) && !/^\/repositories\/[1-9][0-9]*$/.test(path)) throw unavailable();
  // Do not allow URL normalization to turn a different API route into this one.
  if (location.includes('/./') || location.includes('/../') || /^https:\/\/api\.github\.com:/i.test(location)) throw unavailable();
  return target.href;
}

async function boundedJSON(response) {
  const length = response.headers.get('content-length');
  if (length && Number(length) > MAX_RESPONSE_BYTES) {await response.body?.cancel(); throw unavailable();}
  const reader = response.body?.getReader();
  if (!reader) throw unavailable();
  const decoder = new TextDecoder();
  let bytes = 0, body = '';
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {await reader.cancel(); throw unavailable();}
      body += decoder.decode(value, {stream: true});
    }
    body += decoder.decode();
    return JSON.parse(body);
  } finally {reader.releaseLock();}
}

function metadata(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw unavailable();
  if (data.private === true || (data.visibility && data.visibility !== 'public')) throw new GitHubError('That public GitHub repository could not be found.', 404);
  if (data.private !== false || !Number.isSafeInteger(data.id) || data.id < 1) throw unavailable();
  let canonical;
  try {canonical = repositoryURL(data.html_url);} catch {throw unavailable();}
  if (typeof data.full_name !== 'string' || data.full_name.toLowerCase() !== canonical.fullName.toLowerCase()) throw unavailable();
  if (data.description !== null && data.description !== undefined && (typeof data.description !== 'string' || data.description.length > 5000)) throw unavailable();
  if (data.language !== null && data.language !== undefined && (typeof data.language !== 'string' || data.language.length > 100)) throw unavailable();
  if (typeof data.archived !== 'boolean') throw unavailable();
  const license = data.license;
  const detectedLicense = license && typeof license.name === 'string' && license.name.length <= 200 && typeof license.spdx_id === 'string' && license.spdx_id.length <= 100
    ? {name: license.name, spdxId: license.spdx_id, url: canonical.url + '#license'} : null;
  return {
    id: data.id, url: canonical.url, fullName: canonical.fullName,
    description: data.description || '', language: data.language || '',
    // A detected license is descriptive metadata, never a publication approval.
    license: detectedLicense, archived: data.archived, fetchedAt: new Date().toISOString(),
  };
}

export async function fetchGitHubRepository(url, fetcher = fetch) {
  const repository = repositoryURL(url);
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {controller.abort(); reject(unavailable());}, REQUEST_TIMEOUT_MS);
  });
  const request = async () => {
    let endpoint = `https://api.github.com/repos/${repository.fullName}`;
    for (let redirects = 0; redirects <= 2; redirects++) {
      const response = await fetcher(endpoint, {
        method: 'GET', redirect: 'manual', signal: controller.signal,
        headers: {'Accept': 'application/vnd.github+json', 'User-Agent': 'load-and-run', 'X-GitHub-Api-Version': '2026-03-10'},
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        if (redirects === 2) throw unavailable();
        endpoint = redirectURL(response.headers.get('location'), endpoint);
        continue;
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        if (response.status === 404) throw new GitHubError('That public GitHub repository could not be found.', 404);
        // This endpoint uses no credentials: a forbidden public lookup may be a
        // secondary rate limit even when GitHub omits rate-limit headers.
        if (response.status === 429 || response.status === 403) {
          const error = unavailable();
          const retry = response.headers.get('retry-after');
          const delay = retry && /^\d+$/.test(retry) ? Number(retry)
            : retry && Number.isFinite(Date.parse(retry)) ? Math.ceil((Date.parse(retry) - Date.now()) / 1000)
            : Number(response.headers.get('x-ratelimit-reset')) - Math.floor(Date.now() / 1000);
          error.retryAfter = Math.max(60, Math.min(86400, Number.isFinite(delay) && delay > 0 ? delay : 60));
          throw error;
        }
        throw unavailable();
      }
      return metadata(await boundedJSON(response));
    }
    throw unavailable();
  };
  try {return await Promise.race([request(), timeout]);}
  catch (error) {throw error instanceof GitHubError ? error : unavailable();}
  finally {clearTimeout(timer); controller.abort();}
}
