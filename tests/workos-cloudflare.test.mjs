import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {build} from 'esbuild';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';
import {exportJWK, generateKeyPair, SignJWT} from 'jose';

const origin = 'https://app.example';
const accessIssuer = 'https://workos-test.cloudflareaccess.com';
const clientId = 'client_workosruntimetests';
const audience = 'workos-test-audience';
const workosIssuer = 'https://api.workos.com';
const nativeIssuer = `${workosIssuer}/user_management/${clientId}`;
const codes = new Map();
const refreshTokens = new Map();
const refreshBehavior = new Map();
const refreshRequests = [];
const issuedSecrets = [];
const issuedClaims = new Map();
let mf, options, folder, workosKey, gateToken, legacy, legacyPeer, ownedSpace, sharedSpace, bookmark, groupId;

const cloneAuth = auth => ({...auth, cookies: {...auth.cookies}});
const browser = () => ({token: gateToken, cookies: {}});

async function call(auth, path, body, headers = {}) {
  const response = await mf.dispatchFetch(new URL(path, origin).href, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
    headers: {
      ...(auth ? {'Cf-Access-Jwt-Assertion': auth.token, Cookie: Object.entries(auth.cookies || {}).map(([key, value]) => `${key}=${value}`).join('; '),
        'X-CSRF-Token': auth.csrf || ''} : {}),
      ...(body === undefined ? {} : {'Content-Type': 'application/json', Origin: origin}),
      ...headers,
    },
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  });
  const cookies = response.headers.getSetCookie?.() || (response.headers.get('set-cookie') || '').split(/,(?=\s*[^;,]+=)/).filter(Boolean);
  if (auth) for (const cookie of cookies) {
    const pair = cookie.split(';')[0];
    const separator = pair.indexOf('=');
    const name = pair.slice(0, separator).trim(), value = pair.slice(separator + 1);
    if (/\bmax-age=0\b/i.test(cookie)) delete auth.cookies[name];
    else auth.cookies[name] = value;
  }
  const text = await response.text();
  let data;
  try {data = JSON.parse(text);} catch {data = text;}
  if (auth && data?.csrf) auth.csrf = data.csrf;
  return {status: response.status, data, cookies, location: response.headers.get('location'), headers: response.headers};
}

function expectStatus(response, status) {
  assert.equal(response.status, status, JSON.stringify(response.data));
  return response.data;
}

function assertNoTokens(response) {
  const serialized = JSON.stringify({data: response.data, cookies: response.cookies, location: response.location});
  for (const secret of issuedSecrets) assert.ok(!serialized.includes(secret), 'Browser response exposed a WorkOS token.');
  assert.ok(!/"(?:accessToken|refreshToken|access_token|refresh_token)"/.test(serialized));
}

async function authentication(identity, tokenOptions = {}) {
  const now = Math.floor(Date.now() / 1000);
  // Native AuthKit sessions bind the client in their issuer and JWKS endpoint;
  // they do not require the extra client_id claim used by Connect-style tokens.
  const claims = {sid: `session_${identity}`, ...tokenOptions.claims};
  if (tokenOptions.omitSid) delete claims.sid;
  const issuer = tokenOptions.issuer || nativeIssuer;
  issuedClaims.set(identity, {...claims, iss: issuer});
  const accessToken = await new SignJWT(claims)
    .setProtectedHeader({alg: 'RS256', kid: 'workos-key'})
    .setSubject(tokenOptions.subject || identity).setIssuer(issuer)
    .setIssuedAt(now).setExpirationTime(now + (tokenOptions.ttl || 3600)).sign(workosKey);
  const refreshToken = `refresh_secret_${randomUUID()}`;
  refreshTokens.set(refreshToken, {identity});
  issuedSecrets.push(accessToken, refreshToken);
  return {user: {object: 'user', id: identity, email: `${identity}@example.com`, email_verified: true,
    first_name: 'WorkOS', last_name: 'Builder', created_at: new Date().toISOString(), updated_at: new Date().toISOString()},
    access_token: accessToken, refresh_token: refreshToken, authentication_method: 'authkit'};
}

