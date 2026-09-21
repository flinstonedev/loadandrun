import {fail} from './model.mjs';
import {handleCommunity} from './community.mjs';

// Shared session resolution for the community API and authenticated DO routing.
// Cloudflare Access is intentionally absent: it gates the deployment, not accounts.
export function resolveAppSession(store, sessions, cookie = '') {
  const matches = [...cookie.matchAll(/(?:^|;\s*)lr_session=([^;]+)/g)];
  const token = matches.length === 1 ? matches[0][1] : undefined;
  let session = sessions.get(token);
  if (session && session.expires <= Date.now()) {sessions.delete(token); session = undefined;}
  const state = store.read();
  const user = session && state.users.find(account => account.id === session.user);
  return {token, session, state, user};
}

export function requireAppSession(store, sessions, input) {
  const {token, session, user} = resolveAppSession(store, sessions, input.cookie || '');
  if (!session || !user) fail('Sign in to your builder account.', 401);
  if (session.kind !== 'workos' || !(session.workos?.expiresAt > Date.now())) fail('Continue through WorkOS to sign in.', 401);
  if (input.method !== 'GET') {
    if (input.method !== 'POST') fail('Method not allowed.', 405);
    if (input.origin !== input.expectedOrigin) fail('Request origin was not accepted.', 403);
    if (input.csrf !== session.csrf) fail('Sign in again before saving.', 401);
  }
  return {token, session, user};
}

export function createAPI(store, options = {}) {
  const sessions = options.sessions || new Map();
  return async function api(req, res) {
    const endpoint = new URL(req.url, 'http://local').pathname.slice(5);
    const method = req.method;
    const isCommunity = endpoint === 'community' || endpoint.startsWith('community/');
    if (['register', 'login'].includes(endpoint)) fail('Continue through WorkOS to sign in or create an account.', 410);
    if (!isCommunity && !['session', 'logout', 'auth/onboard'].includes(endpoint)) fail('Not found.', 404);
    if (!options.auth?.enabled) fail('WorkOS sign-in is not configured.', 503);
    const current = resolveAppSession(store, sessions, req.headers.cookie || '');
    const session = current.session?.kind !== 'workos' || (endpoint !== 'logout' && !(current.session?.workos?.expiresAt > Date.now())) ? undefined : current.session;
    const user = session ? current.user : undefined;
    let body = {};
    if (method !== 'GET') {
      if (method !== 'POST') fail('Method not allowed.', 405);
      const expectedOrigin = options.cloud ? req.origin : `http://${req.headers.host}`;
      if (req.headers.origin !== expectedOrigin) fail('Request origin was not accepted.', 403);
      if (!String(req.headers['content-type']).startsWith('application/json')) fail('JSON content required.', 415);
      let raw = '';
      for await (const chunk of req) {raw += chunk; if (raw.length > 2000000) fail('Request is too large.', 413);}
      try {body = JSON.parse(raw || '{}');} catch {fail('Could not read request.');}
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail('A JSON object is required.');
      const pendingAction = session?.kind === 'workos' && ['auth/onboard', 'logout'].includes(endpoint);
      if ((!user && !pendingAction) || !session || req.headers['x-csrf-token'] !== session.csrf) fail('Sign in again before saving.', 401);
    }
    const send = (value, status = 200) => {res.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}); res.end(JSON.stringify(value));};
    if (isCommunity) {
      const result = await handleCommunity({endpoint, method, body, store, user, catalogAddresses: options.catalogAddresses});
      if (result) return send(result.body, result.status || 200);
    }
    if (endpoint === 'session' && method === 'GET') return send({...options.auth.sessionInfo(req.headers.cookie || ''), ...(options.features ? {features: options.features} : {})});
    if (endpoint === 'auth/onboard' && method === 'POST') {
      const result = await options.auth.onboard(req.headers.cookie || '', body);
      for (const [key, value] of Object.entries(result.headers)) res.setHeader(key, value);
      return send({...result.body, authProvider: 'workos'});
    }
    if (endpoint === 'logout' && method === 'POST') {
      const result = await options.auth.logout(req.headers.cookie || '', options.cloud ? req.origin : `http://${req.headers.host}`);
      for (const [key, value] of Object.entries(result.headers)) res.setHeader(key, value);
      return send(result.body);
    }
    fail('Not found.', 404);
  };
}
