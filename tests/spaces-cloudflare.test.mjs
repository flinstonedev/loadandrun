import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';
import WebSocket from 'ws';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';
import {generateKeyPair, exportJWK, SignJWT} from 'jose';
import {workosFixture, applyCookies} from './helpers/workos.mjs';

let mf, options, folder, alice, bob, eve, workos;
const providerRequests = [];
const modelRequests = [];
let holdModel = false;
const issuer = 'https://test-team.cloudflareaccess.com';
const audience = 'spaces-test-audience';

async function call(auth, path, body, headers = {}) {
  const response = await mf.dispatchFetch(`https://app.example/${path}`, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
    headers: {
      ...(auth ? {'Cf-Access-Jwt-Assertion': auth.token, 'X-CSRF-Token': auth.csrf || '', Cookie: auth.cookie || ''} : {}),
      ...(body === undefined ? {} : {'Content-Type': 'application/json', Origin: 'https://app.example'}),
      ...headers,
    },
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  });
  applyCookies(auth, response);
  const text = await response.text();
  let data;
  try {data = JSON.parse(text);} catch {data = text;}
  if (auth && data?.csrf) auth.csrf = data.csrf;
  return {status: response.status, data, location: response.headers.get('location')};
}

function expectStatus(response, status) {
  assert.equal(response.status, status, JSON.stringify(response.data));
  return response.data;
}

async function createSpace(auth, title) {
  return expectStatus(await call(auth, 'api/spaces', {title}), 201).space;
}

async function createWidget(auth, spaceId, type = 'notes', extra = {}) {
  return expectStatus(await call(auth, `api/spaces/${spaceId}/widgets`, {type, ...extra}), 201).widget;
}

async function restart(bindings = {}) {
  await mf.dispose();
  mf = new Miniflare(convertV4MiniflareOptions({...options, bindings: {...options.bindings, ...bindings}}));
  await mf.ready;
}

async function waitFor(getValue, description = 'hosted job') {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const value = await getValue();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${description}.`);
}

async function modelJob(id) {
  return waitFor(() => modelRequests.find(request => request.job.id === id), 'model invocation');
}

async function spaceState(id, replacement) {
  const response = await mf.dispatchFetch(`https://app.example/__test/space/${id}`, {
    method: 'POST', body: JSON.stringify(replacement || null),
  });
  assert.equal(response.status, 200);
  return response.json();
}

function releaseModels() {
  holdModel = false;
  for (const request of modelRequests) request.release({text: 'Cancelled test result', recommendations: []});
}

