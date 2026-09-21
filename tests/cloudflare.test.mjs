import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';
import {generateKeyPair, exportJWK, SignJWT} from 'jose';
import {workosFixture, applyCookies} from './helpers/workos.mjs';

let mf, options, folder, privateKey, alice, bob, workos;
const issuer = 'https://test-team.cloudflareaccess.com';
const audience = 'test-audience';
const catalog = JSON.parse(await readFile(new URL('../src/data.json', import.meta.url)));
const ideaAddress = catalog.blueprints[0].addr;
async function token(subject, overrides = {}) {
  return new SignJWT({email: subject + '@example.com', ...overrides.claims})
    .setProtectedHeader({alg: 'RS256', kid: 'test-key'}).setSubject(subject)
    .setIssuer(overrides.issuer || issuer).setAudience(overrides.audience || audience)
    .setIssuedAt().setExpirationTime(overrides.expiration || '1h').sign(privateKey);
}
async function call(auth, path, body, headers = {}) {
  const response = await mf.dispatchFetch('https://app.example/' + path, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'manual', headers: {
      ...(auth ? {'Cf-Access-Jwt-Assertion': auth.token, 'X-CSRF-Token': auth.csrf || '', Cookie: auth.cookie || ''} : {}),
      ...(body === undefined ? {} : {'Content-Type': 'application/json', Origin: 'https://app.example'}), ...headers,
    }, ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  });
  const cookie = applyCookies(auth, response).join(', ');
  const text = await response.text();
  let data;
  try {data = JSON.parse(text);} catch {data = text;}
  if (auth && data.csrf) auth.csrf = data.csrf;
  return {status: response.status, data, cookie, location: response.headers.get('location')};
}
before(async () => {
  folder = await mkdtemp(join(tmpdir(), 'load-and-run-cloudflare-'));
  workos = await workosFixture();
  const pair = await generateKeyPair('RS256', {extractable: true});
  privateKey = pair.privateKey;
  const jwk = {...await exportJWK(pair.publicKey), kid: 'test-key', alg: 'RS256', use: 'sig'};
  const result = await build({entryPoints: ['worker/index.ts'], bundle: true, write: false,
    format: 'esm', platform: 'browser', external: ['node:*', 'cloudflare:*']});
  options = {
    modules: true, script: result.outputFiles[0].text, compatibilityDate: '2026-09-04',
    compatibilityFlags: ['nodejs_compat'], durableObjects: {WORKSPACES: {className: 'Workspace', useSQLite: true}},
    resourcePersistencePath: folder,
    bindings: {ENVIRONMENT: 'production', ACCESS_TEAM_DOMAIN: 'test-team.cloudflareaccess.com', ACCESS_AUD: audience, WORKSPACE_ID: 'test', ...workos.bindings},
    serviceBindings: {ASSETS: () => Response.json({asset: true})},
    outboundService: async request => {
      const authResponse = await workos.outbound(request);
      if (authResponse) return authResponse;
      assert.equal(request.url, issuer + '/cdn-cgi/access/certs');
      return Response.json({keys: [jwk]});
    },
  };
  mf = new Miniflare(convertV4MiniflareOptions(options));
  alice = {token: await token('alice')}; bob = {token: await token('bob')};
});
after(async () => {await mf?.dispose(); if (folder) await rm(folder, {recursive: true, force: true});});

test('Access protects assets and APIs and rejects forged, expired, and wrong-audience tokens', async () => {
  for (const path of ['', 'workspace', 'app.js', 'data.json', 'api/session']) {
    assert.equal((await call(null, path)).status, 401);
    assert.equal((await call({token: 'forged'}, path)).status, 401);
  }
  for (const overrides of [{audience: 'other-app'}, {issuer: 'https://other.cloudflareaccess.com'}, {expiration: '1 second ago'}]) {
    assert.equal((await call({token: await token('alice', overrides)}, 'api/session')).status, 401);
  }
  assert.deepEqual((await call(alice, '')).data, {asset: true});
  assert.equal((await call(null, 'api/session', undefined, {'Cf-Access-Authenticated-User-Email': 'alice@example.com'})).status, 401);
});

test('builder accounts and sessions survive Durable Object restarts', async () => {
  assert.equal((await call(alice, 'api/session')).data.user, null);
  assert.equal((await call(bob, 'api/session')).data.user, null);
  assert.equal((await call(alice, 'api/community/groups', {name: 'No account', description: 'Cannot create'})).status, 401);
  assert.equal((await call(alice, 'api/register', {name: 'Alice', password: 'short'})).status, 410);
  const registered = await workos.signIn(call, alice, 'Alice');
  assert.match(registered.cookie, /; Secure/);
  assert.match(registered.cookie, /; HttpOnly/);
  assert.match(registered.cookie, /; SameSite=Lax/);
  await workos.signIn(call, bob, 'Bob');
  assert.equal((await call({token: alice.token}, 'api/register', {name: ' alice ', password: 'different-password'})).status, 410);
  const session = await call(alice, 'api/session');
  assert.equal(session.status, 200);
  assert.equal(session.data.authProvider, 'workos');
  assert.equal(session.data.user.name, 'Alice');
  assert.ok(!session.data.user.id.startsWith('access:'));
  assert.deepEqual(Object.keys(session.data.user).sort(), ['id', 'name']);
  await mf.dispose(); mf = new Miniflare(convertV4MiniflareOptions(options));
  assert.deepEqual((await call(alice, 'api/session')).data.user, session.data.user);
  assert.equal((await call(bob, 'api/session')).data.user.name, 'Bob');
});

