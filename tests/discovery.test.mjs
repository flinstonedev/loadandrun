import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeVideoURL, normalizeRepositoryURL, resolveVideo, resolveRepository, validateRecommendations} from '../server/discovery.mjs';

const ID = 'dQw4w9WgXcQ';
const VIDEO = `https://www.youtube.com/watch?v=${ID}`;
const REPO = 'https://github.com/builders/code';
const NOW = Date.parse('2026-09-07T12:00:00Z');
const videoFixture = overrides => ({version: '1.0', type: 'video', provider_name: 'YouTube', title: 'Build a useful project',
  author_name: 'Example builder', thumbnail_url: `https://i.ytimg.com/vi/${ID}/hqdefault.jpg`, html: '<iframe src="https://evil.test"></iframe>', ...overrides});
const repoFixture = overrides => ({id: 42, html_url: REPO, full_name: 'builders/code', private: false, visibility: 'public',
  description: 'An example project', language: 'JavaScript', license: null, archived: false, ...overrides});
const suggestion = overrides => ({kind: 'youtube', url: VIDEO, reason: 'Matches your project notes.', sourceWidgetIds: ['notes-1'], ...overrides});
const rejectsWith = (action, status) => assert.rejects(action, error => error.status === status && !error.message.includes('upstream-secret'));

test('YouTube canonicalization accepts watch, short, shorts, live, and embed URLs and strips tracking', () => {
  for (const url of [VIDEO, `https://youtube.com/watch?v=${ID}&list=playlist&t=30`, `https://m.youtube.com/watch?feature=shared&v=${ID}`,
    `https://youtu.be/${ID}?si=tracking`, `https://www.youtube.com/shorts/${ID}`, `https://www.youtube.com/live/${ID}/`,
    `https://www.youtube.com/embed/${ID}?start=30`, `https://youtu.be/${ID}#t=30`, `HTTPS://WWW.YOUTUBE.COM/watch?v=${ID}`]) {
    assert.deepEqual(normalizeVideoURL(url), {url: VIDEO, videoId: ID});
  }
  assert.deepEqual(normalizeRepositoryURL('https://github.com/builders/code.git/'), {url: REPO, fullName: 'builders/code'});
});

test('Unsupported and malicious YouTube URLs fail before any provider request', async () => {
  let requests = 0;
  const options = {fetcher: async () => { requests++; throw new Error('upstream-secret'); }, cache: null};
  for (const url of [null, '', `http://www.youtube.com/watch?v=${ID}`, `https://youtube.com.evil.test/watch?v=${ID}`,
    `https://youtube.com@evil.test/watch?v=${ID}`, `https://user:secret@www.youtube.com/watch?v=${ID}`,
    `https://www.youtube.com:443/watch?v=${ID}`, `https://www.youtube.com:8443/watch?v=${ID}`, `https://localhost/watch?v=${ID}`,
    `https://www.youtube.com/../watch?v=${ID}`, `https://www.youtube.com/foo/../watch?v=${ID}`, `https://www.youtube.com/%77atch?v=${ID}`,
    `https://www.youtube.com\\@evil.test/watch?v=${ID}`, ` ${VIDEO}`, `${VIDEO}\n`, `${VIDEO}&v=abcdefghijk`,
    'https://youtube.com/watch?v=short', 'https://youtube.com/watch?v=abcdefghijkl', 'https://youtube.com/playlist?list=abc',
    `https://youtu.be/${ID}/extra`, `https://youtu.be/${ID}%2fextra`, `https://youtube.com/channel/${ID}`]) {
    await rejectsWith(() => resolveVideo(url, options), 400);
  }
  assert.equal(requests, 0);
});