before(async () => {
  folder = await mkdtemp(join(tmpdir(), 'load-and-run-spaces-'));
  workos = await workosFixture();
  const pair = await generateKeyPair('RS256', {extractable: true});
  const jwk = {...await exportJWK(pair.publicKey), kid: 'spaces-test-key', alg: 'RS256', use: 'sig'};
  const result = await build({stdin: {resolveDir: process.cwd(), contents: `
    import app, {Space as ApplicationSpace} from './worker/index.ts';
    export {Workspace, Widget, SpaceDirectory} from './worker/index.ts';
    export class Space extends ApplicationSpace {
      async testState(replacement) {
        if (replacement) this.ctx.storage.sql.exec('UPDATE space_state SET value = ? WHERE key = ?', JSON.stringify(replacement), 'space');
        return JSON.parse(this.ctx.storage.sql.exec('SELECT value FROM space_state WHERE key = ?', 'space').one().value);
      }
    }
    export default {async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/__test/space/')) return Response.json(await env.SPACES.getByName(env.WORKSPACE_ID + ':' + url.pathname.split('/').pop()).testState(await request.json()));
      return app.fetch(request, env, ctx);
    }};
  `}, bundle: true, write: false,
    format: 'esm', platform: 'browser', external: ['node:*', 'cloudflare:*'],
    plugins: [{name: 'hosted-model-fixture', setup(builder) {
      builder.onResolve({filter: /^\.\/ai$/}, () => ({path: 'hosted-model', namespace: 'test'}));
      builder.onLoad({filter: /.*/, namespace: 'test'}, () => ({contents: `
        export function hostedModel(env) {return {id:env.SPACES_AI_MODEL || 'test-cloudflare-model', name:'Test Cloudflare model'};}
        export function hostedAIAvailable(env) {return env.SPACES_AI_ENABLED === 'true' && Boolean(env.AI);}
        export async function runHostedJob(env, job, onProgress, signal) {
          const response = await fetch('https://model.test/run', {method:'POST', body:JSON.stringify(job), signal});
          if (!response.ok) throw new Error('Cloudflare model request failed.');
          return response.json();
        }
      `}));
    }}]});
  options = {
    modules: true, script: result.outputFiles[0].text, compatibilityDate: '2026-09-04',
    compatibilityFlags: ['nodejs_compat'],
    durableObjects: {
      WORKSPACES: {className: 'Workspace', useSQLite: true},
      SPACES: {className: 'Space', useSQLite: true},
      WIDGETS: {className: 'Widget', useSQLite: true},
      SPACE_DIRECTORIES: {className: 'SpaceDirectory', useSQLite: true},
    },
    resourcePersistencePath: folder,
    bindings: {ENVIRONMENT: 'production', ACCESS_TEAM_DOMAIN: 'test-team.cloudflareaccess.com', ACCESS_AUD: audience, WORKSPACE_ID: 'spaces-test', SPACES_ENABLED: 'true', SPACES_AI_ENABLED: 'true', AI: 'test-binding', ...workos.bindings},
    serviceBindings: {ASSETS: () => Response.json({asset: true})},
    outboundService: async request => {
      const authResponse = await workos.outbound(request);
      if (authResponse) return authResponse;
      if (request.url === `${issuer}/cdn-cgi/access/certs`) return Response.json({keys: [jwk]});
      if (request.url === 'https://model.test/run') {
        const job = await request.json();
        let release;
        const response = new Promise(resolve => {release = value => resolve(Response.json(value));});
        modelRequests.push({job, release});
        if (!holdModel) release({text: `Cloudflare reply to ${job.message}`});
        return response;
      }
      providerRequests.push(request.url);
      if (request.url === 'https://api.github.com/repos/openai/codex') return Response.json({
        id: 12345, html_url: 'https://github.com/openai/codex', full_name: 'openai/codex',
        private: false, visibility: 'public', description: 'Verified coding agent repository.',
        language: 'Rust', archived: false, license: {name: 'Apache License 2.0', spdx_id: 'Apache-2.0'},
      });
      const url = new URL(request.url);
      if (url.origin === 'https://www.youtube.com' && url.pathname === '/oembed') {
        assert.equal(url.searchParams.get('url'), 'https://www.youtube.com/watch?v=LRtest01234');
        assert.equal(url.searchParams.get('format'), 'json');
        return Response.json({type: 'video', version: '1.0', provider_name: 'YouTube',
          title: 'Verified notebook architecture tutorial', author_name: 'Example Builders',
          thumbnail_url: 'https://i.ytimg.com/vi/LRtest01234/hqdefault.jpg',
          html: '<iframe src="https://evil.example/tracking"></iframe>',
        });
      }
      assert.fail(`Unexpected outbound provider request: ${request.url}`);
    },
  };
  mf = new Miniflare(convertV4MiniflareOptions(options));
  await mf.ready;
  const accessToken = await new SignJWT({email: 'gate@example.com'})
    .setProtectedHeader({alg: 'RS256', kid: 'spaces-test-key'}).setSubject('shared-access-gate')
    .setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime('1h').sign(pair.privateKey);
  alice = {token: accessToken}; bob = {token: accessToken}; eve = {token: accessToken};
  for (const [auth, name] of [[alice, 'SpaceAlice'], [bob, 'SpaceBob'], [eve, 'SpaceEve']]) {
    await workos.signIn(call, auth, name);
  }
}, {timeout: 20000});

after(async () => {
  releaseModels();
  await mf?.dispose();
  if (folder) await rm(folder, {recursive: true, force: true});
});

test('spaces use builder identities, require sessions and CSRF, and remain private by default', async () => {
  expectStatus(await call(null, 'api/spaces'), 401);
  expectStatus(await call({token: alice.token}, 'api/spaces'), 401);
  expectStatus(await call(alice, 'api/spaces', {title: 'Forbidden origin'}, {Origin: 'https://evil.example'}), 403);
  expectStatus(await call(alice, 'api/spaces', {title: 'Missing CSRF'}, {'X-CSRF-Token': ''}), 401);
  const space = await createSpace(alice, 'A private research space');
  assert.equal(space.ownerId, alice.user.id);
  assert.notEqual(alice.user.id, bob.user.id);
  const detail = expectStatus(await call(alice, `api/spaces/${space.id}`), 200);
  assert.equal(detail.space.role, 'owner');
  assert.equal(detail.space.settings.automaticRecommendations, false);
  assert.equal(detail.space.settings.aiConsent, false);
  assert.equal(detail.space.settings.aiProvider, 'cloudflare');
  expectStatus(await call(bob, `api/spaces/${space.id}`), 404);
  expectStatus(await call(bob, `api/spaces/${space.id}/widgets`, {type: 'notes'}), 404);
  const listed = expectStatus(await call(bob, 'api/spaces'), 200);
  assert.ok(!JSON.stringify(listed).includes(space.id));
});

