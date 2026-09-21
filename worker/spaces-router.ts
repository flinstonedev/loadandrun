import {fail, identifier, objectName} from './spaces-common';
import type {ApiResult} from './spaces-types';

function json(result: ApiResult): Response {
  return Response.json(result.body, {status: result.status, headers: {'Cache-Control': 'private, no-store'}});
}

export function isSpacesAPI(path: string): boolean {
  return /^\/api\/(?:spaces|space-invitations|agent)(?:\/|$)/.test(path);
}

// All identity headers supplied to a DO are constructed here, never forwarded
// from the client. The app session and deployment Access token are independent.
export async function routeSpaces(request: Request, env: Env, rawBody: string, accessExpiresAt: number): Promise<Response> {
  if (env.SPACES_ENABLED !== 'true') fail('Not found.', 404);
  const url = new URL(request.url);
  let body: Record<string, unknown> = Object.fromEntries(url.searchParams);
  if (request.method === 'POST') {
    if (!String(request.headers.get('content-type')).startsWith('application/json')) fail('JSON content required.', 415);
    let parsed: unknown;
    try {parsed = JSON.parse(rawBody || '{}');} catch {fail('Could not read request.');}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('A JSON object is required.');
    body = {...body, ...parsed};
  }
  const workspace = env.WORKSPACES.getByName(env.WORKSPACE_ID);
  const path = url.pathname;
  if (/^\/api\/agent\/(?:pair(?:\/|$)|pairing$|connect$|disconnect$)/.test(path)) {
    return json({status: 410, body: {error: 'Local agent connections have been retired. Use hosted AI in your space.'}});
  }

  const auth = await workspace.authenticate({method: request.method, cookie: request.headers.get('cookie') || '',
    csrf: request.headers.get('x-csrf-token') || '', origin: request.headers.get('origin'), expectedOrigin: url.origin});
  if (!auth.ok) return json({status: auth.status, body: {error: auth.error}});
  const actor = {...auth.actor, sessionExpiresAt: Math.min(auth.actor.sessionExpiresAt || 0, accessExpiresAt)};
  const directory = env.SPACE_DIRECTORIES.getByName(objectName(env.WORKSPACE_ID, actor.id));
  await directory.initialize(actor.id);
  if (path === '/api/spaces') return json(await directory.dispatch(actor, request.method, 'spaces', body));
  if (path === '/api/space-invitations' || path.startsWith('/api/space-invitations/')) {
    return json(await directory.dispatch(actor, request.method, 'invitations' + path.slice('/api/space-invitations'.length), body));
  }
  if (path === '/api/agent' || path.startsWith('/api/agent/')) {
    return json(await directory.dispatch(actor, request.method, path.slice('/api/agent/'.length) || 'status', body));
  }
  const match = path.match(/^\/api\/spaces\/([^/]+)(?:\/(.*))?$/);
  if (!match) fail('Not found.', 404);
  const id = identifier(match[1], 'Space');
  const action = match[2] || '';
  const space = env.SPACES.getByName(objectName(env.WORKSPACE_ID, id));
  if (action === 'events') {
    if (request.method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') fail('A WebSocket connection is required.', 426);
    if (request.headers.get('origin') !== url.origin) fail('Request origin was not accepted.', 403);
    return space.fetch(new Request(request.url, {headers: {Upgrade: 'websocket', 'x-lr-actor': JSON.stringify(actor)}}));
  }
  return json(await space.dispatch(actor, request.method, action, body));
}
