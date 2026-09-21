import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {generateKeyPair, exportJWK, SignJWT} from 'jose';
import {randomBytes} from 'node:crypto';
import {openTestStore} from './helpers/sqlite.mjs';
import {newUser} from '../server/model.mjs';

const bundled = await build({entryPoints: ['worker/authkit.ts'], bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{name: 'workos-test-transport', setup(builder) {
    builder.onResolve({filter: /^@workos-inc\/node\/worker$/}, () => ({path: 'workos', namespace: 'test'}));
    builder.onLoad({filter: /.*/, namespace: 'test'}, () => ({contents: 'export class WorkOS { constructor(options) { globalThis.__workosOptions = options; this.userManagement = globalThis.__workosMock; }}'}));
  }}]});
const {AuthKitAuth, authCookie, safeReturnTo} = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
const clientId = 'client_test';
const env = {AUTH_PROVIDER: 'workos', ENVIRONMENT: 'local', WORKOS_CLIENT_ID: clientId, WORKOS_ALLOWED_ORIGINS: 'http://127.0.0.1:4185'};
const origin = 'http://127.0.0.1:4185';
const identity = {id: 'user_alice', email: 'alice@example.com', emailVerified: true, firstName: 'Alice', lastName: 'Builder'};
const keyPair = await generateKeyPair('RS256');
const publicKey = {...await exportJWK(keyPair.publicKey), kid: 'workos-test', alg: 'RS256', use: 'sig'};
const token = () => randomBytes(32).toString('base64url');
const failWith = (error, status = 400) => Object.assign(new Error('provider internal detail'), {error, status});
const status = expected => error => error.status === expected;

async function jwt(overrides = {}) {
  return new SignJWT({iss: 'https://api.workos.com', sub: identity.id, sid: 'session_alice', client_id: clientId, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, ...overrides})
    .setProtectedHeader({alg: 'RS256', kid: publicKey.kid}).sign(keyPair.privateKey);
}

async function fixture(t, overrides = {}) {
  const store = openTestStore();
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), 'https://api.workos.com/sso/jwks/' + clientId);
    return new Response(JSON.stringify({keys: [publicKey]}), {headers: {'content-type': 'application/json'}});
  };
  let exchanges = 0, refreshes = 0;
  const issued = {user: identity, accessToken: await jwt(), refreshToken: 'refresh-original'};
  globalThis.__workosMock = {
    async getAuthorizationUrlWithPKCE({redirectUri, screenHint}) {
      return {url: `https://api.workos.com/user_management/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&screen_hint=${screenHint}`, state: 'random-server-state', codeVerifier: 'server-pkce-verifier'};
    },
    async authenticateWithCode({code, codeVerifier}) {
      exchanges++;
      assert.equal(code, 'authorized-code');
      assert.equal(codeVerifier, 'server-pkce-verifier');
      return issued;
    },
    async authenticateWithRefreshToken({refreshToken}) {
      refreshes++;
      assert.equal(refreshToken, 'refresh-original');
      return {...issued, accessToken: await jwt(), refreshToken: 'refresh-rotated'};
    },
    getLogoutUrl({sessionId, returnTo}) {return `https://api.workos.com/user_management/sessions/logout?session_id=${sessionId}&return_to=${encodeURIComponent(returnTo)}`;},
    ...overrides,
  };
  const auth = new AuthKitAuth(env, store);
  t.after(() => {globalThis.fetch = nativeFetch; store.close(); delete globalThis.__workosMock; delete globalThis.__workosOptions;});
  const call = (path, cookie = '', method = 'GET') => auth.handle({url: origin + path, method, headers: {cookie}, body: ''});
  const begin = async (returnTo = '/spaces') => {
    const response = await call('/auth/login?returnTo=' + encodeURIComponent(returnTo));
    return {response, cookie: response.headers['Set-Cookie'].split(';')[0]};
  };
  const complete = async (returnTo = '/spaces') => {
    const {cookie: oauthCookie} = await begin(returnTo);
    const response = await call('/auth/callback?code=authorized-code&state=random-server-state', oauthCookie);
    const sessionCookie = response.headers['Set-Cookie'].find(value => value.startsWith('lr_session='))?.split(';')[0];
    return {response, cookie: sessionCookie, oauthCookie};
  };
  const session = async ({expired = false, user} = {}) => {
    const opaque = token();
    store.sessions.set(opaque, {kind: 'workos', user, csrf: token(), expires: Date.now() + 86400_000, returnTo: '/spaces', workos: {identity, accessToken: await jwt(expired ? {exp: Math.floor(Date.now() / 1000) - 1} : {}), refreshToken: 'refresh-original', sessionId: 'session_alice', expiresAt: Date.now() + (expired ? -1000 : 300_000)}});
    return {opaque, cookie: 'lr_session=' + opaque};
  };
  return {auth, store, call, begin, complete, session, issued, counts: () => ({exchanges, refreshes})};
}