test('all seven widget types persist independently and stale edits cannot overwrite newer content', async () => {
  const space = await createSpace(alice, 'Widget laboratory');
  const note = await createWidget(alice, space.id, 'notes', {content: {markdown: 'First durable note'}});
  const other = await createWidget(alice, space.id, 'notes', {content: {markdown: 'Separate durable note'}});
  for (const type of ['links', 'tasks', 'ideas', 'repositories', 'videos', 'recommendations']) {
    const widget = await createWidget(alice, space.id, type);
    assert.equal(widget.type, type);
  }
  const updated = expectStatus(await call(alice, `api/spaces/${space.id}/widgets/${note.id}`, {
    revision: note.revision, content: {markdown: 'Saved newer note'},
  }), 200).widget;
  assert.ok(updated.revision > note.revision);
  const conflict = expectStatus(await call(alice, `api/spaces/${space.id}/widgets/${note.id}`, {
    revision: note.revision, content: {markdown: 'Stale write must never win'},
  }), 409);
  assert.equal(conflict.widget.content.markdown, 'Saved newer note');
  await restart();
  const detail = expectStatus(await call(alice, `api/spaces/${space.id}`), 200);
  assert.equal(detail.widgets.length, 8);
  assert.equal(detail.widgets.find(widget => widget.id === note.id).content.markdown, 'Saved newer note');
  assert.equal(detail.widgets.find(widget => widget.id === other.id).content.markdown, 'Separate durable note');
  assert.equal(detail.space.ownerId, alice.user.id);
});

test('widget IDs are scoped to their space and failed mutations leave the original data intact', async () => {
  const first = await createSpace(alice, 'First boundary');
  const second = await createSpace(alice, 'Second boundary');
  const widget = await createWidget(alice, first.id, 'notes', {content: {markdown: 'Keep this content'}});
    expectStatus(await call(alice, `api/spaces/${second.id}/widgets/${widget.id}`, {revision: widget.revision, content: {markdown: 'Cross-space write'}}), 404);
  expectStatus(await call(alice, `api/spaces/${second.id}/widgets/${widget.id}/delete`, {revision: widget.revision}), 200);
  expectStatus(await call(eve, `api/spaces/${first.id}/widgets/${widget.id}`, {revision: widget.revision, content: {markdown: 'Outsider write'}}), 404);
  const original = expectStatus(await call(alice, `api/spaces/${first.id}`), 200).widgets.find(item => item.id === widget.id);
  assert.equal(original.content.markdown, 'Keep this content');
  assert.equal(original.revision, widget.revision);
});

test('invitations require acceptance and enforce viewer/editor/owner permissions and revocation', async () => {
  const space = await createSpace(alice, 'Shared collaboration');
  const created = expectStatus(await call(alice, `api/spaces/${space.id}/invitations`, {name: bob.user.name, role: 'viewer'}), 201);
  const invitation = created.invitation;
  assert.equal(invitation.toUserId, bob.user.id);
  expectStatus(await call(bob, `api/spaces/${space.id}`), 404);
  const pending = expectStatus(await call(bob, 'api/spaces'), 200).invitations;
  assert.ok(pending.some(item => item.id === invitation.id));
  expectStatus(await call(eve, `api/space-invitations/${invitation.id}/accept`, {spaceId: space.id}), 404);
  expectStatus(await call(bob, `api/space-invitations/${invitation.id}/accept`, {spaceId: space.id}), 200);
  const shared = expectStatus(await call(bob, `api/spaces/${space.id}`), 200);
  assert.equal(shared.space.role, 'viewer');
  assert.ok(!(shared.space.invitations || []).length);
  expectStatus(await call(bob, `api/spaces/${space.id}/widgets`, {type: 'notes'}), 403);
  expectStatus(await call(bob, `api/spaces/${space.id}/settings`, {automaticRecommendations: true, aiConsent: true}), 403);
  expectStatus(await call(bob, `api/spaces/${space.id}/delete`, {}), 403);
  expectStatus(await call(bob, `api/spaces/${space.id}/invitations`, {name: eve.user.name, role: 'viewer'}), 403);
  expectStatus(await call(alice, `api/spaces/${space.id}/members`, {userId: bob.user.id, role: 'editor'}), 200);
  const edit = await createWidget(bob, space.id, 'notes', {content: {markdown: 'Editor contribution'}});
  expectStatus(await call(bob, `api/spaces/${space.id}/settings`, {automaticRecommendations: true, aiConsent: true}), 403);
  expectStatus(await call(bob, `api/spaces/${space.id}/members`, {userId: eve.user.id, role: 'editor'}), 403);
  const ownerView = expectStatus(await call(alice, `api/spaces/${space.id}`), 200);
  assert.equal(ownerView.widgets.find(item => item.id === edit.id).content.markdown, 'Editor contribution');
  expectStatus(await call(alice, `api/spaces/${space.id}/members/${bob.user.id}/remove`, {}), 200);
  expectStatus(await call(bob, `api/spaces/${space.id}`), 404);
  expectStatus(await call(bob, `api/spaces/${space.id}/widgets/${edit.id}`, {revision: edit.revision, content: {markdown: 'Revoked edit'}}), 404);
  assert.ok(!expectStatus(await call(bob, 'api/spaces'), 200).spaces.some(item => item.id === space.id));
});

