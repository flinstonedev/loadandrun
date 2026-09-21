import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {openSQLiteStore} from '../server/sqlite-store.mjs';
import {createAPI} from '../server/api.mjs';
import {authenticateUser} from '../server/model.mjs';
import {createHash, scryptSync, createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';
import {Readable} from 'node:stream';
import {readFile} from 'node:fs/promises';
import {isFreeToUseEntry} from '../src/catalog-policy.js';
import {hasDetailedBrief} from '../src/idea-details.js';
import {licenseTexts} from '../src/license-texts.js';

test('Workspace retirement deletes documents and legacy records while retaining builders and community data', async t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let sequence = 0;
  const storage = {
    sql: {exec(query, ...bindings) {
      const rows = db.prepare(query).all(...bindings);
      return {toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]()};
    }},
    transactionSync(fn) {
      const name = 'tx' + sequence++;
      db.exec('SAVEPOINT ' + name);
      try {const result = fn(); db.exec('RELEASE ' + name); return result;}
      catch (error) {db.exec('ROLLBACK TO ' + name); db.exec('RELEASE ' + name); throw error;}
    },
  };
  db.exec(`CREATE TABLE records (collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (collection, id));
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE presence (user TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL);`);
  const password = 'existing-builder-password';
  const legacyUser = {id: 'existing-builder', name: 'Existing Builder', salt: 'existing-salt',
    hash: createHash('sha256').update(scryptSync(password, 'existing-salt', 32)).digest('hex'),
    publicKey: 'old-document-signing-public-key', privateKey: {value: 'encrypted-document-signing-key'}, signingKey: 'retired-signing-key'};
  const retained = {
    users: [legacyUser],
    groups: [{id: 'group', owner: legacyUser.id, members: [legacyUser.id], name: 'Builders'}],
    projects: [{id: 'project', owner: legacyUser.id, groupId: 'group', title: 'A prototype'}],
    posts: [{id: 'post', author: legacyUser.id, content: 'A public update'}],
    comments: [{id: 'comment', author: legacyUser.id, postId: 'post', content: 'I can help'}],
    reactions: [{id: 'reaction', user: legacyUser.id, postId: 'post'}],
    bookmarks: [{id: 'bookmark', user: legacyUser.id, ideaAddress: '1a'}],
    ideaSubmissions: [{id: 'submission', owner: legacyUser.id, status: 'pending'}],
    reports: [{id: 'report', reporter: legacyUser.id, postId: 'post'}],
  };
  const retired = {
    docs: [{id: 'personal-document', owner: legacyUser.id, history: [{revision: 1}]},
      {id: 'catalog-document', owner: null, blueprint: '1a'}],
    journals: [{id: 'signed-journal', document: 'personal-document', payload: 'Old published document'}],
    mail: [{id: 'message', document: 'personal-document', to: legacyUser.id}],
    lines: [{id: 'continuation-line', owner: legacyUser.id, blueprint: '1a'}],
  };
  for (const [collection, records] of Object.entries({...retained, ...retired})) {
    for (const record of records) db.prepare('INSERT INTO records VALUES (?, ?, ?)').run(collection, record.id, JSON.stringify(record));
  }
  db.prepare('INSERT INTO presence VALUES (?, ?, ?)').run(legacyUser.id, JSON.stringify({document: 'personal-document'}), Date.now() + 60_000);
  for (const key of ['seeded', 'catalog-copy-v2', 'catalog-rights-v1']) db.prepare('INSERT INTO metadata VALUES (?, ?)').run(key, 'old-value');

  // Reproduce the previous encrypted session format so signed-in builders stay signed in.
  const token = 'existing-session-cookie';
  const legacySession = {user: legacyUser.id, csrf: 'existing-csrf', expires: Date.now() + 3_600_000, privateKey: 'retired-signing-key'};
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update('encryption:' + token).digest(), iv);
  const value = Buffer.concat([cipher.update(JSON.stringify(legacySession)), cipher.final()]);
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(
    createHash('sha256').update('lookup:' + token).digest('hex'),
    JSON.stringify({iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), value: value.toString('hex')}), legacySession.expires);

  const store = openSQLiteStore(storage);
  const state = store.read();
  const {publicKey, privateKey, signingKey, ...builder} = legacyUser;
  assert.deepEqual(state.users, [builder]);
  for (const collection of Object.keys(retained).filter(name => name !== 'users')) assert.deepEqual(state[collection], retained[collection], collection);
  for (const collection of Object.keys(retired)) {
    assert.equal(state[collection], undefined, collection);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM records WHERE collection = ?').get(collection).count, 0, collection);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'presence'").get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 1);
  const {privateKey: sessionKey, ...expectedSession} = legacySession;
  assert.deepEqual(store.sessions.get(token), expectedSession);
  const savedSession = JSON.parse(db.prepare('SELECT data FROM sessions').get().data);
  const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update('encryption:' + token).digest(), Buffer.from(savedSession.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(savedSession.tag, 'hex'));
  const decryptedSession = JSON.parse(Buffer.concat([decipher.update(Buffer.from(savedSession.value, 'hex')), decipher.final()]).toString());
  assert.deepEqual(decryptedSession, expectedSession);
  assert.equal(store.presence, undefined);

  // The retained hash can prove ownership during migration, but it cannot be
  // used at the retired password-login endpoint, even without WorkOS config.
  assert.doesNotThrow(() => authenticateUser(state.users[0], password));
  const api = createAPI(store, {sessions: store.sessions});
  const req = Readable.from([JSON.stringify({name: legacyUser.name, password})]);
  Object.assign(req, {url: '/api/login', method: 'POST', headers: {
    host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173', 'content-type': 'application/json',
  }});
  await assert.rejects(() => api(req, {}), error => error.status === 410);

  const reopened = openSQLiteStore(storage, {blueprints: [{addr: '1a', name: 'Never recreate a document'}]});
  assert.deepEqual(reopened.read(), state);
  assert.deepEqual(reopened.sessions.get(token), expectedSession);
  reopened.transaction(next => {next.groups[0].name = 'Still building';});
  assert.equal(openSQLiteStore(storage).read().groups[0].name, 'Still building');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM records WHERE collection = 'docs'").get().count, 0);
});

