import {WorkOS} from '@workos-inc/node/worker';
import {createRemoteJWKSet, jwtVerify, errors} from 'jose';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {resolveWorkOSBuilder, onboardWorkOSBuilder} from '../server/workos-identity.mjs';
import type {openSQLiteStore} from '../server/sqlite-store.mjs';

type Store = ReturnType<typeof openSQLiteStore>;
type Identity = {id: string; email: string; emailVerified: boolean; firstName?: string | null; lastName?: string | null};
type Tokens = {identity: Identity; accessToken: string; refreshToken: string; sessionId: string; expiresAt: number};
type Session = {kind: 'workos'; user?: string; csrf: string; expires: number; returnTo: string; workos: Tokens};
type OAuthAttempt = {kind: 'workos-oauth'; state: string; codeVerifier: string; origin: string; returnTo: string; expires: number};
export type AuthHeaders = Record<string, string | string[]>;
type AuthInput = {url: string; method: string; headers: Record<string, string>; body: string};
const SESSION_AGE = 7 * 86400_000;
const OAUTH_AGE = 10 * 60_000;
const randomToken = () => randomBytes(32).toString('base64url');
function reject(message: string, status = 401, code?: string): never {throw Object.assign(new Error(message), {status, ...(code ? {code} : {})});}

export function authCookie(header: string, name = 'lr_session'): string {
  const values = header.split(';').map(part => part.trim()).filter(part => part.startsWith(name + '='));
  if (values.length !== 1) return '';
  const value = values[0].slice(name.length + 1);
  // Accept legacy 64-hex cookies as well so prepare() can retire them.
  return /^(?:[A-Za-z0-9_-]{43}|[a-f0-9]{64})$/.test(value) ? value : '';
}

