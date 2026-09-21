import {DatabaseSync} from 'node:sqlite';
import {openSQLiteStore} from '../../server/sqlite-store.mjs';

export function openTestStore(path = ':memory:') {
  const db = new DatabaseSync(path);
  let sequence = 0;
  const storage = {
    sql: {exec(query, ...bindings) {
      const rows = db.prepare(query).all(...bindings);
      return {toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]()};
    }},
    transactionSync(fn) {
      const name = 'test_tx_' + sequence++;
      db.exec('SAVEPOINT ' + name);
      try {const result = fn(); db.exec('RELEASE ' + name); return result;}
      catch (error) {db.exec('ROLLBACK TO ' + name); db.exec('RELEASE ' + name); throw error;}
    },
  };
  return {...openSQLiteStore(storage), close: () => db.close()};
}
