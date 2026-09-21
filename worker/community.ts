import {DurableObject} from 'cloudflare:workers';
import {createAPI, requireAppSession} from '../server/api.mjs';
import {createHash} from 'node:crypto';
import type {Actor} from './spaces-types';
import {AuthKitAuth} from './authkit';
import type {AppRequest, AppResponse} from './http';
import {openSQLiteStore} from '../server/sqlite-store.mjs';
import seed from '../src/data.json';
// Preserve the registered class name so existing community state keeps its identity.
export class Workspace extends DurableObject<Env> {
  private store: ReturnType<typeof openSQLiteStore>;
  private api: ReturnType<typeof createAPI>;
  private auth: AuthKitAuth;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = openSQLiteStore(ctx.storage);
    this.auth = new AuthKitAuth(env, this.store);
    this.api = createAPI(this.store, {cloud: true, catalogAddresses: seed.blueprints.map(b=>b.addr), secureCookies: env.ENVIRONMENT !== 'local', sessions: this.store.sessions, features: {spaces: env.SPACES_ENABLED === 'true'}, auth: this.auth});
  }

  async authenticate(input: {method: string; cookie: string; csrf: string; origin: string | null; expectedOrigin: string}): Promise<{ok: true; actor: Actor} | {ok: false; status: number; error: string}> {
    try {
      if (!this.auth.enabled) throw Object.assign(new Error('WorkOS sign-in is not configured.'), {status: 503});
      await this.auth.prepare(input.cookie);
      const {token, session, user} = requireAppSession(this.store, this.store.sessions, input);
      return {ok: true, actor: {id: user.id, name: user.name, sessionExpiresAt: session.expires,
        sessionId: createHash('sha256').update('lookup:' + token).digest('hex')}};
    } catch (error) {
      const known = error instanceof Error && 'status' in error && typeof error.status === 'number';
      return {ok: false, status: known ? error.status as number : 500,
        error: known ? error.message : 'The account could not be checked. Try again.'};
    }
  }

  connectionActive(sessionId: string): boolean {
    if (!/^[a-f0-9]{64}$/.test(sessionId)) return false;
    return this.auth.enabled && this.ctx.storage.sql.exec("SELECT id FROM sessions WHERE id = ? AND expires > ? AND auth_provider = 'workos' AND authorization_expires > ?", sessionId, Date.now(), Date.now()).toArray().length === 1;
  }

  findBuilder(name: string): {id: string; name: string} | null {
    if (typeof name !== 'string' || name.length > 80) return null;
    const accounts = this.ctx.storage.sql.exec<{data: string}>("SELECT data FROM records WHERE collection = 'users'").toArray()
      .map(row => JSON.parse(row.data) as {id: string; name: string; hash?: string; workosId?: string});
    const user = accounts.find(account => (account.hash || account.workosId) && account.name.toLowerCase() === name.trim().toLowerCase());
    return user ? {id: user.id, name: user.name} : null;
  }

  // Only app transport data crosses this RPC boundary; no Access claims or headers.
  async handle(input: AppRequest): Promise<AppResponse> {
    const req = {
      url: input.url, method: input.method, headers: input.headers, origin: new URL(input.url).origin,
      async *[Symbol.asyncIterator]() {if (input.body) yield input.body;},
    };
    let status = 200;
    let body = '';
    const headers: Record<string, string | string[]> = {};
    const res = {
      setHeader(key: string, value: string | string[]) {headers[key] = value;},
      writeHead(code: number, values: Record<string, string>) {status = code; Object.assign(headers, values);},
      end(value: string) {body = value;},
    };
    try {
      // Local logout must remain available during a WorkOS outage. The API
      // still checks the encrypted session's CSRF token and request origin.
      if (this.auth.enabled && !(input.method === 'POST' && new URL(input.url).pathname === '/api/logout')) await this.auth.prepare(input.headers.cookie || '');
      await this.api(req, res);
    } catch (error) {
      const known = error instanceof Error && 'status' in error && typeof error.status === 'number';
      status = known ? error.status as number : 500;
      body = JSON.stringify({error: known ? error.message : 'The community could not complete this request.'});
      if (!known) console.error(JSON.stringify({event: 'community_error', message: String(error)}));
    }
    return {status, body, headers};
  }

  async authHandle(input: AppRequest): Promise<AppResponse> {
    try {return await this.auth.handle(input);}
    catch (error) {
      const known = error instanceof Error && 'status' in error && typeof error.status === 'number';
      return {status: known ? error.status as number : 500,
        body: JSON.stringify({error: known ? error.message : 'Sign-in could not be completed. Try again.'}),
        headers: {'Cache-Control': 'private, no-store'}};
    }
  }
}
