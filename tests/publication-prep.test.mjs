import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, access} from 'node:fs/promises';
import {request} from 'node:http';
import {resolve} from 'node:path';
import {createDemoServer} from '../scripts/demo.mjs';

test('code-only configuration has no deployment commands, account or remote AI binding', async () => {
  const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
  assert.equal(config.account_id, undefined);
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.equal(config.assets.run_worker_first, true);
  assert.equal(config.vars.ENVIRONMENT, 'production');
  assert.equal(config.vars.WORKSPACE_ID, 'load-and-run');
  assert.equal(config.env.local.vars.WORKSPACE_ID, 'local');
  for (const vars of [config.vars, config.env.local.vars]) {
    for (const name of ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'WORKOS_CLIENT_ID', 'WORKOS_ISSUER']) assert.equal(vars[name], '');
    assert.equal(vars.SPACES_AI_ENABLED, 'false');
  }
  assert.equal(config.env.local.ai, undefined);
  assert.equal(config.ai, undefined);
  assert.deepEqual(config.durable_objects.bindings.map(item => [item.name, item.class_name]), [
    ['WORKSPACES', 'Workspace'], ['SPACES', 'Space'], ['WIDGETS', 'Widget'], ['SPACE_DIRECTORIES', 'SpaceDirectory'],
  ]);
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(manifest.scripts.deploy, undefined);
  assert.equal(manifest.scripts['check:auth'], undefined);
  assert.match(manifest.scripts['dev:worker'], /--local .*--ip 127\.0\.0\.1/);
  assert.doesNotMatch(Object.values(manifest.scripts).join('\n'), /wrangler (?:deploy|publish)|vercel --prod|fly deploy/);
  for (const path of ['scripts/deploy-private.mjs', 'scripts/private-config.mjs', 'scripts/check-authkit.mjs', 'scripts/setup-access.mjs']) {
    await assert.rejects(access(path), {code: 'ENOENT'});
  }
});

test('offline demo serves synthetic editable community while rejecting network lookups and cross-site/private-file access', async t => {
  const server = await createDemoServer({assets: resolve('src')});
  await new Promise((done, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', done);});
  t.after(() => new Promise(done => {server.closeAllConnections(); server.close(done);}));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const fetchJSON = async (path, options) => {const response = await fetch(origin + path, options); return {status: response.status, body: await response.json()};};
  const session = await fetchJSON('/api/session');
  assert.equal(session.body.demo, true);
  assert.equal(session.body.user.name, 'Demo Builder');
  assert.equal(session.body.authProvider, 'demo');
  assert.equal(session.body.features.spaces, false);
  const headers = {'Content-Type': 'application/json', Origin: origin, 'X-CSRF-Token': session.body.csrf};
  const post = (path, body, extra = {}) => fetchJSON(path, {method: 'POST', headers: {...headers, ...extra}, body: JSON.stringify(body)});
  const before = await fetchJSON('/api/community');
  assert.equal(before.body.groups.length, 1);
  assert.equal(before.body.projects.length, 1);
  assert.equal(before.body.posts.length, 1);
  assert.equal((await post('/api/community/groups', {name: 'Example builders', description: 'Synthetic group'})).status, 201);
  assert.equal((await fetchJSON('/api/community')).body.groups.length, 2);
  assert.equal((await post('/api/community/posts', {content: 'Denied'}, {Origin: 'https://evil.example'})).status, 403);
  assert.equal((await post('/api/community/posts', {content: 'Denied'}, {'X-CSRF-Token': 'wrong'})).status, 403);
  const project = before.body.projects[0];
  const lookup = await post(`/api/community/projects/${project.id}/repository`, {url: 'https://github.com/example/project'});
  assert.equal(lookup.status, 503);
  assert.match(lookup.body.error, /disabled in the offline demo/);
  for (const path of ['/wrangler.private.jsonc', '/.private/README.md', '/.git/config', '/api/spaces', '/auth/login']) assert.equal((await fetchJSON(path)).status, 404);
  const page = await fetch(origin + '/');
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
  const html = await page.text();
  assert.match(html, /Offline community demo/);
  assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic/);
  const hostStatus = await new Promise((done, reject) => {
    const req = request(origin + '/api/session', {headers: {Host: 'attacker.example'}}, response => {response.resume(); response.on('end', () => done(response.statusCode));});
    req.on('error', reject); req.end();
  });
  assert.equal(hostStatus, 403);
  assert.equal((await fetchJSON('/api/session', {headers: {'Sec-Fetch-Site': 'cross-site'}})).status, 403);
});
