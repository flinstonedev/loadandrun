import {createServer} from 'node:http';
import {readFile, readdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {extname, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {handleCommunity} from '../server/community.mjs';

const DEMO_BANNER = '<aside class="demo-banner" aria-label="Demo information"><strong>Offline community demo</strong><span>Fictional data · edits reset on restart · Spaces, sign-in and AI require the full Worker setup.</span></aside>';
const DEMO_CSS = '.demo-banner{padding:12px 24px;background:#17231b;color:#fff;font:14px/1.5 system-ui,sans-serif;display:flex;gap:16px;flex-wrap:wrap}.demo-banner strong{font-weight:700}';
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const fail = (message, status = 400) => {throw Object.assign(new Error(message), {status});};

/** Separate local showcase transport. Never imported into worker/. */
export async function createDemoServer({assets = resolve('dist')} = {}) {
  const catalog = JSON.parse(await readFile(join(assets, 'data.json'), 'utf8'));
  const files = new Set(await readdir(assets));
  const csrf = randomBytes(32).toString('base64url');
  const user = {id: 'demo-builder', name: 'Demo Builder'};
  let state = {version: 1, users: [user, {id: 'sample-builder', name: 'Sample Builder'}],
    groups: [], projects: [], posts: [], comments: [], reactions: [], bookmarks: [], ideaSubmissions: [], reports: []};
  const store = {
    read: () => structuredClone(state),
    transaction(callback) {
      const next = structuredClone(state), result = callback(next);
      if (JSON.stringify(next).length > 5_000_000) fail('This demo is full. Restart it to reset the fictional data.', 413);
      state = next;
      return structuredClone(result);
    },
  };
  const invoke = (endpoint, method = 'GET', body = {}) => handleCommunity({endpoint, method, body, store, user,
    catalogAddresses: catalog.blueprints.map(item => item.addr),
    fetchRepository: async () => fail('Repository lookups are disabled in the offline demo. Use the full Worker setup for verified GitHub links.', 503)});
  const group = (await invoke('community/groups', 'POST', {name: 'Sample notebook builders', description: 'A fictional group exploring connected notes.', topic: 'Knowledge & memory'})).body;
  const project = (await invoke('community/projects', 'POST', {title: 'A linked reading notebook', goal: 'Prototype a small notebook that keeps ideas connected.', groupId: group.id, ideaAddress: catalog.blueprints[0].addr})).body;
  await invoke('community/posts', 'POST', {projectId: project.id, content: 'Our fictional prototype can link two notes. Next we will test navigation with sample reading material.'});

  const server = createServer(async (request, response) => {
    const send = (status, value, type = 'application/json') => {
      response.writeHead(status, {'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP});
      response.end(type === 'application/json' ? JSON.stringify(value) : value);
    };
    try {
      const port = server.address()?.port;
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(request.headers.host)) fail('Open the demo using its loopback address.', 403);
      const origin = `http://${request.headers.host}`;
      const url = new URL(request.url, origin);
      if (url.origin !== origin) fail('Request origin was not accepted.', 403);
      if (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site'])) fail('Cross-site demo requests are not accepted.', 403);
      if (!['GET', 'POST'].includes(request.method)) fail('Method not allowed.', 405);
      if (url.pathname.startsWith('/api/')) {
        const endpoint = url.pathname.slice(5);
        let body = {};
        if (request.method === 'POST') {
          if (request.headers.origin !== origin || request.headers['x-csrf-token'] !== csrf) fail('Reload the demo before saving.', 403);
          if (!String(request.headers['content-type']).startsWith('application/json')) fail('JSON content required.', 415);
          let raw = '', bytes = 0;
          for await (const chunk of request) {bytes += chunk.length; if (bytes > 64_000) fail('The demo request is too large.', 413); raw += chunk;}
          try {body = JSON.parse(raw || '{}');} catch {fail('Could not read the request.');}
        }
        if (endpoint === 'session' && request.method === 'GET') return send(200, {user, csrf, demo: true, authProvider: 'demo', features: {spaces: false}});
        const result = await invoke(endpoint, request.method, body);
        if (!result) fail('This feature requires the full Worker setup.', 404);
        return send(result.status || 200, result.body);
      }
      if (request.method !== 'GET') fail('Method not allowed.', 405);
      if (url.pathname === '/demo.css') return send(200, DEMO_CSS, 'text/css');
      const filename = url.pathname.slice(1);
      if (files.has(filename) && filename !== 'index.html' && !filename.includes('/')) {
        const types = {'.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json'};
        const type = types[extname(filename)];
        if (!type) fail('Not found.', 404);
        const content = await readFile(join(assets, filename), 'utf8');
        return send(200, type === 'application/json' ? JSON.parse(content) : content, type);
      }
      if (!/^\/(?:index\.html|feed|ideas(?:\/[^/]+)?|groups(?:\/[^/]+)?|projects(?:\/[^/]+)?|posts(?:\/[^/]+)?|saved|about)?$/.test(url.pathname)) fail('Not found.', 404);
      const html = (await readFile(join(assets, 'index.html'), 'utf8'))
        .replace(/<link\b[^>]*href="https:\/\/fonts\.[^"]+"[^>]*>/g, '')
        .replace('</head>', '<link rel="stylesheet" href="/demo.css"></head>')
        .replace(/(<body\b[^>]*>)/, '$1' + DEMO_BANNER);
      return send(200, html, 'text/html');
    } catch (error) {
      send(error.status || 500, {error: error.status ? error.message : 'The demo could not complete that request.'});
    }
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = await createDemoServer();
  const port = Number(process.env.LOAD_AND_RUN_DEMO_PORT || 4173);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a demo port between 1024 and 65535.');
  server.listen(port, '127.0.0.1', () => console.log(`Offline community demo: http://127.0.0.1:${port} — fictional data; restart to reset.`));
}
