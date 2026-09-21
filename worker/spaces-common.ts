import type {Actor, ApiResult} from './spaces-types';

export function objectName(workspace: string, id: string): string {
  return `${workspace}:${id}`;
}

export function fail(message: string, status = 400): never {
  throw Object.assign(new Error(message), {status});
}

export function errorResult(error: unknown): ApiResult {
  const status = error instanceof Error && 'status' in error && typeof error.status === 'number' ? error.status : 500;
  return {status, body: {error: status === 500 ? 'The request could not be completed. Try again.' : (error as Error).message}};
}

export function ok(body: unknown, status = 200): ApiResult {return {status, body};}

export class SqlState {
  constructor(private storage: DurableObjectStorage) {
    storage.sql.exec('CREATE TABLE IF NOT EXISTS space_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }
  get<T>(key: string): T | undefined {
    const row = this.storage.sql.exec<{value: string}>('SELECT value FROM space_state WHERE key = ?', key).toArray()[0];
    return row ? JSON.parse(row.value) as T : undefined;
  }
  set(key: string, value: unknown): void {
    this.storage.sql.exec('INSERT INTO space_state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value));
  }
  delete(key: string): void {this.storage.sql.exec('DELETE FROM space_state WHERE key = ?', key);}
  list<T>(prefix = ''): {key: string; value: T}[] {
    return this.storage.sql.exec<{key: string; value: string}>('SELECT key,value FROM space_state ORDER BY key').toArray().filter(row => row.key.startsWith(prefix)).map(row => ({key: row.key, value: JSON.parse(row.value) as T}));
  }
  transaction<T>(fn: () => T): T {return this.storage.transactionSync(fn);}
}

export async function actorSessionActive(env: Env, actor: Actor): Promise<boolean> {
  if (!actor.sessionExpiresAt || actor.sessionExpiresAt <= Date.now() || !actor.sessionId) return false;
  return env.WORKSPACES.getByName(env.WORKSPACE_ID).connectionActive(actor.sessionId);
}

export function identifier(value: unknown, label = 'Identifier'): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) fail(`${label} is invalid.`);
  return value;
}