test('YouTube lookup sends only a provider-built canonical URL and returns verified metadata without HTML', async () => {
  const result = await resolveVideo(`https://youtu.be/${ID}?si=secret`, {now: NOW, cache: null, fetcher: async (url, options) => {
    const endpoint = new URL(url);
    assert.equal(endpoint.origin, 'https://www.youtube.com');
    assert.equal(endpoint.pathname, '/oembed');
    assert.equal(endpoint.searchParams.get('url'), VIDEO);
    assert.equal(endpoint.searchParams.get('format'), 'json');
    assert.equal(endpoint.searchParams.size, 2);
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Authorization, undefined);
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json(videoFixture());
  }});
  assert.deepEqual(result, {id: `youtube:${ID}`, kind: 'youtube', url: VIDEO, videoId: ID, title: 'Build a useful project',
    channel: 'Example builder', thumbnail: `https://i.ytimg.com/vi/${ID}/hqdefault.jpg`, verifiedAt: '2026-09-07T12:00:00.000Z'});
  assert.equal(result.html, undefined);
});

test('YouTube rejects malformed metadata and cross-provider thumbnail URLs', async () => {
  for (const data of [[], {}, videoFixture({type: 'rich'}), videoFixture({provider_name: 'Other'}), videoFixture({version: '2.0'}),
    videoFixture({title: ''}), videoFixture({title: 'a'.repeat(501)}), videoFixture({author_name: null}),
    videoFixture({thumbnail_url: 'https://evil.test/x.jpg'}), videoFixture({thumbnail_url: `https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg`}),
    videoFixture({thumbnail_url: `https://i.ytimg.com/vi/${ID}/hqdefault.jpg?token=upstream-secret`})]) {
    await rejectsWith(() => resolveVideo(VIDEO, {fetcher: async () => Response.json(data), cache: null}), 503);
  }
});

test('YouTube does not follow redirects and sanitizes missing, rate-limit, and network errors', async () => {
  for (const status of [301, 302, 401, 403, 404, 429, 500]) {
    let requests = 0;
    await rejectsWith(() => resolveVideo(VIDEO, {cache: null, fetcher: async () => {
      requests++; return new Response('upstream-secret', {status, headers: {location: 'https://evil.test'}});
    }}), [401, 403, 404].includes(status) ? 404 : 503);
    assert.equal(requests, 1);
  }
  await rejectsWith(() => resolveVideo(VIDEO, {fetcher: async () => { throw new Error('upstream-secret'); }, cache: null}), 503);
  await rejectsWith(() => resolveVideo(VIDEO, {fetcher: async () => new Response('upstream-secret'), cache: null}), 503);
});

test('YouTube bounds declared and streamed bodies', async () => {
  for (const headers of [{}, {'content-length': '65537'}]) {
    await rejectsWith(() => resolveVideo(VIDEO, {fetcher: async () => new Response('x'.repeat(65537), {headers}), cache: null}), 503);
  }
});

test('YouTube times out a stalled response and aborts its request', async context => {
  context.mock.timers.enable({apis: ['setTimeout']});
  let signal;
  const pending = resolveVideo(VIDEO, {cache: null, fetcher: async (_, options) => {
    signal = options.signal; return new Promise(() => {});
  }});
  // Cache and resolution deliberately cross asynchronous boundaries before fetch.
  while (!signal) await Promise.resolve();
  const rejected = rejectsWith(() => pending, 503);
  context.mock.timers.tick(10_000);
  await rejected;
  assert.equal(signal.aborted, true);
});

test('Repository metadata preserves public validation and canonical repository identity', async () => {
  const result = await resolveRepository('https://github.com/builders/old.git', {now: NOW, cache: null, fetcher: async url => {
    assert.equal(url, 'https://api.github.com/repos/builders/old');
    return Response.json(repoFixture({archived: true}));
  }});
  assert.equal(result.id, 'github:42');
  assert.equal(result.repositoryId, 42);
  assert.equal(result.kind, 'github');
  assert.equal(result.url, REPO);
  assert.equal(result.title, 'builders/code');
  assert.equal(result.archived, true);
  assert.equal(result.verifiedAt, new Date(NOW).toISOString());
  await rejectsWith(() => resolveRepository(REPO, {cache: null, fetcher: async () => Response.json(repoFixture({private: true}))}), 404);
});