test('invitation decline, member leave, and space deletion clear access and directory entries', async () => {
  const space = await createSpace(alice, 'Lifecycle');
  const declined = expectStatus(await call(alice, `api/spaces/${space.id}/invitations`, {name: eve.user.name, role: 'viewer'}), 201).invitation;
  expectStatus(await call(eve, `api/space-invitations/${declined.id}/decline`, {spaceId: space.id}), 200);
  assert.ok(!expectStatus(await call(eve, 'api/spaces'), 200).invitations.some(item => item.id === declined.id));
  expectStatus(await call(eve, `api/space-invitations/${declined.id}/accept`, {spaceId: space.id}), 404);
  const accepted = expectStatus(await call(alice, `api/spaces/${space.id}/invitations`, {name: bob.user.name, role: 'editor'}), 201).invitation;
  expectStatus(await call(bob, `api/space-invitations/${accepted.id}/accept`, {spaceId: space.id}), 200);
  expectStatus(await call(alice, `api/spaces/${space.id}/leave`, {}), 400);
  expectStatus(await call(bob, `api/spaces/${space.id}/leave`, {}), 200);
  expectStatus(await call(bob, `api/spaces/${space.id}`), 404);
  const widget = await createWidget(alice, space.id, 'notes', {content: {markdown: 'Delete with its parent'}});
  expectStatus(await call(alice, `api/spaces/${space.id}/delete`, {}), 200);
  expectStatus(await call(alice, `api/spaces/${space.id}`), 404);
  expectStatus(await call(alice, `api/spaces/${space.id}/widgets/${widget.id}`, {revision: widget.revision, content: {markdown: 'Resurrection'}}), 404);
  assert.ok(!expectStatus(await call(alice, 'api/spaces'), 200).spaces.some(item => item.id === space.id));
  await restart();
  expectStatus(await call(alice, `api/spaces/${space.id}`), 404);
});

test('layout updates check revisions and reject incomplete or foreign widget sets', async () => {
  const space = await createSpace(alice, 'Layout validation');
  const first = await createWidget(alice, space.id);
  const second = await createWidget(alice, space.id);
  const detail = expectStatus(await call(alice, `api/spaces/${space.id}`), 200);
  expectStatus(await call(alice, `api/spaces/${space.id}/layout`, {revision: detail.space.revision, widgetIds: [second.id, first.id]}), 200);
  expectStatus(await call(alice, `api/spaces/${space.id}/layout`, {revision: detail.space.revision, widgetIds: [first.id, second.id]}), 409);
  const current = expectStatus(await call(alice, `api/spaces/${space.id}`), 200);
  assert.deepEqual(current.layout, [second.id, first.id]);
  for (const widgetIds of [[first.id], [first.id, first.id], [first.id, 'foreign-widget']]) {
    expectStatus(await call(alice, `api/spaces/${space.id}/layout`, {revision: current.space.revision, widgetIds}), 400);
  }
  assert.deepEqual(expectStatus(await call(alice, `api/spaces/${space.id}`), 200).layout, [second.id, first.id]);
});

test('feature flag closes spaces APIs while preserving existing sessions and community data', async () => {
  const space = await createSpace(alice, 'Feature gated');
  const group = expectStatus(await call(alice, 'api/community/groups', {name: 'Compatibility', description: 'Existing community remains available.'}), 201);
  await restart({SPACES_ENABLED: 'false'});
  const session = expectStatus(await call(alice, 'api/session'), 200);
  assert.equal(session.user.id, alice.user.id);
  assert.equal(session.features.spaces, false);
  for (const path of ['api/spaces', `api/spaces/${space.id}`, 'api/agent/status']) {
    expectStatus(await call(alice, path), 404);
  }
  for (const path of ['workspace', 'workspace.js', 'workspace.css', 'app.js']) {
    expectStatus(await call(alice, path), 404);
  }
  assert.equal(expectStatus(await call(alice, `api/community/groups/${group.id}`), 200).group.name, group.name);
  await restart();
  assert.equal(expectStatus(await call(alice, 'api/session'), 200).features.spaces, true);
  assert.equal(expectStatus(await call(alice, `api/spaces/${space.id}`), 200).space.title, 'Feature gated');
  await restart({WORKSPACE_ID: 'different-deployment'});
  expectStatus(await call(alice, `api/spaces/${space.id}`), 401);
  await restart();
  assert.equal(expectStatus(await call(alice, `api/spaces/${space.id}`), 200).space.ownerId, alice.user.id);
});

test('hosted AI needs no companion and retired pairing cannot create a connection', async () => {
  const status = expectStatus(await call(alice, 'api/agent/status'), 200);
  assert.equal(status.provider, 'cloudflare');
  assert.equal(status.available, true);
  assert.equal(status.model.id, 'test-cloudflare-model');
  assert.equal('device' in status, false);
  for (const path of ['pair/start', 'pair/poll', 'pair', 'disconnect']) {
    const retired = await call(alice, `api/agent/${path}`, {});
    assert.ok([404, 410].includes(retired.status), JSON.stringify(retired));
  }
  const retired = await mf.dispatchFetch('https://app.example/api/agent/connect', {
    headers: {'Cf-Access-Jwt-Assertion': alice.token, Cookie: alice.cookie, Upgrade: 'websocket', Origin: 'https://app.example'},
  });
  assert.ok([404, 410].includes(retired.status));
});

