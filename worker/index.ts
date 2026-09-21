import {enforceDeploymentGate} from './access';
import {isSpacesAPI, routeSpaces} from './spaces-router';
import {appResponse} from './http';
export {Workspace} from './community';
export {Space} from './space';
export {Widget} from './widget';
export {SpaceDirectory} from './space-directory';

const MAX_BODY = 2_000_000;
async function readBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let bytes = 0, text = '';
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_BODY) {
      await reader.cancel();
      throw Object.assign(new Error('Request is too large.'), {status: 413});
    }
    text += decoder.decode(value, {stream: true});
  }
  return text + decoder.decode();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const access = await enforceDeploymentGate(request, env);
      const url = new URL(request.url);
      if (/^\/workspace(?:\/|$)/.test(url.pathname) || ['/workspace.js', '/workspace.css', '/app.js'].includes(url.pathname)) return Response.json({error: 'Not found.'}, {status: 404, headers: {'Cache-Control':'no-store'}});
      if (env.SPACES_ENABLED !== 'true' && /^\/spaces(?:\/|$)/.test(url.pathname)) return Response.json({error: 'Not found.'}, {status: 404});
      if (url.pathname.startsWith('/auth/')) {
        return appResponse(await env.WORKSPACES.getByName(env.WORKSPACE_ID).authHandle({
          url: request.url, method: request.method,
          headers: {cookie: request.headers.get('cookie') || '', origin: request.headers.get('origin') || ''}, body: '',
        }));
      }
      let response: Response;
      if (url.pathname.startsWith('/api/')) {
        if (!['GET', 'POST'].includes(request.method)) return Response.json({error: 'Method not allowed.'}, {status: 405, headers: {Allow: 'GET, POST'}});
        const body = await readBody(request);
        if (isSpacesAPI(url.pathname)) {
          response = await routeSpaces(request, env, body, access.expiresAt);
          if (response.status === 101) return response;
          response.headers.set('X-Content-Type-Options', 'nosniff');
          response.headers.set('Referrer-Policy', 'same-origin');
          return response;
        }
        const appCookie = request.headers.get('cookie')?.split(';').map(part => part.trim()).filter(part => part.startsWith('lr_session=')).join('; ');
        const result = await env.WORKSPACES.getByName(env.WORKSPACE_ID).handle({
          url: request.url, method: request.method, headers: {...Object.fromEntries(['origin', 'content-type', 'x-csrf-token'].flatMap(name => {
            const value = request.headers.get(name);
            return value === null ? [] : [[name, value]];
          })), ...(appCookie ? {cookie: appCookie} : {})}, body,
        });
        response = appResponse(result);
      } else {
        response = await env.ASSETS.fetch(request);
        response = new Response(response.body, response);
      }
      response.headers.set('Cache-Control', 'private, no-store');
      response.headers.set('X-Content-Type-Options', 'nosniff');
      response.headers.set('Referrer-Policy', 'same-origin');
      return response;
    } catch (error) {
      const known = error instanceof Error && 'status' in error && typeof error.status === 'number';
      if (!known) console.error(JSON.stringify({event: 'worker_error', message: String(error)}));
      return Response.json({error: known ? error.message : 'The request could not be completed.'}, {
        status: known ? error.status as number : 500, headers: {'Cache-Control': 'no-store'},
      });
    }
  },
} satisfies ExportedHandler<Env>;