async function begin(auth, {signup = false, returnTo = '/spaces'} = {}) {
  const response = await call(auth, `/auth/${signup ? 'signup' : 'login'}?returnTo=${encodeURIComponent(returnTo)}`);
  expectStatus(response, 302);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  const location = new URL(response.location);
  assert.equal(location.origin, workosIssuer);
  assert.equal(location.pathname, '/user_management/authorize');
  assert.equal(location.searchParams.get('client_id'), clientId);
  assert.equal(location.searchParams.get('redirect_uri'), `${origin}/auth/callback`);
  assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(location.searchParams.get('code_challenge'));
  assert.ok(location.searchParams.get('state'));
  if (signup) assert.equal(location.searchParams.get('screen_hint'), 'sign-up');
  const cookie = response.cookies.find(value => value.startsWith('lr_oauth='));
  assert.match(cookie || '', /HttpOnly/i);
  assert.match(cookie, /Secure/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.ok(auth.cookies.lr_oauth);
  return {state: location.searchParams.get('state'), challenge: location.searchParams.get('code_challenge')};
}

function codeFor(flow, identity, tokenOptions = {}) {
  const code = `code_${randomUUID()}`;
  codes.set(code, {identity, challenge: flow.challenge, tokenOptions});
  return `/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(flow.state)}`;
}

async function signIn(auth, identity, {tokenOptions, ...startOptions} = {}) {
  const flow = await begin(auth, startOptions);
  const callback = await call(auth, codeFor(flow, identity, tokenOptions));
  expectStatus(callback, 302);
  assert.equal(callback.headers.get('referrer-policy'), 'no-referrer');
  assertNoTokens(callback);
  assert.match(callback.cookies.find(value => value.startsWith('lr_session=')) || '', /HttpOnly/i);
  assert.ok(!auth.cookies.lr_oauth);
  return callback;
}

async function newBuilder(identity, name) {
  const auth = browser();
  await signIn(auth, identity);
  expectStatus(await call(auth, '/api/session'), 200);
  auth.user = expectStatus(await call(auth, '/api/auth/onboard', {mode: 'create', name}), 200).user;
  assert.ok(auth.user?.id);
  expectStatus(await call(auth, '/api/session'), 200);
  return auth;
}

async function restart(bindings = {}) {
  await mf?.dispose();
  mf = new Miniflare(convertV4MiniflareOptions({...options, bindings: {...options.bindings, ...bindings}}));
  await mf.ready;
}

before(async () => {
  folder = await mkdtemp(join(tmpdir(), 'load-and-run-workos-'));
  const [accessPair, workosPair, result] = await Promise.all([
    generateKeyPair('RS256', {extractable: true}), generateKeyPair('RS256', {extractable: true}),
    build({stdin: {resolveDir: process.cwd(), contents: `
      import app, {Workspace as ApplicationWorkspace} from './worker/index.ts';
      import {openSQLiteStore} from './server/sqlite-store.mjs';
      import {newUser} from './server/model.mjs';
      import {randomBytes} from 'node:crypto';
      export {Space, Widget, SpaceDirectory} from './worker/index.ts';
      export class Workspace extends ApplicationWorkspace {
        async legacyFixture(id) {
          const store = openSQLiteStore(this.ctx.storage);
          store.transaction(state => {
            const user = state.users.find(value => value.id === id);
            const {hash, salt} = newUser(user.name, 'old-builder-password');
            delete user.workosId; delete user.email; delete user.emailVerified;
            Object.assign(user, {hash, salt});
          });
          const token = randomBytes(32).toString('hex'), csrf = randomBytes(24).toString('hex');
          store.sessions.set(token, {user:id, csrf, expires:Date.now()+3600000});
          return {token, csrf};
        }
      }
      export default {async fetch(request, env, ctx) {
        if (new URL(request.url).pathname === '/__test/legacy') return Response.json(await env.WORKSPACES.getByName(env.WORKSPACE_ID).legacyFixture((await request.json()).id));
        return app.fetch(request, env, ctx);
      }};
    `}, bundle: true, write: false, format: 'esm', platform: 'browser', external: ['node:*', 'cloudflare:*']}),
  ]);
  workosKey = workosPair.privateKey;
  const accessJwk = {...await exportJWK(accessPair.publicKey), kid: 'access-key', alg: 'RS256', use: 'sig'};
  const workosJwk = {...await exportJWK(workosPair.publicKey), kid: 'workos-key', alg: 'RS256', use: 'sig'};
  gateToken = await new SignJWT({email: 'gate@example.com'}).setProtectedHeader({alg: 'RS256', kid: 'access-key'})
    .setSubject('shared-gate').setIssuer(accessIssuer).setAudience(audience).setIssuedAt().setExpirationTime('1h').sign(accessPair.privateKey);
  options = {
    modules: true, script: result.outputFiles[0].text, compatibilityDate: '2026-09-04', compatibilityFlags: ['nodejs_compat'],
    durableObjects: {WORKSPACES: {className: 'Workspace', useSQLite: true}, SPACES: {className: 'Space', useSQLite: true},
      WIDGETS: {className: 'Widget', useSQLite: true}, SPACE_DIRECTORIES: {className: 'SpaceDirectory', useSQLite: true}},
    resourcePersistencePath: folder,
    bindings: {ENVIRONMENT: 'production', ACCESS_TEAM_DOMAIN: 'workos-test.cloudflareaccess.com', ACCESS_AUD: audience,
      WORKSPACE_ID: 'workos-test', SPACES_ENABLED: 'true', AUTH_PROVIDER: 'workos', WORKOS_CLIENT_ID: clientId, WORKOS_ALLOWED_ORIGINS: origin},
    serviceBindings: {ASSETS: () => Response.json({asset: true})},
    outboundService: async request => {
      if (request.url === `${accessIssuer}/cdn-cgi/access/certs`) return Response.json({keys: [accessJwk]});
      if (request.url === `${workosIssuer}/sso/jwks/${clientId}`) return Response.json({keys: [workosJwk]});
      assert.equal(request.url, `${workosIssuer}/user_management/authenticate`, 'Unexpected outbound request');
      assert.equal(request.method, 'POST');
      const body = await request.json();
      assert.equal(body.client_id, clientId);
      assert.equal(body.client_secret, undefined, 'PKCE must work without an API key.');
      if (body.grant_type === 'authorization_code') {
        const fixture = codes.get(body.code);
        if (!fixture) return Response.json({error: 'invalid_grant', error_description: 'Unknown or spent code'}, {status: 400});
        codes.delete(body.code);
        assert.equal(createHash('sha256').update(body.code_verifier).digest('base64url'), fixture.challenge);
        return Response.json(await authentication(fixture.identity, fixture.tokenOptions));
      }
      assert.equal(body.grant_type, 'refresh_token');
      const fixture = refreshTokens.get(body.refresh_token);
      refreshRequests.push({identity: fixture?.identity, token: body.refresh_token});
      if (!fixture) return Response.json({error: 'invalid_grant', error_description: 'Refresh token already used'}, {status: 400});
      const behavior = refreshBehavior.get(fixture.identity);
      if (behavior === 'transient') return Response.json({message: 'Temporary provider failure'}, {status: 503});
      if (behavior === 'terminal') return Response.json({error: 'invalid_grant', error_description: 'Session revoked'}, {status: 400});
      refreshTokens.delete(body.refresh_token);
      return Response.json(await authentication(fixture.identity));
    },
  };
  await restart();
  legacy = await newBuilder('user_fixture_owner', 'LegacyOwner');
  legacyPeer = await newBuilder('user_fixture_peer', 'LegacyPeer');
  ownedSpace = expectStatus(await call(legacy, '/api/spaces', {title: 'Existing owner space'}), 201).space;
  expectStatus(await call(legacy, `/api/spaces/${ownedSpace.id}/widgets`, {type: 'notes', content: {markdown: 'Preserve my existing widget'}}), 201);
  sharedSpace = expectStatus(await call(legacyPeer, '/api/spaces', {title: 'Existing shared space'}), 201).space;
  const invite = expectStatus(await call(legacyPeer, `/api/spaces/${sharedSpace.id}/invitations`, {name: legacy.user.name, role: 'editor'}), 201).invitation;
  expectStatus(await call(legacy, `/api/space-invitations/${invite.id}/accept`, {spaceId: sharedSpace.id}), 200);
  groupId = expectStatus(await call(legacyPeer, '/api/community/groups', {name: 'Existing membership', description: 'Preserve this group membership.'}), 201).id;
  expectStatus(await call(legacy, `/api/community/groups/${groupId}/join`, {}), 200);
  const catalog = JSON.parse(await readFile(new URL('../src/data.json', import.meta.url)));
  expectStatus(await call(legacy, '/api/community/bookmarks', {ideaAddress: catalog.blueprints[0].addr}), 200);
  bookmark = expectStatus(await call(legacy, '/api/community/bookmarks'), 200)[0];
  // Reproduce the persisted username-only account/session format without
  // retaining a legacy login implementation in the production application.
  for (const auth of [legacy, legacyPeer]) {
    const fixture = expectStatus(await call(null, '/__test/legacy', {id: auth.user.id}), 200);
    auth.cookies = {lr_session: fixture.token};
    auth.csrf = fixture.csrf;
  }
  await restart();
}, {timeout: 30000});

after(async () => {
  await mf?.dispose();
  if (folder) await rm(folder, {recursive: true, force: true});
}, {timeout: 15000});

test('WorkOS mode disables legacy password entry points and rejects old sessions', {timeout: 10000}, async () => {
  const auth = browser();
  const session = expectStatus(await call(auth, '/api/session'), 200);
  assert.equal(session.authProvider, 'workos');
  assert.equal(session.user, null);
  assert.equal(session.loginUrl, '/auth/login');
  assert.equal(session.signupUrl, '/auth/signup');
  for (const endpoint of ['login', 'register']) {
    const result = await call(auth, `/api/${endpoint}`, {name: 'LegacyOwner', password: 'old-builder-password'});
    assert.ok([404, 405, 410].includes(result.status), JSON.stringify(result));
    assert.ok(!auth.cookies.lr_session);
  }
  assert.equal(expectStatus(await call(cloneAuth(legacy), '/api/session'), 200).user, null);
  expectStatus(await call(legacy, '/api/spaces'), 401);
  expectStatus(await call(null, '/auth/login'), 401);
});

test('OAuth state is bound to its browser, expires after use, and does not accept external return destinations', {timeout: 15000}, async () => {
  const auth = browser();
  const flow = await begin(auth);
  const callbackPath = codeFor(flow, 'user_state');
  const wrongBrowser = browser();
  assert.ok([400, 401, 403].includes((await call(wrongBrowser, callbackPath)).status));
  assert.ok(!wrongBrowser.cookies.lr_session);
  const wrongState = await call(cloneAuth(auth), callbackPath.replace(flow.state, 'incorrect-state'));
  assert.ok([400, 401, 403].includes(wrongState.status));
  assert.ok([400, 401, 403].includes((await call(cloneAuth(auth), callbackPath.split('&state=')[0])).status));
  assert.ok(!auth.cookies.lr_session);
  const fresh = await begin(auth);
  const validPath = codeFor(fresh, 'user_state');
  const replayCookie = cloneAuth(auth);
  expectStatus(await call(auth, validPath), 302);
  assert.ok([400, 401, 403].includes((await call(replayCookie, validPath)).status));
  assert.ok(!replayCookie.cookies.lr_session);
  for (const returnTo of ['https://evil.example/steal', '//evil.example/steal', '/\\evil.example/steal']) {
    const visitor = browser();
    const response = await call(visitor, `/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
    if (response.status === 302) {
      const url = new URL(response.location);
      const safeFlow = {state: url.searchParams.get('state'), challenge: url.searchParams.get('code_challenge')};
      const completed = await call(visitor, codeFor(safeFlow, 'user_safe_return'));
      expectStatus(completed, 302);
      assert.equal(new URL(completed.location, origin).origin, origin);
      assert.ok(!completed.location.includes('evil.example'));
    } else assert.ok([400, 403].includes(response.status));
  }
  const untrustedOrigin = await mf.dispatchFetch('https://evil.example/auth/login', {redirect: 'manual', headers: {'Cf-Access-Jwt-Assertion': gateToken}});
  assert.ok([400, 403, 503].includes(untrustedOrigin.status));
  assert.equal(untrustedOrigin.headers.get('location'), null);
});

test('cancelled OAuth authorization consumes its browser-bound attempt without creating a session', {timeout: 10000}, async () => {
  const auth = browser();
  const flow = await begin(auth);
  const oldCookie = cloneAuth(auth);
  const response = await call(auth, `/auth/callback?error=access_denied&state=${encodeURIComponent(flow.state)}`);
  expectStatus(response, 302);
  assert.equal(response.location, '/spaces?authError=cancelled');
  assert.ok(!auth.cookies.lr_oauth);
  assert.ok(!auth.cookies.lr_session);
  const replay = await call(oldCookie, codeFor(flow, 'user_cancelled'));
  assert.ok([400, 401, 403].includes(replay.status));
  assert.ok(!oldCookie.cookies.lr_session);
});

test('signed WorkOS tokens require the configured issuer, user, session, and a matching client claim when present', {timeout: 15000}, async () => {
  for (const tokenOptions of [{issuer: 'https://evil.example'}, {issuer: `${workosIssuer}/user_management/client_anotherapp`},
    {claims: {client_id: 'client_another_app'}},
    {subject: 'user_someone_else'}, {omitSid: true}]) {
    const auth = browser();
    const flow = await begin(auth);
    const response = await call(auth, codeFor(flow, 'user_invalid_claims', tokenOptions));
    expectStatus(response, 302);
    assert.equal(response.location, '/spaces?authError=failed');
    assert.ok(!auth.cookies.lr_session);
    assertNoTokens(response);
    assert.equal(expectStatus(await call(auth, '/api/session'), 200).user, null);
  }
});

test('signup creates a pending session, requires CSRF and explicit onboarding, and retains its builder identity', {timeout: 15000}, async () => {
  const auth = browser();
  const callback = await signIn(auth, 'user_signup', {signup: true, returnTo: '/spaces?filter=mine'});
  assert.equal(new URL(callback.location, origin).pathname, '/account/setup');
  assert.equal(new URL(callback.location, origin).searchParams.get('returnTo'), '/spaces?filter=mine');
  const pending = expectStatus(await call(auth, '/api/session'), 200);
  assert.equal(pending.user, null);
  assert.equal(pending.onboarding.email, 'user_signup@example.com');
  assert.ok(pending.csrf);
  expectStatus(await call(auth, '/api/spaces'), 401);
  expectStatus(await call(auth, '/api/auth/onboard', {mode: 'create', name: 'WorkOSBuilder'}, {'X-CSRF-Token': ''}), 401);
  expectStatus(await call(auth, '/api/auth/onboard', {mode: 'create', name: 'WorkOSBuilder'}, {Origin: 'https://evil.example'}), 403);
  const pendingSnapshot = cloneAuth(auth);
  const created = await call(auth, '/api/auth/onboard', {mode: 'create', name: 'WorkOSBuilder'});
  const account = expectStatus(created, 200).user;
  assert.deepEqual(Object.keys(account).sort(), ['id', 'name']);
  assert.equal(account.name, 'WorkOSBuilder');
  assert.notEqual(account.id, 'user_signup');
  assert.notEqual(auth.cookies.lr_session, pendingSnapshot.cookies.lr_session);
  assertNoTokens(created);
  assert.equal(expectStatus(await call(pendingSnapshot, '/api/session'), 200).user, null);
  await restart();
  assert.deepEqual(expectStatus(await call(auth, '/api/session'), 200).user, account);
  const anotherBrowser = browser();
  const mapped = await signIn(anotherBrowser, 'user_signup', {returnTo: '/spaces?filter=mine'});
  assert.equal(mapped.location, '/spaces?filter=mine');
  assert.deepEqual(expectStatus(await call(anotherBrowser, '/api/session'), 200).user, account);
  assertNoTokens(await call(anotherBrowser, '/api/session'));
});

test('claiming an existing builder preserves UUID, widgets, bookmarks, and shared memberships after restart', {timeout: 15000}, async () => {
  const auth = browser();
  await signIn(auth, 'user_legacy_owner');
  expectStatus(await call(auth, '/api/session'), 200);
  expectStatus(await call(auth, '/api/auth/onboard', {mode: 'create', name: 'LegacyOwner'}), 409);
  expectStatus(await call(auth, '/api/auth/onboard', {mode: 'claim', name: 'LegacyOwner', password: 'wrong-password'}), 401);
  const claimed = expectStatus(await call(auth, '/api/auth/onboard', {mode: 'claim', name: 'legacyowner', password: 'old-builder-password'}), 200).user;
  assert.deepEqual(claimed, legacy.user);
  await signIn(auth, 'user_legacy_owner', {tokenOptions: {ttl: 2}});
  await delay(2200);
  assert.deepEqual(expectStatus(await call(auth, '/api/session'), 200).user, legacy.user);
  await restart();
  assert.deepEqual(expectStatus(await call(auth, '/api/session'), 200).user, legacy.user);
  const owned = expectStatus(await call(auth, `/api/spaces/${ownedSpace.id}`), 200);
  assert.equal(owned.space.ownerId, legacy.user.id);
  assert.equal(owned.widgets[0].content.markdown, 'Preserve my existing widget');
  expectStatus(await call(auth, `/api/spaces/${sharedSpace.id}/widgets`, {type: 'notes', content: {markdown: 'Retained editor membership'}}), 201);
  assert.deepEqual(expectStatus(await call(auth, '/api/community/bookmarks'), 200), [bookmark]);
  assert.equal(expectStatus(await call(auth, '/api/community'), 200).groups.find(group => group.id === groupId).joined, true);
  const peer = browser();
  await signIn(peer, 'user_signup');
  const peerUser = expectStatus(await call(peer, '/api/session'), 200).user;
  const invitation = expectStatus(await call(auth, `/api/spaces/${ownedSpace.id}/invitations`, {name: peerUser.name, role: 'viewer'}), 201).invitation;
  expectStatus(await call(peer, `/api/space-invitations/${invitation.id}/accept`, {spaceId: ownedSpace.id}), 200);
  assert.equal(expectStatus(await call(peer, `/api/spaces/${ownedSpace.id}`), 200).widgets[0].content.markdown, 'Preserve my existing widget');
  expectStatus(await call(peer, `/api/spaces/${ownedSpace.id}/widgets`, {type: 'notes'}), 403);
  const attacker = browser();
  await signIn(attacker, 'user_claim_attacker');
  expectStatus(await call(attacker, '/api/session'), 200);
  expectStatus(await call(attacker, '/api/auth/onboard', {mode: 'claim', name: 'LegacyOwner', password: 'old-builder-password'}), 409);
  expectStatus(await call(attacker, `/api/spaces/${ownedSpace.id}`), 401);
  const nextSession = browser();
  await signIn(nextSession, 'user_legacy_owner');
  assert.deepEqual(expectStatus(await call(nextSession, '/api/session'), 200).user, legacy.user);
});

test('native AuthKit sessions without client_id sign in, share one concurrent refresh, and persist across restarts', {timeout: 15000}, async () => {
  const identity = 'user_refresh_race';
  const auth = await newBuilder(identity, 'RefreshBuilder');
  await signIn(auth, identity, {tokenOptions: {ttl: 2}});
  assert.equal(issuedClaims.get(identity).iss, nativeIssuer);
  assert.equal(issuedClaims.get(identity).client_id, undefined);
  await delay(2200);
  const beforeCount = refreshRequests.filter(request => request.identity === identity).length;
  const responses = await Promise.all(Array.from({length: 5}, () => call(cloneAuth(auth), '/api/session')));
  for (const response of responses) {
    assert.deepEqual(expectStatus(response, 200).user, auth.user);
    assertNoTokens(response);
  }
  assert.equal(refreshRequests.filter(request => request.identity === identity).length - beforeCount, 1);
  assert.equal(issuedClaims.get(identity).iss, nativeIssuer);
  assert.equal(issuedClaims.get(identity).client_id, undefined);
  await restart();
  assert.deepEqual(expectStatus(await call(auth, '/api/session'), 200).user, auth.user);
  assert.equal(refreshRequests.filter(request => request.identity === identity).length - beforeCount, 1);
});

test('transient refresh failure retains the session for retry; provider revocation invalidates it', {timeout: 20000}, async () => {
  const identity = 'user_refresh_failures';
  const auth = await newBuilder(identity, 'RefreshFailures');
  await signIn(auth, identity, {tokenOptions: {ttl: 2}});
  await delay(2200);
  refreshBehavior.set(identity, 'transient');
  const failed = await call(auth, '/api/session');
  expectStatus(failed, 503);
  assertNoTokens(failed);
  refreshBehavior.delete(identity);
  assert.deepEqual(expectStatus(await call(auth, '/api/session'), 200).user, auth.user);
  await signIn(auth, identity, {tokenOptions: {ttl: 2}});
  await delay(2200);
  refreshBehavior.set(identity, 'terminal');
  const revoked = await call(auth, '/api/session');
  assert.ok(revoked.status === 401 || (revoked.status === 200 && revoked.data.user === null), JSON.stringify(revoked));
  expectStatus(await call(auth, '/api/spaces'), 401);
  refreshBehavior.delete(identity);
  await restart();
  assert.equal(expectStatus(await call(auth, '/api/session'), 200).user, null);
});

test('logout revokes the app session and returns only the WorkOS session logout URL', {timeout: 15000}, async () => {
  const auth = await newBuilder('user_logout', 'LogoutBuilder');
  const oldSession = cloneAuth(auth);
  expectStatus(await call(auth, '/api/logout', {}, {Origin: 'https://evil.example'}), 403);
  expectStatus(await call(auth, '/api/logout', {}, {'X-CSRF-Token': ''}), 401);
  const response = await call(auth, '/api/logout', {});
  const result = expectStatus(response, 200);
  const logoutUrl = new URL(result.logoutUrl);
  assert.equal(logoutUrl.origin, workosIssuer);
  assert.equal(logoutUrl.pathname, '/user_management/sessions/logout');
  assert.equal(logoutUrl.searchParams.get('session_id'), 'session_user_logout');
  assert.equal(new URL(logoutUrl.searchParams.get('return_to')).origin, origin);
  assert.ok(response.cookies.some(cookie => cookie.startsWith('lr_session=') && /Max-Age=0/i.test(cookie)));
  assertNoTokens(response);
  assert.equal(expectStatus(await call(oldSession, '/api/session'), 200).user, null);
  expectStatus(await call(oldSession, '/api/spaces'), 401);
});

test('ambiguous duplicate session cookies cannot authenticate APIs', {timeout: 10000}, async () => {
  const auth = await newBuilder('user_duplicate_cookie', 'DuplicateCookieBuilder');
  const sessionCookie = `lr_session=${auth.cookies.lr_session}`;
  for (const duplicate of [sessionCookie, `lr_session=${'x'.repeat(43)}`]) {
    const headers = {Cookie: `${sessionCookie}; unrelated=present; ${duplicate}`};
    assert.equal(expectStatus(await call(auth, '/api/session', undefined, headers), 200).user, null);
    expectStatus(await call(auth, '/api/spaces', undefined, headers), 401);
  }
  assert.deepEqual(expectStatus(await call(auth, '/api/session'), 200).user, auth.user);
});

test('logout remains available during a provider outage after its access token expires', {timeout: 10000}, async () => {
  const identity = 'user_logout_outage';
  const auth = await newBuilder(identity, 'LogoutOutageBuilder');
  await signIn(auth, identity, {tokenOptions: {ttl: 2}});
  expectStatus(await call(auth, '/api/session'), 200);
  const oldSession = cloneAuth(auth);
  await delay(2200);
  const beforeCount = refreshRequests.filter(request => request.identity === identity).length;
  refreshBehavior.set(identity, 'transient');
  try {
    expectStatus(await call(auth, '/api/logout', {}, {Origin: 'https://evil.example'}), 403);
    expectStatus(await call(auth, '/api/logout', {}, {'X-CSRF-Token': ''}), 401);
    const response = await call(auth, '/api/logout', {});
    const result = expectStatus(response, 200);
    assert.equal(new URL(result.logoutUrl).searchParams.get('session_id'), `session_${identity}`);
    assert.ok(response.cookies.some(cookie => cookie.startsWith('lr_session=') && /Max-Age=0/i.test(cookie)));
    assert.ok(!auth.cookies.lr_session);
    assertNoTokens(response);
    assert.equal(expectStatus(await call(oldSession, '/api/session'), 200).user, null);
    expectStatus(await call(oldSession, '/api/spaces'), 401);
    assert.equal(refreshRequests.filter(request => request.identity === identity).length, beforeCount);
  } finally {refreshBehavior.delete(identity);}
});
