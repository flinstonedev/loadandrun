import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchGitHubRepository} from '../server/github.mjs';

const fixture = (overrides = {}) => ({id: 123, html_url: 'https://github.com/builders/new-name', full_name: 'builders/new-name',
  private: false, visibility: 'public', description: 'A shared prototype.', language: 'JavaScript', archived: false,
  license: {name: 'MIT License', spdx_id: 'MIT', url: 'https://api.github.com/licenses/mit'}, ...overrides});
const rejectsWith = (action, status) => assert.rejects(action, error => error.status === status && !error.message.includes('remote-secret'));

test('GitHub URL validation rejects SSRF, parser normalization, and extra URL components without a request', async () => {
  let requests = 0;
  const fetcher = () => {requests++; throw new Error('must not request');};
  for (const url of [
    null, '', 'http://github.com/owner/repo', 'https://localhost/owner/repo', 'https://127.0.0.1/owner/repo',
    'https://github.com.evil.test/owner/repo', 'https://github.com@evil.test/owner/repo', 'https://person:secret@github.com/owner/repo',
    'https://github.com:443/owner/repo', 'https://github.com:8443/owner/repo', 'https://github.com/owner/repo?token=secret',
    'https://github.com/owner/repo#readme', 'https://github.com/owner/repo/tree/main', 'https://github.com/owner/repo/issues',
    'https://github.com/owner/repo%2Fissues', 'https://github.com/owner%2frepo/name', 'https://github.com/owner/../repo',
    'https://github.com/owner/.', 'https://github.com/owner/..', 'https://github.com/owner/.git',
    'https://github.com/owner\\repo', ' https://github.com/owner/repo', 'https://github.com/owner/repo\n',
    'https://github.com//owner/repo', 'https://github.com/-owner/repo',
  ]) await rejectsWith(() => fetchGitHubRepository(url, fetcher), 400);
  assert.equal(requests, 0);
});

test('GitHub metadata follows canonical renames, normalizes git URLs, and preserves archived/license information', async () => {
  const result = await fetchGitHubRepository('https://github.com/builders/old-name.git/', async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/builders/old-name');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Accept, 'application/vnd.github+json');
    assert.equal(options.headers['User-Agent'], 'load-and-run');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers.Authorization, undefined);
    return Response.json(fixture({archived: true}));
  });
  assert.deepEqual({...result, fetchedAt: undefined}, {id: 123, url: 'https://github.com/builders/new-name', fullName: 'builders/new-name',
    description: 'A shared prototype.', language: 'JavaScript', archived: true,
    license: {name: 'MIT License', spdxId: 'MIT', url: 'https://github.com/builders/new-name#license'}, fetchedAt: undefined});
  assert.ok(Number.isFinite(Date.parse(result.fetchedAt)));
  assert.equal(result.approved, undefined);
});

test('GitHub accepts a bounded redirect to its repository API and rejects offsite or unrelated redirects', async () => {
  const requests = [];
  const result = await fetchGitHubRepository('https://github.com/builders/old-name', async url => {
    requests.push(url);
    return requests.length === 1 ? new Response(null, {status: 301, headers: {location: 'https://api.github.com/repositories/123'}}) : Response.json(fixture());
  });
  assert.equal(result.id, 123);
  assert.deepEqual(requests, ['https://api.github.com/repos/builders/old-name', 'https://api.github.com/repositories/123']);
  for (const location of ['http://api.github.com/repositories/123', 'https://evil.test/repos/owner/repo', 'https://api.github.com.evil.test/repositories/123',
    'https://token@api.github.com/repositories/123', 'https://api.github.com:443/repositories/123', 'https://api.github.com/user',
    'https://api.github.com/repos/owner/repo/issues', 'https://api.github.com/repos/owner/repo?token=remote-secret',
    'https://api.github.com/repos/owner%2frepo', 'https://api.github.com/other/../repositories/123']) {
    let count = 0;
    await rejectsWith(() => fetchGitHubRepository('https://github.com/builders/repo', async () => {
      count++; return new Response(null, {status: 302, headers: {location}});
    }), 503);
    assert.equal(count, 1);
  }
  let count = 0;
  await rejectsWith(() => fetchGitHubRepository('https://github.com/builders/repo', async () => {
    count++; return new Response(null, {status: 301, headers: {location: '/repositories/123'}});
  }), 503);
  assert.equal(count, 3);
});

test('GitHub rejects private repositories and invalid canonical response URLs', async () => {
  for (const overrides of [{private: true}, {visibility: 'private'}, {visibility: 'internal'}]) {
    await rejectsWith(() => fetchGitHubRepository('https://github.com/builders/repo', async () => Response.json(fixture(overrides))), 404);
  }
  for (const overrides of [{html_url: 'https://evil.test/builders/repo'}, {html_url: 'https://github.com/builders/repo/issues'},
    {html_url: 'https://github.com/builders/repo?token=remote-secret'}, {full_name: 'unrelated/repo'}, {private: undefined}, {id: '123'}]) {
    await rejectsWith(() => fetchGitHubRepository('https://github.com/builders/repo', async () => Response.json(fixture(overrides))), 503);
  }
});

test('GitHub maps missing repositories, rate limits, and network errors without exposing upstream bodies', async () => {
  for (const status of [404, 403, 429, 500, 502]) {
    await rejectsWith(() => fetchGitHubRepository('https://github.com/builders/repo', async () => new Response('remote-secret', {status})), status === 404 ? 404 : 503);
  }
  await rejectsWith(() => fetchGitHubRepository('https://github.com/builders/repo', async () => {throw new Error('remote-secret');}), 503);
  await rejectsWith(() => fetchGitHubRepository('https://github.com/builders/repo', async () => new Response('remote-secret')), 503);
});

test('GitHub bounds response bodies and leaves absent or unidentified licenses unapproved', async () => {
  for (const headers of [{}, {'content-length': '300000'}]) {
    await rejectsWith(() => fetchGitHubRepository('https://github.com/builders/repo', async () => new Response('x'.repeat(300000), {headers})), 503);
  }
  const absent = await fetchGitHubRepository('https://github.com/builders/repo', async () => Response.json(fixture({license: null, description: null, language: null})));
  assert.equal(absent.license, null);
  assert.equal(absent.description, '');
  assert.equal(absent.language, '');
  const unidentified = await fetchGitHubRepository('https://github.com/builders/repo', async () => Response.json(fixture({license: {name: 'Other', spdx_id: 'NOASSERTION'}})));
  assert.equal(unidentified.license.spdxId, 'NOASSERTION');
  assert.equal(unidentified.license.approved, undefined);
});

test('GitHub times out and aborts a stalled fetch', async context => {
  context.mock.timers.enable({apis: ['setTimeout']});
  let signal;
  const pending = fetchGitHubRepository('https://github.com/builders/repo', async (_, options) => {
    signal = options.signal;
    return new Promise(() => {});
  });
  const rejected = rejectsWith(() => pending, 503);
  context.mock.timers.tick(10_000);
  await rejected;
  assert.equal(signal.aborted, true);
});