test('Recommendation verification rejects bad provenance before requests and never trusts agent metadata', async () => {
  let requests = 0;
  const result = await validateRecommendations([
    suggestion({sourceWidgetIds: ['secret-widget']}), suggestion({sourceWidgetIds: []}), suggestion({reason: ''}),
    suggestion({kind: 'web'}), suggestion({widgetId: 'wrong-target'}), suggestion({url: 'https://evil.test/page'}),
    suggestion({title: 'Invented title', thumbnail: 'https://evil.test/image.jpg', html: '<script>bad()</script>', sourceWidgetIds: ['notes-1', 'notes-1'], widgetId: 'recommend-1'}),
  ], {sourceWidgetIds: ['notes-1'], recommendationWidgetIds: ['recommend-1'], now: NOW, fetcher: async () => {
    requests++; return Response.json(videoFixture());
  }});
  assert.equal(requests, 1);
  assert.equal(result.errors.length, 6);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].title, 'Build a useful project');
  assert.equal(result.items[0].html, undefined);
  assert.deepEqual(result.items[0].sourceWidgetIds, ['notes-1']);
  assert.equal(result.items[0].widgetId, 'recommend-1');
});

test('Codex structured recommendations can use a null destination for all matching widgets', async () => {
  const result = await validateRecommendations([suggestion({widgetId: null})], {sourceWidgetIds: ['notes-1'],
    recommendationWidgetIds: ['recommend-1', 'recommend-2'], fetcher: async () => Response.json(videoFixture())});
  assert.deepEqual(result.errors, []);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].widgetId, undefined);
});

test('Recommendations deduplicate aliases and saved/dismissed URLs, including GitHub renames', async () => {
  let requests = 0;
  const result = await validateRecommendations([
    suggestion({kind: 'video', url: `https://youtu.be/${ID}?si=tracking`}), suggestion(),
    suggestion({url: 'https://www.youtube.com/watch?v=abcdefghijk'}),
    suggestion({kind: 'repository', url: REPO}), suggestion({kind: 'github', url: 'https://github.com/builders/old'}),
  ], {sourceWidgetIds: ['notes-1'], savedUrls: [`https://youtu.be/${ID}`], dismissedUrls: ['https://github.com/BUILDERS/code.git'],
    fetcher: async url => { requests++; return url.includes('api.github.com') ? Response.json(repoFixture()) : Response.json(videoFixture({thumbnail_url: undefined})); }});
  assert.equal(requests, 2);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].videoId, 'abcdefghijk');
  assert.deepEqual(result.errors, []);
});

