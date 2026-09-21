import test from 'node:test';
import assert from 'node:assert/strict';
import {appReturnTo, hostedAuthURL, authErrorMessage, workosLogoutURL, createAuthUI} from '../src/auth-ui.js';

test('hosted authentication preserves the local destination and drops prior auth errors', () => {
  const target = '/spaces/connect?code=pair-123&authError=failed#device';
  assert.equal(appReturnTo(target), '/spaces/connect?code=pair-123#device');
  const login = new URL(hostedAuthURL('login', target), 'https://loadandrun.test');
  assert.equal(login.pathname, '/auth/login');
  assert.equal(login.searchParams.get('returnTo'), '/spaces/connect?code=pair-123#device');
  assert.equal(new URL(hostedAuthURL('register', '/saved'), login).pathname, '/auth/signup');
});

test('auth destinations reject external URLs, control characters, and authentication loops', () => {
  for (const value of [undefined, null, '', 'https://other.example/', '//other.example', '/\\other.example', '/path\nheader', '/auth/login', '/auth/callback?code=used', '/api/logout', '/account/setup', '/spaces/../auth/login']) {
    assert.equal(appReturnTo(value), '/spaces', String(value));
  }
  assert.equal(appReturnTo('/ideas/authentication'), '/ideas/authentication');
});

test('logout navigation is limited to the WorkOS HTTPS API origin', () => {
  const valid = 'https://api.workos.com/user_management/sessions/logout?session_id=session_test';
  assert.equal(workosLogoutURL(valid), valid);
  for (const value of [undefined, '', '/spaces', 'http://api.workos.com/logout', 'https://api.workos.com.attacker.test/logout', 'https://api.workos.com@other.example/logout', 'https://user:password@api.workos.com/logout', 'https://api.workos.com:8443/logout', 'javascript:alert(1)']) {
    assert.equal(workosLogoutURL(value), null);
  }
});

test('authentication errors use local explanatory copy without echoing server or query text', () => {
  assert.match(authErrorMessage('cancelled'), /cancelled/);
  assert.match(authErrorMessage('invalid_state'), /expired/);
  assert.match(authErrorMessage('unavailable'), /temporarily unavailable/);
  assert.equal(authErrorMessage('<img src=x onerror=alert(1)>'), 'We couldn’t complete sign-in. Please try again.');
  assert.equal(authErrorMessage('__proto__'), 'We couldn’t complete sign-in. Please try again.');
});

test('pending identities resume local setup without starting another hosted login', async () => {
  const destinations = [];
  const auth = createAuthUI({
    getSession: () => ({authProvider: 'workos', user: null, onboarding: {email: 'builder@example.test'}}),
    api: () => {throw Error('Unexpected API request');},
    go: async value => {destinations.push(value);},
    navigate: () => {throw Error('Unexpected hosted login');},
  });
  await auth.start('register');
  assert.deepEqual(destinations, ['/account/setup']);
});
