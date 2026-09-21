import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {generateKeyPair, exportJWK, SignJWT} from 'jose';

// Tests exercise the real OAuth, session, and onboarding code. Only the external
// WorkOS service is replaced; no fixture login route is shipped with the app.
export async function workosFixture(origin = 'https://app.example') {
  const clientId = 'client_integrationfixture';
  const issuer = `https://api.workos.com/user_management/${clientId}`;
  const pair = await generateKeyPair('RS256', {extractable: true});
  const jwk = {...await exportJWK(pair.publicKey), kid: 'fixture-workos', alg: 'RS256', use: 'sig'};
  const codes = new Map(), refreshTokens = new Map();
  async function tokens(name) {
    const identity = 'user_' + createHash('sha256').update(name.toLowerCase()).digest('hex').slice(0, 24);
    const accessToken = await new SignJWT({sid: 'session_' + identity}).setProtectedHeader({alg: 'RS256', kid: jwk.kid})
      .setSubject(identity).setIssuer(issuer).setIssuedAt().setExpirationTime('1h').sign(pair.privateKey);
    const refreshToken = randomUUID();
    refreshTokens.set(refreshToken, name);
    return {user: {object: 'user', id: identity, email: `${identity}@example.com`, email_verified: true,
      first_name: name, last_name: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString()},
      access_token: accessToken, refresh_token: refreshToken, authentication_method: 'authkit'};
  }
  return {
    bindings: {AUTH_PROVIDER: 'workos', WORKOS_CLIENT_ID: clientId, WORKOS_ALLOWED_ORIGINS: origin},
    async outbound(request) {
      if (request.url === `https://api.workos.com/sso/jwks/${clientId}`) return Response.json({keys: [jwk]});
      if (request.url !== 'https://api.workos.com/user_management/authenticate') return null;
      const body = await request.json();
      assert.equal(body.client_id, clientId);
      if (body.grant_type === 'authorization_code') {
        const fixture = codes.get(body.code);
        assert.ok(fixture, 'Unknown or reused authorization code');
        codes.delete(body.code);
        assert.equal(createHash('sha256').update(body.code_verifier).digest('base64url'), fixture.challenge);
        return Response.json(await tokens(fixture.name));
      }
      assert.equal(body.grant_type, 'refresh_token');
      const name = refreshTokens.get(body.refresh_token);
      assert.ok(name, 'Unknown refresh token');
      refreshTokens.delete(body.refresh_token);
      return Response.json(await tokens(name));
    },
    async signIn(call, auth, name) {
      const start = await call(auth, 'auth/login');
      assert.equal(start.status, 302, JSON.stringify(start));
      const url = new URL(start.location), code = randomUUID();
      codes.set(code, {name, challenge: url.searchParams.get('code_challenge')});
      const callback = await call(auth, `auth/callback?${new URLSearchParams({code, state: url.searchParams.get('state')})}`);
      assert.equal(callback.status, 302, JSON.stringify(callback));
      let session = await call(auth, 'api/session');
      assert.equal(session.status, 200, JSON.stringify(session));
      if (!session.data.user) {
        const onboarded = await call(auth, 'api/auth/onboard', {mode: 'create', name});
        assert.equal(onboarded.status, 200, JSON.stringify(onboarded));
        session = await call(auth, 'api/session');
      }
      auth.user = session.data.user;
      return callback;
    },
  };
}

export function applyCookies(auth, response) {
  const values = response.headers.getSetCookie?.() || (response.headers.get('set-cookie') || '').split(/,(?=\s*[^;,]+=)/).filter(Boolean);
  if (auth) {
    const jar = Object.fromEntries((auth.cookie || '').split(';').map(value => value.trim()).filter(Boolean).map(value => {
      const index = value.indexOf('='); return [value.slice(0, index), value.slice(index + 1)];
    }));
    for (const cookie of values) {
      const entry = cookie.split(';')[0], index = entry.indexOf('='), key = entry.slice(0, index).trim();
      if (/\bmax-age=0\b/i.test(cookie)) delete jar[key]; else jar[key] = entry.slice(index + 1);
    }
    auth.cookie = Object.entries(jar).map(([key, value]) => `${key}=${value}`).join('; ');
  }
  return values;
}