test('Recommendations return verified partial results and sanitized failure diagnostics', async () => {
  const result = await validateRecommendations([suggestion(), suggestion({kind: 'github', url: REPO})], {
    sourceWidgetIds: ['notes-1'], fetcher: async url => url.includes('api.github.com')
      ? new Response('upstream-secret', {status: 404}) : Response.json(videoFixture()),
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.errors[0].code, 'not_found');
  assert.ok(!JSON.stringify(result).includes('upstream-secret'));
  await rejectsWith(() => validateRecommendations({recommendations: []}), 400);
  await rejectsWith(() => validateRecommendations(Array.from({length: 31}, () => suggestion())), 400);
});

test('A metadata cache stores only public metadata and rechecks after expiration', async () => {
  const cache = new Map();
  let requests = 0;
  const fetcher = async () => { requests++; return Response.json(videoFixture()); };
  const first = await validateRecommendations([suggestion({reason: 'private-reason', sourceWidgetIds: ['private-widget']})], {
    sourceWidgetIds: ['private-widget'], now: NOW, cache, fetcher,
  });
  first.items[0].title = 'changed-by-caller';
  const second = await resolveVideo(`https://youtu.be/${ID}`, {now: NOW + 10_000, cache, fetcher});
  assert.equal(requests, 1);
  assert.equal(second.title, 'Build a useful project');
  assert.ok(!JSON.stringify([...cache]).includes('private-'));
  await resolveVideo(VIDEO, {now: NOW + 15 * 60_000, cache, fetcher});
  assert.equal(requests, 2);
});

test('Cache API responses contain only bounded public metadata and respect stored expiration', async () => {
  const entries = new Map();
  const cache = {
    async match(request) { return entries.get(request.url)?.clone(); },
    async put(request, response) {
      assert.ok(request.url.startsWith('https://load-and-run.invalid/__public-metadata/v1/'));
      assert.equal(response.headers.get('cache-control'), 'public, max-age=900');
      entries.set(request.url, response);
    },
  };
  let requests = 0;
  const fetcher = async () => { requests++; return Response.json(videoFixture()); };
  await validateRecommendations([suggestion({reason: 'private-reason'})], {sourceWidgetIds: ['notes-1'], now: NOW, cache, fetcher});
  await resolveVideo(VIDEO, {now: NOW + 5000, cache, fetcher});
  assert.equal(requests, 1);
  const cachedBody = await [...entries.values()][0].clone().text();
  assert.ok(!cachedBody.includes('private-reason'));
  assert.ok(!cachedBody.includes('notes-1'));
  await resolveVideo(VIDEO, {now: NOW + 900000, cache, fetcher});
  assert.equal(requests, 2);
});

test('Provider cooldown honors Retry-After without retrying every candidate', async () => {
  const cache = new Map();
  let requests = 0;
  const fetcher = async () => { requests++; return new Response('upstream-secret', {status: 429, headers: {'retry-after': '120'}}); };
  const result = await validateRecommendations([suggestion(), suggestion({url: 'https://youtu.be/abcdefghijk'})], {
    sourceWidgetIds: ['notes-1'], now: NOW, fetcher, cache,
  });
  assert.equal(result.items.length, 0);
  assert.equal(requests, 1);
  assert.deepEqual(result.errors.map(error => error.code), ['rate_limited', 'rate_limited']);
  assert.equal(result.errors[0].retryAfter, 120);
  await assert.rejects(() => resolveVideo(VIDEO, {now: NOW + 60_000, fetcher, cache}), error => error.retryAfter === 60);
  assert.equal(requests, 1);
  await rejectsWith(() => resolveVideo(VIDEO, {now: NOW + 120_000, fetcher, cache}), 503);
  assert.equal(requests, 2);
});

test('GitHub cooldown propagates upstream limits and shares the canonical public cache', async () => {
  const cache = new Map();
  let requests = 0;
  const limited = async () => { requests++; return new Response('upstream-secret', {status: 403, headers: {'x-ratelimit-remaining': '0', 'retry-after': '180'}}); };
  await assert.rejects(() => resolveRepository(REPO, {now: NOW, cache, fetcher: limited}), error => error.retryAfter === 180);
  await assert.rejects(() => resolveRepository('https://github.com/builders/other', {now: NOW + 60_000, cache, fetcher: limited}), error => error.retryAfter === 120);
  assert.equal(requests, 1);
  const fetcher = async () => { requests++; return Response.json(repoFixture()); };
  await resolveRepository('https://github.com/builders/old', {now: NOW + 180_000, cache, fetcher});
  await resolveRepository('https://github.com/BUILDERS/code.git', {now: NOW + 180_001, cache, fetcher});
  assert.equal(requests, 2);
});

test('Recommendation runs cap results per provider and total work', async () => {
  let requests = 0;
  const candidates = Array.from({length: 10}, (_, i) => suggestion({url: `https://youtu.be/abcdefghij${i}`}));
  const result = await validateRecommendations(candidates, {sourceWidgetIds: ['notes-1'], maxPerKind: 2, limit: 4,
    fetcher: async () => { requests++; return Response.json(videoFixture({thumbnail_url: undefined})); }});
  assert.equal(result.items.length, 2);
  assert.equal(requests, 2);
});