test('hosted private chat isolates members, uses the server model, and rejects outsiders', async () => {
  const space = await createSpace(alice, 'Private agent discussions');
  await createWidget(alice, space.id, 'notes', {content: {markdown: 'Design a collaborative notebook'}});
  const excluded = await createWidget(alice, space.id, 'notes', {includeInAI: false, content: {markdown: 'Private excluded material'}});
  const invitation = expectStatus(await call(alice, `api/spaces/${space.id}/invitations`, {name: bob.user.name, role: 'viewer'}), 201).invitation;
  expectStatus(await call(bob, `api/space-invitations/${invitation.id}/accept`, {spaceId: space.id}), 200);
  holdModel = true;
  try {
    const own = expectStatus(await call(alice, 'api/agent/chat', {spaceId: space.id, message: 'An owner-only question', model: 'expensive-client-override'}), 202);
    const theirs = expectStatus(await call(bob, 'api/agent/chat', {spaceId: space.id, message: 'A member-only question'}), 202);
    const ownerRun = await modelJob(own.jobId), memberRun = await modelJob(theirs.jobId);
    assert.equal(ownerRun.job.userId, alice.user.id);
    assert.equal(ownerRun.job.provider, 'cloudflare');
    assert.equal(ownerRun.job.model, 'test-cloudflare-model');
    assert.equal(memberRun.job.userId, bob.user.id);
    assert.ok(!JSON.stringify(ownerRun.job).includes(excluded.id));
    assert.ok(!JSON.stringify(ownerRun.job).includes('Private excluded material'));
    assert.ok(!JSON.stringify(memberRun.job).includes('owner-only'));
    expectStatus(await call(alice, 'api/agent/cancel', {jobId: theirs.jobId}), 404);
    ownerRun.release({text: 'Private owner reply'});
    memberRun.release({text: 'Private member reply'});
    const ownChat = await waitFor(async () => {
      const chat = expectStatus(await call(alice, `api/agent/chat?spaceId=${space.id}`), 200);
      return chat.messages.length === 2 && chat;
    });
    const memberChat = await waitFor(async () => {
      const chat = expectStatus(await call(bob, `api/agent/chat?spaceId=${space.id}`), 200);
      return chat.messages.length === 2 && chat;
    });
    assert.deepEqual(ownChat.messages.map(message => message.text), ['An owner-only question', 'Private owner reply']);
    assert.deepEqual(memberChat.messages.map(message => message.text), ['A member-only question', 'Private member reply']);
    assert.ok(!JSON.stringify(expectStatus(await call(bob, `api/spaces/${space.id}`), 200)).includes('Private owner reply'));
    expectStatus(await call(eve, `api/agent/chat?spaceId=${space.id}`), 404);
    expectStatus(await call(eve, 'api/agent/chat', {spaceId: space.id, message: 'Read a private space'}), 404);
    await restart();
    assert.deepEqual(expectStatus(await call(alice, `api/agent/chat?spaceId=${space.id}`), 200).messages, ownChat.messages);
  } finally {releaseModels();}
});

test('revoking access cancels hosted private chat and discards a late reply', async () => {
  const space = await createSpace(alice, 'Revoke in-flight private chat');
  await createWidget(alice, space.id, 'notes', {content: {markdown: 'Shared context'}});
  const invitation = expectStatus(await call(alice, `api/spaces/${space.id}/invitations`, {name: bob.user.name, role: 'viewer'}), 201).invitation;
  expectStatus(await call(bob, `api/space-invitations/${invitation.id}/accept`, {spaceId: space.id}), 200);
  holdModel = true;
  try {
    const requested = expectStatus(await call(bob, 'api/agent/chat', {spaceId: space.id, message: 'Pending private question'}), 202);
    const run = await modelJob(requested.jobId);
    expectStatus(await call(alice, `api/spaces/${space.id}/members/${bob.user.id}/remove`, {}), 200);
    run.release({text: 'Late revoked result must not be accepted'});
    await waitFor(async () => expectStatus(await call(bob, 'api/agent/status'), 200).jobs.find(job => job.id === requested.jobId)?.status === 'cancelled');
    expectStatus(await call(bob, `api/agent/chat?spaceId=${space.id}`), 404);
    assert.ok(!JSON.stringify(expectStatus(await call(alice, `api/spaces/${space.id}`), 200)).includes('Late revoked'));
  } finally {releaseModels();}
});