test('app sessions are independent from Access claims and app logout only revokes the app session', async () => {
  const session = (await call(alice, 'api/session')).data;
  const differentGate = {...alice, token: bob.token};
  assert.deepEqual((await call(differentGate, 'api/session')).data.user, session.user);
  const sameGateOtherAccount = {...bob, token: alice.token};
  assert.equal((await call(sameGateOtherAccount, 'api/session')).data.user.name, 'Bob');
  assert.equal((await call({token: alice.token}, 'api/session')).data.user, null);
  assert.equal((await call({token: await token('no-email', {claims: {email: null}})}, 'api/session')).data.user, null);
  assert.equal((await call({token: alice.token}, 'api/login', {name: 'Alice', password: 'wrong-password'})).status, 410);
  assert.equal((await call({token: alice.token}, 'api/login', {name: 'Unknown', password: 'test-password-one'})).status, 410);
  const group = {name: 'Prototype builders', description: 'Build a prototype together.'};
  assert.equal((await call(alice, 'api/community/groups', group, {Origin: 'https://evil.example'})).status, 403);
  assert.equal((await call(alice, 'api/community/groups', group, {'X-CSRF-Token': ''})).status, 401);
  assert.equal((await call(alice, 'api/community/posts', {content: 'x'.repeat(2_000_001)})).status, 413);
  const oldSession = {...alice};
  const logout = await call(alice, 'api/logout', {});
  assert.equal(new URL(logout.data.logoutUrl).hostname, 'api.workos.com');
  assert.match(logout.cookie, /Max-Age=0/);
  assert.equal((await call(oldSession, 'api/session')).data.user, null);
  assert.equal((await call(alice, '')).status, 200);
  await workos.signIn(call, alice, 'Alice');
  assert.deepEqual((await call(alice, 'api/session')).data.user, session.user);
});

test('removed Workspace pages, assets, and APIs return 404 without an archive', async () => {
  for (const path of ['workspace', 'workspace/', 'workspace/old-document', 'workspace?document=old-document', 'workspace.js', 'workspace.css', 'app.js']) {
    assert.equal((await call(alice, path)).status, 404, path);
  }
  for (const path of ['documents', 'documents/old-document', 'documents/old-document/history',
    'documents/old-document/export', 'documents/old-document/presence', 'documents/old-document/blocks',
    'documents/old-document/title', 'documents/old-document/access', 'documents/old-document/restore',
    'documents/old-document/publish', 'journal', 'journal/old-record', 'import', 'export', 'mail',
    'lines', 'lines/old-line', 'members']) {
    assert.equal((await call(alice, 'api/' + path)).status, 404, 'GET ' + path);
    assert.equal((await call(alice, 'api/' + path, {})).status, 404, 'POST ' + path);
    assert.equal((await call({token: alice.token}, 'api/' + path)).status, 404, 'Visitor GET ' + path);
    assert.equal((await call({token: alice.token}, 'api/' + path, {})).status, 404, 'Visitor POST ' + path);
  }
});

