import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {newUser, authenticateUser} from '../server/model.mjs';
import {resolveWorkOSBuilder, onboardWorkOSBuilder} from '../server/workos-identity.mjs';
import {openTestStore} from './helpers/sqlite.mjs';

const workos = (id = 'user_alice', overrides = {}) => ({id, email: 'alice@example.com', emailVerified: true, firstName: 'Alice', lastName: 'Builder', ...overrides});
const status = expected => error => error.status === expected;
function storeFor(t) {
  const store = openTestStore();
  t.after(() => store.close());
  return store;
}

test('an unmapped verified email or display name never silently claims a legacy builder', t => {
  const store = storeFor(t);
  const legacy = {...newUser('Alice Builder', 'old-password-123'), email: 'alice@example.com'};
  store.transaction(state => state.users.push(legacy));
  const before = store.read();
  assert.equal(resolveWorkOSBuilder(store, workos()), null);
  assert.deepEqual(store.read(), before);
});

test('creating a builder stores no password and repeated sign-ins keep the same UUID and chosen name', t => {
  const store = storeFor(t);
  const created = onboardWorkOSBuilder(store, workos(), {mode: 'create', name: '  my-builder  '});
  assert.match(created.id, /^[0-9a-f-]{36}$/);
  assert.equal(created.name, 'my-builder');
  const updatedIdentity = workos(undefined, {email: 'new@example.com', firstName: 'Different'});
  assert.deepEqual(resolveWorkOSBuilder(store, updatedIdentity), created);
  assert.deepEqual(resolveWorkOSBuilder(store, updatedIdentity), created);
  const [account] = store.read().users;
  assert.equal(store.read().users.length, 1);
  assert.deepEqual(account, {...created, workosId: 'user_alice', email: 'new@example.com', emailVerified: true});
  assert.deepEqual(Object.keys(created).sort(), ['id', 'name']);
  assert.throws(() => authenticateUser(account, 'any-password-123'), status(401));
});

test('explicit password claim preserves all community ownership and the UUID used by space directories across restarts', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'lr-workos-'));
  const path = join(dir, 'community.sqlite');
  const store = openTestStore(path);
  let reopened;
  t.after(async () => {store.close(); reopened?.close(); await rm(dir, {recursive: true, force: true});});
  const legacy = newUser('Existing Builder', 'old-password-123');
  store.transaction(state => {
    state.users.push(legacy);
    for (const collection of ['groups', 'projects', 'posts', 'comments', 'reactions', 'bookmarks', 'ideaSubmissions', 'reports']) {
      state[collection].push({id: collection + '_1', owner: legacy.id, members: [legacy.id], content: 'Existing data'});
    }
  });
  const {users: _users, ...ownedRecords} = store.read();
  const claimed = onboardWorkOSBuilder(store, workos(), {mode: 'claim', name: 'existing builder', password: 'old-password-123'});
  assert.deepEqual(claimed, {id: legacy.id, name: legacy.name});
  reopened = openTestStore(path);
  assert.deepEqual(resolveWorkOSBuilder(reopened, workos()), claimed);
  const {users, ...afterRecords} = reopened.read();
  assert.deepEqual(afterRecords, ownedRecords);
  assert.equal(users[0].id, legacy.id);
  assert.equal(users[0].workosId, 'user_alice');
  assert.equal('hash' in users[0], false);
  assert.equal('salt' in users[0], false);
});

test('a failed password claim and a missing-account claim do not create or modify any account', t => {
  const store = storeFor(t);
  store.transaction(state => state.users.push(newUser('Alice', 'old-password-123')));
  const before = store.read();
  for (const name of ['Alice', 'unknown']) {
    assert.throws(() => onboardWorkOSBuilder(store, workos(), {mode: 'claim', name, password: 'wrong-password'}), status(401));
  }
  assert.deepEqual(store.read(), before);
});

test('creating a profile reserves names of all builders, including accounts without legacy passwords', t => {
  const store = storeFor(t);
  store.transaction(state => state.users.push({id: 'seeded', name: 'Reserved'}));
  assert.throws(() => onboardWorkOSBuilder(store, workos(), {mode: 'create', name: ' reserved '}), status(409));
  const first = onboardWorkOSBuilder(store, workos(), {mode: 'create', name: 'Alice'});
  assert.throws(() => onboardWorkOSBuilder(store, workos('user_bob'), {mode: 'create', name: 'ALICE'}), status(409));
  assert.deepEqual(resolveWorkOSBuilder(store, workos()), first);
  assert.equal(resolveWorkOSBuilder(store, workos('user_bob')), null);
});