test('revoking a member closes their active space socket and websocket origins are checked', async () => {
  const space = await createSpace(alice, 'Realtime authorization');
  const invitation = expectStatus(await call(alice, `api/spaces/${space.id}/invitations`, {name: bob.user.name, role: 'viewer'}), 201).invitation;
  expectStatus(await call(bob, `api/space-invitations/${invitation.id}/accept`, {spaceId: space.id}), 200);
  const endpoint = `https://app.example/api/spaces/${space.id}/events`;
  const headers = {'Cf-Access-Jwt-Assertion': bob.token, Cookie: bob.cookie, Upgrade: 'websocket', Origin: 'https://app.example'};
  const forbidden = await mf.dispatchFetch(endpoint, {headers: {...headers, Origin: 'https://evil.example'}});
  assert.equal(forbidden.status, 403);
  // Miniflare's dispatchFetch pseudo-socket delays close events until the client
  // also closes. Use its real loopback server and bound the client's close
  // handshake; workerd's local bridge can retain a TCP half-close.
  const runtimeUrl = await mf.ready;
  const socketUrl = new URL(`/api/spaces/${space.id}/events`, runtimeUrl);
  socketUrl.protocol = 'ws:';
  const socket = new WebSocket(socketUrl, {closeTimeout: 500, headers: {'Cf-Access-Jwt-Assertion': bob.token, Cookie: bob.cookie, Origin: runtimeUrl.origin}});
  await new Promise((resolve, reject) => {socket.once('open', resolve); socket.once('error', reject);});
  try {
    const closed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Revoked space socket stayed open.')), 5000);
      socket.once('close', code => {clearTimeout(timer); resolve(code);});
    });
    expectStatus(await call(alice, `api/spaces/${space.id}/members/${bob.user.id}/remove`, {}), 200);
    assert.equal(await closed, 4003);
    expectStatus(await call(bob, `api/spaces/${space.id}`), 404);
  } finally {socket.close();}
});

test('hosted recommendations verify metadata, persist provenance, save and dismiss, and reject stale context', async () => {
  const space = await createSpace(alice, 'Verified agent discovery');
  const note = await createWidget(alice, space.id, 'notes', {content: {markdown: 'Build a collaborative notebook with a coding agent'}});
  const excluded = await createWidget(alice, space.id, 'notes', {includeInAI: false, content: {markdown: 'Private excluded material'}});
  const recommendations = await createWidget(alice, space.id, 'recommendations');
  expectStatus(await call(alice, `api/spaces/${space.id}/recommendations`, {}), 403);
  expectStatus(await call(alice, `api/spaces/${space.id}/settings`, {aiConsent: true, model: 'expensive-client-override'}), 200);
  holdModel = true;
  try {
    const refreshes = await Promise.all([
      call(alice, `api/spaces/${space.id}/recommendations`, {}),
      call(alice, `api/spaces/${space.id}/recommendations`, {}),
    ]);
    const requested = expectStatus(refreshes[0], 200);
    assert.equal(expectStatus(refreshes[1], 200).jobId, requested.jobId);
    const run = await modelJob(requested.jobId), job = run.job;
    assert.equal(job.kind, 'recommendations');
    assert.equal(job.userId, alice.user.id);
    assert.equal(job.provider, 'cloudflare');
    assert.equal(job.model, 'test-cloudflare-model');
    assert.deepEqual(job.context.widgets.map(widget => widget.id), [note.id]);
    assert.ok(!JSON.stringify(job).includes(excluded.id));
    assert.ok(!JSON.stringify(job).includes('Private excluded material'));
    assert.equal(job.context.recommendationWidgets[0].id, recommendations.id);
    run.release({recommendations: [
      {kind: 'github', url: 'https://github.com/openai/codex', reason: 'This repository supports the coding-agent workflow in your notebook notes.',
        sourceWidgetIds: [note.id], title: 'Unverified agent title', thumbnail: 'https://evil.example/image.png'},
      {kind: 'youtube', url: 'https://youtu.be/LRtest01234', reason: 'This tutorial explains the notebook architecture described in your notes.',
        sourceWidgetIds: [note.id], widgetId: recommendations.id, title: 'Another unverified title'},
      {kind: 'github', url: 'https://github.com/openai/foreign-source', reason: 'Must not use excluded context.', sourceWidgetIds: [excluded.id]},
    ]});
    let detail = await waitFor(async () => {
      const current = expectStatus(await call(alice, `api/spaces/${space.id}`), 200);
      return current.space.recommendationState.status === 'up-to-date' && current;
    }, 'verified recommendation cards');
    const cards = detail.widgets.find(widget => widget.id === recommendations.id).content.items;
    assert.equal(cards.length, 2);
    const repository = cards.find(card => card.kind === 'github');
    const video = cards.find(card => card.kind === 'youtube');
    assert.equal(repository.title, 'openai/codex');
    assert.equal(repository.description, 'Verified coding agent repository.');
    assert.equal(video.title, 'Verified notebook architecture tutorial');
    assert.equal(video.channel, 'Example Builders');
    assert.equal(video.url, 'https://www.youtube.com/watch?v=LRtest01234');
    for (const card of cards) {
      assert.deepEqual(card.sourceWidgetIds, [note.id]);
      assert.ok(Number.isFinite(Date.parse(card.verifiedAt)));
      assert.ok(card.reason.includes('notebook'));
    }
    assert.ok(!JSON.stringify(cards).includes('Unverified'));
    assert.ok(!JSON.stringify(cards).includes('evil.example'));
    assert.ok(!providerRequests.some(url => url.includes('foreign-source')));
    await restart();
    assert.deepEqual(expectStatus(await call(alice, `api/spaces/${space.id}`), 200).widgets.find(widget => widget.id === recommendations.id).content.items, cards);
    const saved = expectStatus(await call(alice, `api/spaces/${space.id}/recommendations/save`, {
      widgetId: recommendations.id, recommendationId: repository.id,
    }), 201).widget;
    assert.equal(saved.type, 'repositories');
    assert.equal(saved.content.items[0].url, repository.url);
    assert.equal(saved.content.items[0].metadata.title, repository.title);
    expectStatus(await call(alice, `api/spaces/${space.id}/recommendations/dismiss`, {
      widgetId: recommendations.id, recommendationId: video.id,
    }), 200);
    detail = expectStatus(await call(alice, `api/spaces/${space.id}`), 200);
    const emptied = detail.widgets.find(widget => widget.id === recommendations.id);
    assert.deepEqual(emptied.content.items, []);
    assert.deepEqual(new Set(emptied.content.dismissedUrls), new Set([repository.url, video.url]));
    const refresh = expectStatus(await call(alice, `api/spaces/${space.id}/recommendations`, {}), 200);
    const stale = await modelJob(refresh.jobId);
    expectStatus(await call(alice, `api/spaces/${space.id}/widgets/${note.id}`, {revision: note.revision, includeInAI: false}), 200);
    stale.release({recommendations: [
      {kind: 'github', url: 'https://github.com/openai/late-result', reason: 'Old context must not create a new card.', sourceWidgetIds: [note.id]},
    ]});
    await waitFor(async () => expectStatus(await call(alice, 'api/agent/status'), 200).jobs.find(item => item.id === stale.job.id)?.status === 'cancelled');
    assert.ok(!providerRequests.some(url => url.includes('late-result')));
    assert.deepEqual(expectStatus(await call(alice, `api/spaces/${space.id}`), 200).widgets.find(widget => widget.id === recommendations.id).content.items, []);
    await restart();
    const reopened = expectStatus(await call(alice, `api/spaces/${space.id}`), 200);
    assert.equal(reopened.widgets.find(widget => widget.id === saved.id).content.items[0].metadata.title, 'openai/codex');
    assert.deepEqual(new Set(reopened.widgets.find(widget => widget.id === recommendations.id).content.dismissedUrls), new Set([repository.url, video.url]));
  } finally {releaseModels();}
});