test('community HTTP permissions and member-only counts survive SQLite Durable Object restarts', async () => {
  assert.equal((await call(alice, 'api/session')).data.user.name, 'Alice');
  assert.equal((await call(bob, 'api/session')).data.user.name, 'Bob');
  const visitor = {token: alice.token};
  assert.equal((await call(visitor, 'api/session')).data.user, null);
  assert.equal((await call(visitor, 'api/community/groups', {name: 'No account', description: 'Cannot create'})).status, 401);
  const createdGroup = await call(alice, 'api/community/groups', {
    name: 'Hypertext builders', description: 'Build a shared notebook prototype.', topic: 'Hypertext',
  });
  assert.equal(createdGroup.status, 201, JSON.stringify(createdGroup.data));
  const groupId = createdGroup.data.id;
  const createdProject = await call(alice, 'api/community/projects', {
    title: 'Shared notebook', goal: 'Make each note independently addressable.', ideaAddress, groupId,
  });
  assert.equal(createdProject.status, 201, JSON.stringify(createdProject.data));
  const projectId = createdProject.data.id;
  const privatePost = await call(alice, 'api/community/posts', {
    content: 'Members-only implementation discussion', projectId, visibility: 'members',
  });
  assert.equal(privatePost.status, 201, JSON.stringify(privatePost.data));
  const privatePostId = privatePost.data.id;
  await call(alice, `api/community/posts/${privatePostId}/comments`, {content: 'Members-only follow-up'});
  for (const outsider of [visitor, bob]) {
    const overview = await call(outsider, 'api/community');
    assert.equal(overview.status, 200, JSON.stringify(overview.data));
    assert.equal(overview.data.groups.find(group => group.id === groupId).postCount, 0);
    assert.equal(overview.data.projects.find(project => project.id === projectId).postCount, 0);
    assert.ok(!JSON.stringify(overview.data).includes('Members-only'));
    const group = (await call(outsider, `api/community/groups/${groupId}`)).data;
    assert.equal(group.group.postCount, 0);
    assert.equal(group.posts.length, 0);
    assert.equal((await call(outsider, `api/community/posts/${privatePostId}`)).status, 404);
  }
  assert.equal((await call(bob, `api/community/posts/${privatePostId}/comments`, {content: 'Not a member'})).status, 404);
  assert.equal((await call(bob, `api/community/projects/${projectId}/join`, {})).status, 403);
  const publicPost = await call(alice, 'api/community/posts', {
    content: 'The notebook project is looking for builders.', groupId, visibility: 'public', kind: 'help',
  });
  assert.equal(publicPost.status, 201, JSON.stringify(publicPost.data));
  const publicOverview = (await call(visitor, 'api/community')).data;
  assert.deepEqual(publicOverview.posts.map(post => post.id), [publicPost.data.id]);
  assert.equal(publicOverview.groups.find(group => group.id === groupId).postCount, 1);
  assert.equal((await call(visitor, `api/community/posts/${publicPost.data.id}`)).data.post.content, publicPost.data.content);
  assert.equal((await call(bob, `api/community/groups/${groupId}/join`, {})).status, 200);
  assert.equal((await call(bob, `api/community/posts/${privatePostId}`)).status, 404);
  assert.equal((await call(bob, `api/community/projects/${projectId}/join`, {})).status, 200);
  const memberRead = (await call(bob, `api/community/posts/${privatePostId}`)).data;
  assert.equal(memberRead.comments[0].content, 'Members-only follow-up');
  assert.equal((await call(bob, `api/community/posts/${privatePostId}/comments`, {content: 'I can help with addressing.'})).status, 201);

  await mf.dispose(); mf = new Miniflare(convertV4MiniflareOptions(options));
  const reopened = (await call(bob, 'api/community')).data;
  assert.equal(reopened.groups.find(group => group.id === groupId).joined, true);
  assert.equal(reopened.projects.find(project => project.id === projectId).joined, true);
  assert.equal(reopened.projects.find(project => project.id === projectId).ideaAddress, ideaAddress);
  assert.equal(reopened.posts.find(post => post.id === privatePostId).commentCount, 2);
  assert.equal((await call(visitor, 'api/community')).data.posts.some(post => post.id === privatePostId), false);
});

test('deployment storage IDs keep builder accounts and community data separate', async () => {
  const original = (await call(alice, 'api/community')).data;
  assert.ok(original.groups.length);
  await mf.dispose();
  mf = new Miniflare(convertV4MiniflareOptions({...options, bindings: {...options.bindings, WORKSPACE_ID: 'another-community'}}));
  assert.equal((await call(alice, 'api/session')).data.user, null);
  assert.deepEqual((await call(alice, 'api/community')).data, {groups: [], projects: [], posts: []});
  await mf.dispose(); mf = new Miniflare(convertV4MiniflareOptions(options));
  assert.equal((await call(alice, 'api/session')).data.user.name, 'Alice');
  assert.deepEqual((await call(alice, 'api/community')).data, original);
});

test('WorkOS cannot bypass the deployment gate or restore legacy login through configuration', async () => {
  await mf.dispose();
  mf = new Miniflare(convertV4MiniflareOptions({...options, bindings: {...options.bindings, ACCESS_GATE_ENABLED: 'false'}}));
  assert.equal((await call(null, '')).status, 401);
  assert.equal((await call(null, 'api/session')).status, 401);
  assert.equal((await call({token: alice.token}, 'api/session')).data.authProvider, 'workos');
  assert.equal((await call({token: alice.token}, 'api/session')).data.user, null);
  assert.equal((await call(null, 'api/community/groups', {name: 'Anonymous', description: 'Denied'})).status, 401);
  assert.equal((await call({...alice, token: ''}, 'api/session')).status, 401);
  for (const endpoint of ['login', 'register']) assert.equal((await call({token: alice.token}, 'api/' + endpoint, {name:'Alice', password:'password12345'})).status, 410);
  await mf.dispose();
  mf = new Miniflare(convertV4MiniflareOptions({...options, bindings: {...options.bindings, AUTH_PROVIDER: 'builder'}}));
  assert.equal((await call(alice, 'api/session')).status, 503);
  assert.equal((await call(alice, 'api/login', {name:'Alice', password:'password12345'})).status, 410);
});

test('production fails closed without Access configuration, including on localhost', async () => {
  await mf.dispose();
  mf = new Miniflare(convertV4MiniflareOptions({...options, bindings: {...options.bindings, ACCESS_AUD: ''}}));
  assert.equal((await call(alice, '')).status, 503);
  const response = await mf.dispatchFetch('http://localhost/api/session');
  assert.equal(response.status, 503);
});
