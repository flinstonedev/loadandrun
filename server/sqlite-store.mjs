import {createHash, randomBytes, createCipheriv, createDecipheriv} from 'node:crypto';

const collections = ['users', 'groups', 'projects', 'posts', 'comments', 'reactions', 'bookmarks', 'ideaSubmissions', 'reports'];

// One community is the coordination boundary for membership and participation.
export function openSQLiteStore(storage) {
  const sql = storage.sql;
  sql.exec('CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (collection, id))');
  sql.exec('CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL)');
  const sessionColumns = new Set(sql.exec('PRAGMA table_info(sessions)').toArray().map(row => row.name));
  if (!sessionColumns.has('auth_provider')) sql.exec("ALTER TABLE sessions ADD COLUMN auth_provider TEXT NOT NULL DEFAULT 'builder'");
  if (!sessionColumns.has('authorization_expires')) sql.exec('ALTER TABLE sessions ADD COLUMN authorization_expires INTEGER NOT NULL DEFAULT 0');
  sql.exec('CREATE TABLE IF NOT EXISTS auth_attempts (key TEXT PRIMARY KEY, started INTEGER NOT NULL, attempts INTEGER NOT NULL)');

  // Retire the document product in place without changing community IDs or data.
  if (!sql.exec("SELECT value FROM metadata WHERE key = 'remove-workspace-v1'").toArray().length) {
    storage.transactionSync(() => {
      sql.exec("DELETE FROM records WHERE collection IN ('docs', 'journals', 'mail', 'lines')");
      sql.exec('DROP TABLE IF EXISTS presence');
      sql.exec("DELETE FROM metadata WHERE key IN ('seeded', 'catalog-copy-v2', 'catalog-rights-v1')");
      for (const row of sql.exec("SELECT id, data FROM records WHERE collection = 'users'")) {
        const account = JSON.parse(row.data);
        delete account.publicKey; delete account.privateKey; delete account.signingKey;
        sql.exec("UPDATE records SET data = ? WHERE collection = 'users' AND id = ?", JSON.stringify(account), row.id);
      }
      sql.exec('DELETE FROM sessions WHERE expires <= ?', Date.now());
      sql.exec("INSERT INTO metadata (key, value) VALUES ('remove-workspace-v1', '1')");
    });
  }

  // Session credentials are independent of the deployment gate. The browser's
  // random cookie unlocks the stored session; the database contains no raw cookie.
  const sessionId = token => createHash('sha256').update('lookup:' + token).digest('hex');
  const sessionKey = token => createHash('sha256').update('encryption:' + token).digest();
  const sessions = {
    get(token) {
      if (!token) return undefined;
      const rows = sql.exec('SELECT data FROM sessions WHERE id = ? AND expires > ?', sessionId(token), Date.now()).toArray();
      if (!rows.length) return undefined;
      const encrypted = JSON.parse(rows[0].data);
      const decipher = createDecipheriv('aes-256-gcm', sessionKey(token), Buffer.from(encrypted.iv, 'hex'));
      decipher.setAuthTag(Buffer.from(encrypted.tag, 'hex'));
      const value = JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted.value, 'hex')), decipher.final()]).toString());
      if ('privateKey' in value) {delete value.privateKey; sessions.set(token, value);}
      return value;
    },
    set(token, value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', sessionKey(token), iv);
      const encrypted = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value))), cipher.final()]);
      storage.transactionSync(() => {
        sql.exec('DELETE FROM sessions WHERE expires <= ?', Date.now());
        const provider = value.kind === 'workos' ? 'workos' : 'builder';
        const authorizationExpires = provider === 'workos' ? Number(value.workos?.expiresAt || 0) : value.expires;
        sql.exec('INSERT INTO sessions (id, data, expires, auth_provider, authorization_expires) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, expires = excluded.expires, auth_provider = excluded.auth_provider, authorization_expires = excluded.authorization_expires',
          sessionId(token), JSON.stringify({iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), value: encrypted.toString('hex')}), value.expires, provider, authorizationExpires);
      });
    },
    delete(token) {
      if (token) sql.exec('DELETE FROM sessions WHERE id = ?', sessionId(token));
    },
  };

  const read = () => {
    const state = {version: 1, ...Object.fromEntries(collections.map(name=>[name,[]]))};
    for (const row of sql.exec('SELECT collection, data FROM records ORDER BY rowid')) {
      if (state[row.collection]) state[row.collection].push(JSON.parse(row.data));
    }
    return state;
  };
  const transaction = (fn) => storage.transactionSync(() => {
    const state = read();
    const previous = new Map(collections.flatMap(c => state[c].map(r => [c + ':' + r.id, JSON.stringify(r)])));
    const result = fn(state);
    if (result instanceof Promise) throw new Error('SQLite transactions must be synchronous.');
    for (const collection of collections) {
      for (const record of state[collection]) {
        const data = JSON.stringify(record);
        const key = collection + ':' + record.id;
        if (previous.get(key) !== data) {
          sql.exec('INSERT INTO records (collection, id, data) VALUES (?, ?, ?) ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data', collection, record.id, data);
        }
        previous.delete(key);
      }
    }
    for (const key of previous.keys()) {
      const split = key.indexOf(':');
      sql.exec('DELETE FROM records WHERE collection = ? AND id = ?', key.slice(0, split), key.slice(split + 1));
    }
    return structuredClone(result);
  });
  const authAttempts = {
    take(key) {
      if (typeof key !== 'string' || key.length > 500) return false;
      const lookup = createHash('sha256').update(key).digest('hex');
      return storage.transactionSync(() => {
        const current = Date.now();
        sql.exec('DELETE FROM auth_attempts WHERE started <= ?', current - 15 * 60_000);
        const row = sql.exec('SELECT attempts FROM auth_attempts WHERE key = ?', lookup).toArray()[0];
        if (row && row.attempts >= 5) return false;
        sql.exec('INSERT INTO auth_attempts (key, started, attempts) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET attempts = attempts + 1', lookup, current);
        return true;
      });
    },
  };
  return {read, transaction, sessions, authAttempts};
}