test('legacy spaces reset local AI consent while preserving widget identities, layout, and results', async () => {
  const space = await createSpace(alice, 'Legacy space migration');
  const note = await createWidget(alice, space.id, 'notes', {content: {markdown: 'Durable migration content'}});
  const recommendations = await createWidget(alice, space.id, 'recommendations');
  expectStatus(await call(alice, `api/spaces/${space.id}/settings`, {aiConsent: true}), 200);
  holdModel = true;
  try {
    const request = expectStatus(await call(alice, `api/spaces/${space.id}/recommendations`, {}), 200);
    const run = await modelJob(request.jobId);
    run.release({recommendations: [{kind: 'github', url: 'https://github.com/openai/codex', reason: 'A durable source for the migration notes.', sourceWidgetIds: [note.id]}]});
    await waitFor(async () => expectStatus(await call(alice, `api/spaces/${space.id}`), 200).space.recommendationState.status === 'up-to-date');
  } finally {releaseModels();}
  const previousCards = expectStatus(await call(alice, `api/spaces/${space.id}`), 200).widgets.find(widget => widget.id === recommendations.id).content.items;
  assert.equal(previousCards.length, 1);
  const saved = await spaceState(space.id);
  saved.settings = {automaticRecommendations: true, aiConsent: true, consentVersion: 7, model: 'legacy-codex'};
  saved.activeJob = {id: 'legacy-job', kind: 'recommendations', spaceId: space.id, userId: alice.user.id, contextVersion: String(saved.contextRevision)};
  saved.pendingAutoAt = Date.now() + 60_000;
  saved.recommendationState = {status: 'queued', jobId: 'legacy-job'};
  await spaceState(space.id, saved);
  const invokedBefore = modelRequests.length;
  await restart();
  const current = expectStatus(await call(alice, `api/spaces/${space.id}`), 200);
  assert.equal(current.space.ownerId, alice.user.id);
  assert.equal(current.space.settings.aiProvider, 'cloudflare');
  assert.equal(current.space.settings.aiConsent, false);
  assert.equal(current.space.settings.automaticRecommendations, false);
  assert.equal(current.space.settings.consentVersion, 8);
  assert.equal('model' in current.space.settings, false);
  assert.equal(current.space.recommendationState.status, 'paused');
  assert.deepEqual(current.layout, saved.layout);
  assert.equal(current.widgets.find(widget => widget.id === note.id).content.markdown, 'Durable migration content');
  assert.deepEqual(current.widgets.find(widget => widget.id === recommendations.id).content.items, previousCards);
  const migrated = await spaceState(space.id);
  assert.equal(migrated.contextRevision, saved.contextRevision + 1);
  assert.equal(migrated.widgets[recommendations.id].resultJobId, saved.widgets[recommendations.id].resultJobId);
  assert.equal(migrated.activeJob, undefined);
  assert.equal(migrated.pendingAutoAt, undefined);
  expectStatus(await call(alice, `api/spaces/${space.id}/recommendations`, {}), 403);
  assert.equal(modelRequests.length, invokedBefore);
  expectStatus(await call(alice, `api/spaces/${space.id}/settings`, {aiConsent: true}), 200);
  await restart();
  const reloaded = expectStatus(await call(alice, `api/spaces/${space.id}`), 200);
  assert.equal(reloaded.space.settings.aiConsent, true);
  assert.equal(reloaded.space.settings.consentVersion, 9);
});