test('auth cookies reject duplicates and unsafe characters; return paths cannot redirect offsite or loop auth', () => {
  const opaque = token();
  assert.equal(authCookie('other=ok; lr_session=' + opaque), opaque);
  for (const cookie of ['', 'lr_session=short', `lr_session=${opaque}; lr_session=${opaque}`, 'lr_session=%0A']) assert.equal(authCookie(cookie), '');
  for (const path of ['https://evil.test', '//evil.test', '/\\evil.test', '/spaces\nX', '/auth/login', '/api/session', '/account/setup']) assert.equal(safeReturnTo(path), '/spaces');
  assert.equal(safeReturnTo('/spaces/abc?tab=notes#title'), '/spaces/abc?tab=notes#title');
});

test('PKCE login is origin-allowlisted and stores secrets only in encrypted transaction storage', async t => {
  const f = await fixture(t);
  const {response, cookie} = await f.begin('/spaces/example');
  assert.equal(response.status, 302);
  assert.match(response.headers['Set-Cookie'], /HttpOnly; SameSite=Lax; Path=\//);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.equal(f.store.sessions.get(authCookie(cookie, 'lr_oauth')).returnTo, '/spaces/example');
  assert.doesNotMatch(JSON.stringify(response), /server-pkce-verifier/);
  assert.equal(globalThis.__workosOptions.apiKey, undefined);
  assert.equal(globalThis.__workosOptions.maxRetries, 0);
  await assert.rejects(() => f.auth.handle({url: 'https://attacker.test/auth/login', method: 'GET', headers: {}, body: ''}), status(400));
  await assert.rejects(() => f.call('/auth/login', '', 'POST'), status(405));
});

test('callback requires matching browser and state, and consumes valid transactions exactly once', async t => {
  const f = await fixture(t);
  const {cookie} = await f.begin();
  await assert.rejects(() => f.call('/auth/callback?code=authorized-code&state=random-server-state'), status(400));
  await assert.rejects(() => f.call('/auth/callback?code=authorized-code&state=attacker-state', cookie), status(400));
  assert.equal(f.counts().exchanges, 0);
  const response = await f.call('/auth/callback?code=authorized-code&state=random-server-state', cookie);
  assert.equal(response.status, 302);
  assert.match(response.headers.Location, /^\/account\/setup\?/);
  await assert.rejects(() => f.call('/auth/callback?code=authorized-code&state=random-server-state', cookie), status(400));
  assert.equal(f.counts().exchanges, 1);
});

test('unmapped sign-in stays pending; explicit onboarding preserves return path and rotates opaque credentials', async t => {
  const f = await fixture(t);
  const {response, cookie} = await f.complete('/spaces/shared');
  assert.doesNotMatch(JSON.stringify(response), /refresh-original|accessToken|alice@example/);
  const pending = f.auth.sessionInfo(cookie);
  assert.equal(pending.user, null);
  assert.deepEqual(pending.onboarding, {email: identity.email, suggestedName: 'Alice Builder'});
  assert.ok(pending.csrf);
  const result = await f.auth.onboard(cookie, {mode: 'create', name: 'my-builder'});
  assert.equal(result.body.returnTo, '/spaces/shared');
  assert.equal(result.body.user.name, 'my-builder');
  assert.equal(f.store.sessions.get(authCookie(cookie)), undefined);
  const nextCookie = result.headers['Set-Cookie'].split(';')[0];
  assert.notEqual(nextCookie, cookie);
  assert.deepEqual(f.auth.sessionInfo(nextCookie).user, result.body.user);
  assert.notEqual(f.auth.sessionInfo(nextCookie).csrf, pending.csrf);
});

test('repeated hosted sign-in resolves the immutable mapped builder and never a matching display name', async t => {
  const f = await fixture(t);
  const legacy = newUser('Alice Builder', 'legacy-password');
  f.store.transaction(state => state.users.push(legacy));
  const first = await f.complete('/spaces/first');
  assert.equal(f.auth.sessionInfo(first.cookie).user, null);
  f.store.transaction(state => {state.users[0].workosId = identity.id;});
  const second = await f.complete('/spaces/second');
  assert.equal(second.response.headers.Location, '/spaces/second');
  assert.equal(f.auth.sessionInfo(second.cookie).user.id, legacy.id);
});

test('JWT signature/issuer/client/sub/session failures cannot mint a browser session', async t => {
  const f = await fixture(t);
  for (const bad of [{iss: 'https://attacker.test'}, {iss: 'https://api.workos.com/user_management/client_other', client_id: undefined}, {client_id: 'client_other'}, {client_id: null}, {client_id: 123}, {sub: 'user_other'}, {sid: undefined}, {sub_profile: 'ai_agent'}, {exp: Math.floor(Date.now() / 1000) - 30}]) {
    f.issued.accessToken = await jwt(bad);
    const {cookie} = await f.begin();
    const response = await f.call('/auth/callback?code=authorized-code&state=random-server-state', cookie);
    assert.match(response.headers.Location, /^\/spaces\?authError=/);
    assert.equal(typeof response.headers['Set-Cookie'], 'string');
    assert.doesNotMatch(response.headers['Set-Cookie'], /lr_session/);
  }
  const otherKeys = await generateKeyPair('RS256');
  f.issued.accessToken = await new SignJWT({iss: 'https://api.workos.com', sub: identity.id, sid: 'session_alice', client_id: clientId, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300}).setProtectedHeader({alg: 'RS256', kid: publicKey.kid}).sign(otherKeys.privateKey);
  const {cookie} = await f.begin();
  const response = await f.call('/auth/callback?code=authorized-code&state=random-server-state', cookie);
  assert.equal(response.headers.Location, '/spaces?authError=failed');
});

test('native AuthKit issuer without client_id signs in and refreshes the same builder session', async t => {
  const f = await fixture(t);
  const nativeClaims = {iss: 'https://api.workos.com/user_management/' + clientId, client_id: undefined};
  f.issued.accessToken = await jwt(nativeClaims);
  const first = await f.complete('/spaces/native');
  assert.equal(first.response.headers.Location, '/account/setup?returnTo=%2Fspaces%2Fnative');
  assert.equal(f.auth.sessionInfo(first.cookie).onboarding.email, identity.email);
  const onboarded = await f.auth.onboard(first.cookie, {mode: 'create', name: 'native-builder'});
  const cookie = onboarded.headers['Set-Cookie'].split(';')[0];
  const opaque = authCookie(cookie), record = f.store.sessions.get(opaque);
  record.workos.accessToken = await jwt({...nativeClaims, exp: Math.floor(Date.now() / 1000) - 1});
  record.workos.expiresAt = Date.now() - 1000;
  f.store.sessions.set(opaque, record);
  let refreshes = 0;
  const refreshedToken = await jwt(nativeClaims);
  globalThis.__workosMock.authenticateWithRefreshToken = async ({refreshToken}) => {
    refreshes++;
    assert.equal(refreshToken, 'refresh-original');
    return {...f.issued, accessToken: refreshedToken, refreshToken: 'native-refresh-rotated'};
  };
  await f.auth.prepare(cookie);
  assert.equal(refreshes, 1);
  assert.deepEqual(f.auth.sessionInfo(cookie).user, onboarded.body.user);
  assert.equal(f.store.sessions.get(opaque).workos.accessToken, refreshedToken);
  assert.equal(f.store.sessions.get(opaque).workos.refreshToken, 'native-refresh-rotated');
  assert.ok(f.store.sessions.get(opaque).workos.expiresAt > Date.now());
});

test('native AuthKit issuer still rejects an explicitly different client on refresh', async t => {
  const f = await fixture(t);
  const {cookie, opaque} = await f.session({expired: true});
  globalThis.__workosMock.authenticateWithRefreshToken = async () => ({...f.issued, accessToken: await jwt({iss: 'https://api.workos.com/user_management/' + clientId, client_id: 'client_other'}), refreshToken: 'bad-refresh'});
  await f.auth.prepare(cookie);
  assert.equal(f.store.sessions.get(opaque), undefined);
  assert.equal(f.auth.sessionInfo(cookie).user, null);
  assert.equal(f.auth.sessionInfo(cookie).csrf, undefined);
});

test('expired sessions refresh once across concurrent calls and replace both tokens before authorization', async t => {
  const f = await fixture(t);
  const {opaque, cookie} = await f.session({expired: true});
  assert.equal(f.auth.sessionInfo(cookie).csrf, undefined);
  await Promise.all([f.auth.prepare(cookie), f.auth.prepare(cookie), f.auth.prepare(cookie)]);
  assert.equal(f.counts().refreshes, 1);
  assert.equal(f.store.sessions.get(opaque).workos.refreshToken, 'refresh-rotated');
  assert.ok(f.auth.sessionInfo(cookie).csrf);
});

test('transient refresh failures retain encrypted session, while invalid_grant revokes it', async t => {
  const f = await fixture(t, {async authenticateWithRefreshToken() {throw failWith('server_error', 503);}});
  const {opaque, cookie} = await f.session({expired: true});
  await assert.rejects(() => f.auth.prepare(cookie), status(503));
  assert.ok(f.store.sessions.get(opaque));
  assert.equal(f.auth.sessionInfo(cookie).csrf, undefined);
  globalThis.__workosMock.authenticateWithRefreshToken = async () => {throw failWith('invalid_grant');};
  await f.auth.prepare(cookie);
  assert.equal(f.store.sessions.get(opaque), undefined);
});

test('a refresh completing after logout cannot resurrect the deleted session', async t => {
  let resolveRefresh;
  const delayed = new Promise(resolve => {resolveRefresh = resolve;});
  const f = await fixture(t, {async authenticateWithRefreshToken() {return delayed;}});
  const {opaque, cookie} = await f.session({expired: true});
  const preparing = f.auth.prepare(cookie);
  const logout = await f.auth.logout(cookie, origin);
  assert.equal(logout.body.ok, true);
  assert.match(logout.body.logoutUrl, /session_id=session_alice/);
  resolveRefresh({...f.issued, refreshToken: 'refresh-rotated'});
  await preparing;
  assert.equal(f.store.sessions.get(opaque), undefined);
});

test('legacy opaque sessions are retired when WorkOS authentication is enabled', async t => {
  const f = await fixture(t);
  const opaque = randomBytes(32).toString('hex');
  f.store.sessions.set(opaque, {user: 'legacy-builder', csrf: token(), expires: Date.now() + 10000});
  await f.auth.prepare('lr_session=' + opaque);
  assert.equal(f.store.sessions.get(opaque), undefined);
  assert.equal(f.auth.sessionInfo('lr_session=' + opaque).user, null);
});

test('legacy password claims are limited across controller restarts and cannot mutate ownership on failure', async t => {
  const f = await fixture(t);
  const legacy = newUser('Existing builder', 'legacy-password');
  f.store.transaction(state => state.users.push(legacy));
  const {cookie} = await f.complete();
  for (let attempt = 0; attempt < 5; attempt++) {
    await assert.rejects(() => f.auth.onboard(cookie, {mode: 'claim', name: 'Existing builder', password: 'wrong-password'}), status(401));
  }
  const restarted = new AuthKitAuth(env, f.store);
  await assert.rejects(() => restarted.onboard(cookie, {mode: 'claim', name: 'Existing builder', password: 'legacy-password'}), status(429));
  await assert.rejects(() => restarted.onboard(cookie, {mode: 'claim', name: 'A different builder', password: 'guess-password'}), status(429));
  assert.equal(f.store.read().users[0].workosId, undefined);
  assert.equal(f.store.read().users[0].id, legacy.id);
});