export function safeReturnTo(value: string | null | undefined): string {
  if (!value || value.length > 2048 || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return '/spaces';
  try {
    const url = new URL(value, 'https://load-and-run.invalid');
    if (url.origin !== 'https://load-and-run.invalid' || /^\/(?:auth(?:\/|$)|api(?:\/|$)|account\/setup(?:\/|$))/.test(url.pathname)) return '/spaces';
    return url.pathname + url.search + url.hash;
  } catch {return '/spaces';}
}

function equalSecret(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function providerFailure(error: unknown): never {
  const detail = error as {error?: string; code?: string; status?: number; cause?: unknown};
  if (['invalid_grant', 'mfa_enrollment', 'sso_required'].includes(detail?.error || detail?.code || '')) reject('Your sign-in expired. Sign in again.');
  if (detail?.status === 400 || detail?.status === 401 || detail?.status === 403 || detail?.status === 422) reject('WorkOS could not complete this sign-in. Try signing in again.');
  reject('WorkOS is temporarily unavailable. Try again shortly.', 503);
}

/** One instance belongs to the community DO; only public JWKS and in-flight
 * coordination live in memory. Credentials remain in the encrypted store. */
export class AuthKitAuth {
  readonly enabled: boolean;
  private client?: WorkOS;
  private keys?: ReturnType<typeof createRemoteJWKSet>;
  private readonly preparing = new Map<string, Promise<void>>();

  // API key is an optional managed secret; the generated Env covers configured bindings.
  constructor(private readonly env: Env & {WORKOS_API_KEY?: string}, private readonly store: Store) {
    this.enabled = env.AUTH_PROVIDER === 'workos';
  }

  private sdk(): WorkOS {
    if (!this.enabled || !/^client_[A-Za-z0-9]+$/.test(this.env.WORKOS_CLIENT_ID || '')) reject('WorkOS sign-in is not configured.', 503);
    this.client ??= new WorkOS({clientId: this.env.WORKOS_CLIENT_ID, apiKey: this.env.WORKOS_API_KEY || undefined, timeout: 10_000, maxRetries: 0});
    return this.client;
  }

  private origin(value: string): string {
    let url: URL;
    try {url = new URL(value);} catch {return reject('This sign-in origin is not allowed.', 400);}
    const allowed = (this.env.WORKOS_ALLOWED_ORIGINS || '').split(',').map(origin => origin.trim()).filter(Boolean);
    if (!allowed.includes(url.origin) || (url.protocol !== 'https:' && !(this.env.ENVIRONMENT === 'local' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) reject('This sign-in origin is not allowed.', 400);
    return url.origin;
  }

  private cookie(name: string, token: string, age: number): string {
    return `${name}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.max(0, Math.floor(age / 1000))}${this.env.ENVIRONMENT !== 'local' ? '; Secure' : ''}`;
  }

  private session(token: string): Session | undefined {
    const record = this.store.sessions.get(token) as Session | undefined;
    return record?.kind === 'workos' && record.expires > Date.now() && record.workos?.identity?.id ? record : undefined;
  }

  private async verify(accessToken: string, identity: Identity, sessionId?: string): Promise<{sessionId: string; expiresAt: number}> {
    this.sdk();
    this.keys ??= createRemoteJWKSet(new URL(`https://api.workos.com/sso/jwks/${this.env.WORKOS_CLIENT_ID}`), {timeoutDuration: 5000, cooldownDuration: 30_000});
    const issuers = [`https://api.workos.com/user_management/${this.env.WORKOS_CLIENT_ID}`, 'https://api.workos.com', 'https://api.workos.com/'];
    if (this.env.WORKOS_ISSUER) issuers.push(this.env.WORKOS_ISSUER);
    const {payload} = await jwtVerify(accessToken, this.keys, {algorithms: ['RS256'], issuer: issuers, requiredClaims: ['iss', 'sub', 'sid', 'exp', 'iat']});
    if (payload.sub !== identity.id || typeof payload.sid !== 'string' || !payload.sid || (sessionId && payload.sid !== sessionId) || (payload.sub_profile && payload.sub_profile !== 'user')) reject('WorkOS returned an invalid session. Sign in again.', 401, 'WORKOS_SESSION_CLAIMS');
    // Native AuthKit sessions bind their client in the issuer and client-scoped
    // signing keys. Connect-style tokens additionally carry client_id.
    if (payload.client_id !== undefined && payload.client_id !== this.env.WORKOS_CLIENT_ID) reject('WorkOS returned an invalid session. Sign in again.', 401, 'WORKOS_CLIENT_CLAIM_MISMATCH');
    return {sessionId: payload.sid, expiresAt: payload.exp! * 1000};
  }

  async prepare(cookie: string): Promise<void> {
    if (!this.enabled) return;
    const token = authCookie(cookie);
    if (!token) return;
    const existing = this.preparing.get(token);
    if (existing) return existing;
    const pending = this.prepareToken(token);
    this.preparing.set(token, pending);
    try {await pending;} finally {if (this.preparing.get(token) === pending) this.preparing.delete(token);}
  }

  private async prepareToken(token: string): Promise<void> {
    const session = this.session(token);
    if (!session) {this.store.sessions.delete(token); return;}
    let workos = session.workos;
    try {
      const validated = await this.verify(workos.accessToken, workos.identity, workos.sessionId);
      workos = {...workos, ...validated};
    } catch (error) {
      if (error instanceof errors.JWTExpired) {
        try {
          const next = await this.sdk().userManagement.authenticateWithRefreshToken({refreshToken: workos.refreshToken});
          if (!next.refreshToken || next.user.id !== workos.identity.id) reject('WorkOS returned an invalid session. Sign in again.');
          const validated = await this.verify(next.accessToken, next.user, workos.sessionId);
          workos = {identity: next.user, accessToken: next.accessToken, refreshToken: next.refreshToken, ...validated};
        } catch (refreshError) {
          const detail = refreshError as {status?: number; error?: string; code?: string};
          if (detail?.status === 401 || detail?.status === 400 || detail?.status === 403 || detail?.status === 422 || (refreshError instanceof errors.JOSEError && !(refreshError instanceof errors.JWKSTimeout)) || ['invalid_grant', 'mfa_enrollment', 'sso_required'].includes(detail?.error || detail?.code || '')) {
            this.store.sessions.delete(token);
            return;
          }
          providerFailure(refreshError);
        }
      } else if ((error instanceof errors.JOSEError && !(error instanceof errors.JWKSTimeout)) || (error as {status?: number})?.status === 401) {
        this.store.sessions.delete(token);
        return;
      } else providerFailure(error);
    }
    // Logout or onboarding may have removed/replaced this session while WorkOS
    // was responding. Never recreate it or overwrite a newer refresh result.
    const current = this.session(token);
    if (!current || current.workos.refreshToken !== session.workos.refreshToken || current.csrf !== session.csrf) return;
    const user = resolveWorkOSBuilder(this.store, workos.identity);
    this.store.sessions.set(token, {...current, user: user?.id, workos});
  }

  sessionInfo(cookie: string) {
    const session = this.session(authCookie(cookie));
    const valid = session && session.workos.expiresAt > Date.now();
    const state = this.store.read() as {version: number; users: Array<{id: string; name: string; workosId?: string}>};
    const account = valid && session.user ? state.users.find(user => user.id === session.user && user.workosId === session.workos.identity.id) : undefined;
    const identity = valid ? session.workos.identity : undefined;
    return {
      user: account ? {id: account.id, name: account.name} : null,
      ...(identity && !account ? {onboarding: {email: identity.email, suggestedName: [identity.firstName, identity.lastName].filter(Boolean).join(' ').slice(0, 80)}} : {}),
      ...(valid ? {csrf: session.csrf} : {}),
      authProvider: 'workos' as const, loginUrl: '/auth/login', signupUrl: '/auth/signup',
      ...(this.env.WORKOS_ENVIRONMENT ? {authEnvironment: this.env.WORKOS_ENVIRONMENT} : {}),
    };
  }

  async handle(input: AuthInput): Promise<{status: number; body: string; headers: AuthHeaders}> {
    if (!this.enabled) reject('Not found.', 404);
    const url = new URL(input.url);
    if (input.method !== 'GET') reject('Method not allowed.', 405);
    const origin = this.origin(url.origin);
    const headers: AuthHeaders = {'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'};
    if (url.pathname === '/auth/login' || url.pathname === '/auth/signup') {
      const {url: authorizationUrl, state, codeVerifier} = await this.sdk().userManagement.getAuthorizationUrlWithPKCE({provider: 'authkit', redirectUri: origin + '/auth/callback', screenHint: url.pathname === '/auth/signup' ? 'sign-up' : 'sign-in'});
      const prior = authCookie(input.headers.cookie || '', 'lr_oauth');
      if (prior) this.store.sessions.delete(prior);
      const binding = randomToken();
      const attempt: OAuthAttempt = {kind: 'workos-oauth', state, codeVerifier, origin, returnTo: safeReturnTo(url.searchParams.get('returnTo')), expires: Date.now() + OAUTH_AGE};
      this.store.sessions.set(binding, attempt);
      headers['Set-Cookie'] = this.cookie('lr_oauth', binding, OAUTH_AGE);
      headers.Location = authorizationUrl;
      return {status: 302, body: '', headers};
    }
    if (url.pathname !== '/auth/callback') reject('Not found.', 404);
    const binding = authCookie(input.headers.cookie || '', 'lr_oauth');
    const attempt = this.store.sessions.get(binding) as OAuthAttempt | undefined;
    const state = url.searchParams.get('state') || '';
    if (!binding || !attempt || attempt.kind !== 'workos-oauth' || attempt.expires <= Date.now() || attempt.origin !== origin || !equalSecret(state, attempt.state)) reject('This sign-in request expired or does not match this browser. Start sign-in again.', 400);
    // Consume before network I/O, including denied/error callbacks.
    this.store.sessions.delete(binding);
    headers['Set-Cookie'] = this.cookie('lr_oauth', '', 0);
    if (url.searchParams.has('error')) {
      headers.Location = '/spaces?authError=cancelled';
      return {status: 302, body: '', headers};
    }
    const code = url.searchParams.get('code');
    if (!code || code.length > 4096 || url.searchParams.getAll('code').length !== 1 || url.searchParams.getAll('state').length !== 1) reject('WorkOS did not return a valid sign-in code.', 400);
    let stage = 'code_exchange';
    try {
      const result = await this.sdk().userManagement.authenticateWithCode({code, codeVerifier: attempt.codeVerifier});
      if (!result.refreshToken) reject('WorkOS did not return a session. Try signing in again.');
      stage = 'jwt_verification';
      const validated = await this.verify(result.accessToken, result.user);
      stage = 'builder_link';
      const user = resolveWorkOSBuilder(this.store, result.user);
      const token = randomToken();
      const record: Session = {kind: 'workos', user: user?.id, csrf: randomToken(), expires: Date.now() + SESSION_AGE, returnTo: attempt.returnTo,
        workos: {identity: result.user, accessToken: result.accessToken, refreshToken: result.refreshToken, ...validated}};
      this.store.sessions.set(token, record);
      this.store.sessions.delete(authCookie(input.headers.cookie || ''));
      headers['Set-Cookie'] = [this.cookie('lr_oauth', '', 0), this.cookie('lr_session', token, SESSION_AGE)];
      headers.Location = user ? attempt.returnTo : '/account/setup?returnTo=' + encodeURIComponent(attempt.returnTo);
      return {status: 302, body: '', headers};
    } catch (error) {
      const status = (error as {status?: number})?.status;
      const details = error as {code?: string; claim?: string; payload?: {iss?: unknown}};
      let observedIssuer: string | undefined;
      if (details.claim === 'iss' && typeof details.payload?.iss === 'string') {
        try {const issuer = new URL(details.payload.iss); observedIssuer = issuer.origin + issuer.pathname;} catch {observedIssuer = 'invalid-uri';}
      }
      console.warn(JSON.stringify({event: 'workos_callback_failed', stage,
        errorName: error instanceof Error ? error.name : 'UnknownError', status,
        code: typeof details.code === 'string' ? details.code.slice(0, 80) : undefined,
        claim: typeof details.claim === 'string' ? details.claim.slice(0, 30) : undefined, observedIssuer}));
      const transient = status === 408 || status === 429 || (status !== undefined && status >= 500) || (error instanceof errors.JWKSTimeout) || (!(error instanceof errors.JOSEError) && !status);
      headers.Location = '/spaces?authError=' + (transient ? 'unavailable' : 'failed');
      return {status: 302, body: '', headers};
    }
  }

  async onboard(cookie: string, input: unknown): Promise<{body: {user: {id: string; name: string}; returnTo: string}; headers: AuthHeaders}> {
    await this.prepare(cookie);
    const token = authCookie(cookie), session = this.session(token);
    if (!session || session.workos.expiresAt <= Date.now()) reject('Sign in before setting up your builder account.');
    if ((input as {mode?: string})?.mode === 'claim') {
      const name = (input as {name?: unknown}).name;
      const identityKey = 'workos-claim:' + session.workos.identity.id;
      const nameKey = 'legacy-claim:' + (typeof name === 'string' ? name.trim().toLowerCase().slice(0, 80) : '');
      const identityAllowed = this.store.authAttempts.take(identityKey);
      const nameAllowed = this.store.authAttempts.take(nameKey);
      if (!identityAllowed || !nameAllowed) reject('Too many connection attempts. Try again in 15 minutes.', 429);
    }
    const user = onboardWorkOSBuilder(this.store, session.workos.identity, input);
    const rotated = randomToken();
    this.store.sessions.set(rotated, {...session, user: user.id, csrf: randomToken()});
    this.store.sessions.delete(token);
    return {body: {user, returnTo: safeReturnTo(session.returnTo)}, headers: {'Set-Cookie': this.cookie('lr_session', rotated, session.expires - Date.now()), 'Cache-Control': 'no-store'}};
  }

  async logout(cookie: string, requestedOrigin: string): Promise<{body: {ok: true; logoutUrl?: string}; headers: AuthHeaders}> {
    const origin = this.origin(requestedOrigin);
    const token = authCookie(cookie), session = this.session(token);
    const logoutUrl = session ? this.sdk().userManagement.getLogoutUrl({sessionId: session.workos.sessionId, returnTo: origin + '/spaces'}) : undefined;
    this.store.sessions.delete(token);
    return {body: {ok: true, ...(logoutUrl ? {logoutUrl} : {})}, headers: {'Set-Cookie': this.cookie('lr_session', '', 0), 'Cache-Control': 'no-store'}};
  }
}