test('matching email never merges two independently authenticated WorkOS identities', t => {
  const store = storeFor(t);
  const first = onboardWorkOSBuilder(store, workos(), {mode: 'create', name: 'Alice'});
  const second = onboardWorkOSBuilder(store, workos('user_bob'), {mode: 'create', name: 'Bob'});
  assert.notEqual(first.id, second.id);
  assert.deepEqual(resolveWorkOSBuilder(store, workos()), first);
  assert.deepEqual(resolveWorkOSBuilder(store, workos('user_bob')), second);
});

test('claim cannot replace another WorkOS binding, even with a retained valid legacy password', t => {
  const store = storeFor(t);
  const legacy = {...newUser('Alice', 'old-password-123'), workosId: 'user_original'};
  store.transaction(state => state.users.push(legacy));
  const before = store.read();
  assert.throws(() => onboardWorkOSBuilder(store, workos(), {mode: 'claim', name: 'Alice', password: 'old-password-123'}), status(409));
  assert.deepEqual(store.read(), before);
});

test('one WorkOS identity cannot create or claim a second builder and retries are idempotent', t => {
  const store = storeFor(t);
  store.transaction(state => state.users.push(newUser('Bob', 'bob-password-123')));
  const first = onboardWorkOSBuilder(store, workos(), {mode: 'create', name: 'Alice'});
  assert.deepEqual(onboardWorkOSBuilder(store, workos(), {mode: 'create', name: 'alice'}), first);
  assert.throws(() => onboardWorkOSBuilder(store, workos(), {mode: 'create', name: 'New name'}), status(409));
  assert.throws(() => onboardWorkOSBuilder(store, workos(), {mode: 'claim', name: 'Bob', password: 'bob-password-123'}), status(409));
  assert.equal(store.read().users.length, 2);
  assert.equal(store.read().users.find(account => account.name === 'Bob').workosId, undefined);
});

test('simultaneous creation and claim requests never produce duplicate bindings', async t => {
  const store = storeFor(t);
  const legacy = newUser('Old builder', 'old-password-123');
  store.transaction(state => state.users.push(legacy));
  const creation = await Promise.allSettled(['user_a', 'user_b'].map(id => Promise.resolve().then(() =>
    onboardWorkOSBuilder(store, workos(id), {mode: 'create', name: 'Only name'}))));
  assert.equal(creation.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(creation.find(result => result.status === 'rejected').reason.status, 409);
  const claims = await Promise.allSettled(['user_c', 'user_d'].map(id => Promise.resolve().then(() =>
    onboardWorkOSBuilder(store, workos(id), {mode: 'claim', name: 'Old builder', password: 'old-password-123'}))));
  assert.equal(claims.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(claims.find(result => result.status === 'rejected').reason.status, 409);
  const users = store.read().users;
  assert.equal(users.length, 2);
  assert.equal(users.find(account => account.name === 'Old builder').id, legacy.id);
  assert.equal(new Set(users.map(account => account.workosId)).size, users.length);
});

test('ambiguous legacy names or corrupted duplicate provider bindings fail closed', t => {
  const store = storeFor(t);
  store.transaction(state => state.users.push(newUser('Alice', 'password-one-123'), newUser('ALICE', 'password-two-123')));
  const before = store.read();
  assert.throws(() => onboardWorkOSBuilder(store, workos(), {mode: 'claim', name: 'alice', password: 'password-one-123'}), status(409));
  assert.deepEqual(store.read(), before);
  store.transaction(state => {for (const account of state.users) account.workosId = 'user_alice';});
  assert.throws(() => resolveWorkOSBuilder(store, workos()), status(409));
});

test('invalid onboarding inputs and malformed server identity do not write records', t => {
  const store = storeFor(t);
  for (const input of [null, {}, {mode: 'merge', name: 'Alice'}, {mode: 'create', name: ''}, {mode: 'create', name: 'x'.repeat(81)}, {mode: 'create', name: 'Alice\nAdmin'}]) {
    assert.throws(() => onboardWorkOSBuilder(store, workos(), input), status(400));
  }
  for (const identity of [null, {}, workos(''), workos(' user_alice'), workos(undefined, {email: ''}), workos(undefined, {email: 'alice@example.com\nInjected'})]) {
    assert.throws(() => resolveWorkOSBuilder(store, identity), status(401));
  }
  assert.deepEqual(store.read().users, []);
});