test('revoking hosted AI consent rejects in-flight recommendations before provider verification', async () => {
  const space = await createSpace(alice, 'Consent revocation');
  const note = await createWidget(alice, space.id, 'notes', {content: {markdown: 'Selected source'}});
  const recommendations = await createWidget(alice, space.id, 'recommendations');
  const consent = expectStatus(await call(alice, `api/spaces/${space.id}/settings`, {aiConsent: true}), 200).space.settings;
  holdModel = true;
  try {
    const request = expectStatus(await call(alice, `api/spaces/${space.id}/recommendations`, {}), 200);
    const run = await modelJob(request.jobId);
    assert.equal(run.job.consentVersion, consent.consentVersion);
    const revoked = expectStatus(await call(alice, `api/spaces/${space.id}/settings`, {aiConsent: false}), 200);
    assert.equal(revoked.space.settings.consentVersion, consent.consentVersion + 1);
    run.release({recommendations: [{kind: 'github', url: 'https://github.com/openai/revoked-consent', reason: 'Must never be fetched.', sourceWidgetIds: [note.id]}]});
    await waitFor(async () => expectStatus(await call(alice, 'api/agent/status'), 200).jobs.find(job => job.id === request.jobId)?.status === 'cancelled');
    assert.ok(!providerRequests.some(url => url.includes('revoked-consent')));
    const current = expectStatus(await call(alice, `api/spaces/${space.id}`), 200);
    assert.equal(current.space.recommendationState.status, 'paused');
    assert.deepEqual(current.widgets.find(widget => widget.id === recommendations.id).content.items, []);
    expectStatus(await call(alice, `api/spaces/${space.id}/recommendations`, {}), 403);
  } finally {releaseModels();}
});

test('hosted AI unavailability keeps widgets editable and failed enqueue can be retried', async () => {
  const space = await createSpace(alice, 'Hosted availability');
  const note = await createWidget(alice, space.id, 'notes', {content: {markdown: 'Keep editing when AI is disabled'}});
  await createWidget(alice, space.id, 'recommendations');
  expectStatus(await call(alice, `api/spaces/${space.id}/settings`, {aiConsent: true}), 200);
  await restart({SPACES_AI_ENABLED: 'false'});
  assert.equal(expectStatus(await call(alice, 'api/agent/status'), 200).available, false);
  expectStatus(await call(alice, `api/spaces/${space.id}/recommendations`, {}), 503);
  expectStatus(await call(alice, 'api/agent/chat', {spaceId: space.id, message: 'Disabled chat'}), 503);
  expectStatus(await call(alice, `api/spaces/${space.id}/widgets/${note.id}`, {revision: note.revision, content: {markdown: 'Still saved'}}), 200);
  await restart({AI: ''});
  expectStatus(await call(alice, `api/spaces/${space.id}/recommendations`, {}), 503);
  const failed = await spaceState(space.id);
  assert.equal(failed.activeJob, undefined);
  assert.equal(failed.recommendationState.status, 'failed');
  await restart();
  holdModel = true;
  try {
    const retry = expectStatus(await call(alice, `api/spaces/${space.id}/recommendations`, {}), 200);
    await modelJob(retry.jobId);
    expectStatus(await call(alice, `api/spaces/${space.id}/recommendations/stop`, {}), 200);
    assert.equal((await spaceState(space.id)).activeJob, undefined);
  } finally {releaseModels();}
});

test('widget creation retries are idempotent and cannot resurrect a deleted widget', async () => {
  const space = await createSpace(alice, 'Reliable widget creation');
  const input = {type: 'notes', operationId: 'test-create-note', content: {markdown: 'Only one child object'}};
  const first = expectStatus(await call(alice, `api/spaces/${space.id}/widgets`, input), 201).widget;
  const retry = expectStatus(await call(alice, `api/spaces/${space.id}/widgets`, input), 201).widget;
  assert.equal(retry.id, first.id);
  assert.equal(retry.revision, first.revision);
  assert.equal(expectStatus(await call(alice, `api/spaces/${space.id}`), 200).widgets.length, 1);
  expectStatus(await call(alice, `api/spaces/${space.id}/widgets`, {...input, title: 'Different input'}), 409);
  expectStatus(await call(alice, `api/spaces/${space.id}/widgets/${first.id}/delete`, {revision: first.revision}), 200);
  expectStatus(await call(alice, `api/spaces/${space.id}/widgets`, input), 404);
  assert.deepEqual(expectStatus(await call(alice, `api/spaces/${space.id}`), 200).widgets, []);
});