test('published catalog entries have explicit implementation licenses and held entries stay out', async () => {
  const data = JSON.parse(await readFile(new URL('../src/data.json', import.meta.url)));
  const review = JSON.parse(await readFile(new URL('../research/catalog-rights.json', import.meta.url)));
  const communityIdeas=JSON.parse(await readFile(new URL('../research/community-ideas.json',import.meta.url)));
  const expanded=(await Promise.all(['knowledge','programming','networks'].map(name=>readFile(new URL('../research/expanded/'+name+'.json',import.meta.url)).then(JSON.parse)))).flat();
  assert.deepEqual(data.blueprints.map(b=>b.addr).sort(), [...Object.entries(review.entries).filter(([,r])=>r.decision==='publish').map(([id])=>id),...communityIdeas.map(i=>i.id),...expanded.map(i=>i.id)].sort());
  assert.ok(data.blueprints.length>=40);
  assert.ok(data.blueprints.every(hasDetailedBrief));
  assert.equal(Object.values(review.entries).filter(r=>r.decision==='hold').length,7);
  for (const blueprint of data.blueprints) {
    assert.ok(blueprint.sources.length);
    assert.ok(blueprint.reuse.license && blueprint.reuse.notice && blueprint.reuse.scope);
    for(const url of [blueprint.reuse.codeUrl,blueprint.reuse.licenseUrl,...blueprint.sources.map(s=>s.url)])assert.equal(new URL(url).protocol,'https:');
  }
  assert.ok(data.people.every(p=>data.blueprints.some(b=>b.addr===p.blueprint)));
});

test('publication rejects unreviewed, noncommercial, royalty-bearing, or incomplete entries', async () => {
  const data = JSON.parse(await readFile(new URL('../src/data.json', import.meta.url)));
  const entry = data.blueprints[0];
  assert.equal(isFreeToUseEntry(entry), true);
  const variants = [
    {...entry,reuse:{...entry.reuse,reviewStatus:'pending'}},
    {...entry,reuse:{...entry.reuse,license:'CC BY-NC 4.0'}},
    {...entry,reuse:{...entry.reuse,permissions:{...entry.reuse.permissions,commercial:false}}},
    {...entry,reuse:{...entry.reuse,permissions:{...entry.reuse.permissions,royaltyFree:false}}},
    {...entry,reuse:{...entry.reuse,permissions:{}}},
    {...entry,reuse:{...entry.reuse,licenseUrl:'javascript:alert(1)'}},
    {...entry,sources:[]},
    {...entry,reuse:undefined},
  ];
  for (const variant of variants) assert.equal(isFreeToUseEntry(variant), false);
  for (const published of data.blueprints) {
    assert.equal(isFreeToUseEntry(published), true);
    assert.ok((published.reuse.licenseTermsText || published.reuse.licenseText || licenseTexts[published.reuse.license])?.length > 500);
  }
});
