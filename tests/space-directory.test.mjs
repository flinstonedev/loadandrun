import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';

// Exercise the actual durable queue against SQLite. Only platform I/O and hosted inference are replaced.
const bundle = await build({entryPoints: ['worker/space-directory.ts'], bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{name: 'durable-object-platform', setup(api) {
    api.onResolve({filter: /^cloudflare:workers$/}, () => ({path: 'platform', namespace: 'test'}));
    api.onResolve({filter: /^\.\/ai$/}, () => ({path: 'ai', namespace: 'test'}));
    api.onLoad({filter: /.*/, namespace: 'test'}, args => ({contents: args.path === 'platform'
      ? 'export class DurableObject { constructor(ctx,env) { this.ctx=ctx; this.env=env; } }'
      : `export const hostedModel = () => ({id:'@cf/test/model',name:'Test model'});
         export const hostedAIAvailable = env => Boolean(env.AI) && env.SPACES_ENABLED==='true' && env.SPACES_AI_ENABLED==='true';
         export const runHostedJob = (env,...args) => env.TEST_RUN(...args);`}));
  }}]});
const {SpaceDirectory} = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  const sockets = [];
  const background = new Set();
  const calls = [];
  const pending = new Map();
  const notifications = [];
  let revision = '1';
  let permitted = true;
  let stateFailure = false;
  let validationBarrier = null;
  let completeBarrier = null;
  const ctx = {storage: {sql: {exec(query, ...params) {const rows = db.prepare(query).all(...params); return {toArray: () => rows};}},
    transactionSync(fn) {db.exec('SAVEPOINT test'); try {const result = fn(); db.exec('RELEASE test'); return result;} catch (error) {db.exec('ROLLBACK TO test'); db.exec('RELEASE test'); throw error;}},
    async setAlarm(time) {ctx.alarmTime = time;}, async deleteAlarm() {ctx.alarmTime = null;}},
    getWebSockets: () => sockets.filter(ws => ws.readyState === 1), setWebSocketAutoResponse() {}, alarmTime: null,
    waitUntil(promise) {background.add(promise); promise.finally(() => background.delete(promise)).catch(() => {});}};
  const space = {async validateAgentJob(job) {if (validationBarrier) await validationBarrier; return permitted && job.contextVersion === revision;},
    async contextFor() {if (!permitted) throw Object.assign(new Error('Space not found.'), {status: 404}); return {spaceId: 'space', title: 'Space', contextRevision: revision, widgets: [], recommendationWidgets: [], excludedUrls: []};},
    async inspectAccess() {return permitted ? {id: 'space', title: 'Space', ownerId: 'alice', role: 'owner', updatedAt: 1} : null;},
    async agentJobState(id, status, error) {if (stateFailure) throw new Error('Unavailable'); notifications.push({id, status, error});},
    async completeAgentJob(job) {if (completeBarrier) await completeBarrier; return {accepted: permitted && job.contextVersion === revision};},
  };
  const env = {WORKSPACE_ID: 'test', SPACES_ENABLED: 'true', SPACES_AI_ENABLED: 'true', AI: {}, SPACES: {getByName: () => space},
    TEST_RUN(job, progress, signal) {
      calls.push({job, progress, signal});
      return new Promise((resolve, reject) => {pending.set(job.id, {resolve, reject});});
    }};
  let directory = new SpaceDirectory(ctx, env);
  directory.initialize('alice');
  const actor = {id: 'alice', name: 'Alice'};
  const f = {ctx, db, actor, env, sockets, calls, notifications, get directory() {return directory;},
    restart() {directory = new SpaceDirectory(ctx, env); return directory;},
    revision(value) {revision = value;}, access(value) {permitted = value;}, failNotifications(value) {stateFailure = value;},
    blockValidation(value) {validationBarrier = value;}, blockComplete(value) {completeBarrier = value;},
    write(key, value) {db.prepare('INSERT INTO space_state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));},
    read(key) {const row = db.prepare('SELECT value FROM space_state WHERE key = ?').get(key); return row ? JSON.parse(row.value) : undefined;},
    async status() {return (await directory.dispatch(actor, 'GET', 'status')).body;},
    async finish(id, result = {recommendations: []}) {await tick(); assert.ok(pending.has(id), `Runner started for ${id}`); pending.get(id).resolve(result); pending.delete(id); await tick();},
    async fail(id, error) {await tick(); pending.get(id).reject(error); pending.delete(id); await tick();},
  };
  t.after(async () => {
    env.SPACES_AI_ENABLED = 'false';
    for (const {resolve} of pending.values()) resolve({text: 'Cleanup', recommendations: []});
    await Promise.allSettled([...background]);
    db.close();
  });
  return f;
}
function recommendation(id, contextVersion = '1', automatic = true, spaceId = 'space') {
  return {id, spaceId, userId: 'alice', kind: 'recommendations', provider: 'cloudflare', consentVersion: 1, automatic, contextVersion, context: {}, createdAt: Date.now()};
}

test('hosted status is immediately available without a device, subscription, or pairing', async t => {
  const f = fixture(t);
  const status = await f.status();
  assert.equal(status.provider, 'cloudflare');
  assert.equal(status.available, true);
  assert.deepEqual(status.model, {id: '@cf/test/model', name: 'Test model'});
  assert.equal(status.usage.manualLimit, 40);
  for (const field of ['connected', 'device', 'account', 'models']) assert.equal(field in status, false);
  for (const action of ['pair', 'pair/approve', 'pairing', 'disconnect']) assert.equal((await f.directory.dispatch(f.actor, 'POST', action)).status, 404);
});

test('automatic reservations and completed-job deduplication survive restart; day limit queues latest work', async t => {
  const f = fixture(t);
  for (let n = 0; n < 12; n++) {
    const job = recommendation(`job-${n}`);
    assert.equal((await f.directory.enqueueJob(job)).status, 'running');
    await f.finish(job.id);
    if (n === 0) {
      f.restart();
      assert.equal((await f.directory.enqueueJob(job)).status, 'completed');
      assert.equal(f.calls.length, 1);
    }
  }
  const queued = await f.directory.enqueueJob(recommendation('over-limit'));
  assert.equal(queued.status, 'rate-limited');
  assert.equal((await f.status()).usage.automaticRuns, 12);
  assert.equal(f.calls.length, 12);
  assert.ok(f.notifications.some(item => item.id === 'over-limit' && item.status === 'rate-limited'));
  assert.ok(f.ctx.alarmTime > Date.now());
  // Manual work has a separate budget and can run while automatic work waits for tomorrow.
  assert.equal((await f.directory.enqueueJob(recommendation('manual', '1', false))).status, 'running');
  assert.equal((await f.status()).usage.automaticRuns, 12);
  assert.equal((await f.status()).usage.manualRuns, 1);
  await f.finish('manual');
});

test('manual chat and refresh share a persistent daily budget and over-limit chat is not saved', async t => {
  const f = fixture(t);
  const day = new Date().toISOString().slice(0, 10);
  f.write(`manual-usage:${day}`, 39);
  const sent = await f.directory.dispatch(f.actor, 'POST', 'chat', {spaceId: 'space', message: 'Last request today'});
  assert.equal(sent.status, 202);
  await f.finish(sent.body.jobId, {text: 'Answer'});
  f.restart();
  assert.equal((await f.status()).usage.manualRuns, 40);
  const limited = await f.directory.dispatch(f.actor, 'POST', 'chat', {spaceId: 'space', message: 'Do not store me'});
  assert.equal(limited.status, 429);
  await assert.rejects(f.directory.enqueueJob(recommendation('manual-over-limit', '1', false)), error => error.status === 429);
  const chat = (await f.directory.dispatch(f.actor, 'GET', 'chat', {spaceId: 'space'})).body;
  assert.deepEqual(chat.messages.map(item => item.text), ['Last request today', 'Answer']);
  assert.equal(f.calls.length, 1);
});

test('private chats stay in their owner directory, clear changed context, and reject stale replies', async t => {
  const f = fixture(t);
  const sent = await f.directory.dispatch(f.actor, 'POST', 'chat', {spaceId: 'space', message: 'A private question'});
  assert.equal(sent.status, 202);
  await f.finish(sent.body.jobId, {text: 'Private reply'});
  f.restart();
  assert.equal((await f.directory.dispatch(f.actor, 'GET', 'chat', {spaceId: 'space'})).body.messages.length, 2);
  assert.equal((await f.directory.dispatch({id: 'bob', name: 'Bob'}, 'GET', 'chat', {spaceId: 'space'})).status, 403);
  assert.ok(!JSON.stringify(await f.status()).includes('Private reply'));
  const second = await f.directory.dispatch(f.actor, 'POST', 'chat', {spaceId: 'space', message: 'Second question'});
  f.revision('2');
  await f.finish(second.body.jobId, {text: 'Must not appear'});
  const fresh = await f.directory.dispatch(f.actor, 'GET', 'chat', {spaceId: 'space'});
  assert.deepEqual(fresh.body.messages, []);
  assert.equal(fresh.body.contextRevision, '2');
  assert.equal((await f.status()).jobs.find(job => job.id === second.body.jobId).status, 'stale');
  f.access(false);
  assert.equal((await f.directory.dispatch(f.actor, 'GET', 'chat', {spaceId: 'space'})).status, 404);
});

test('one inference runs at a time and private chat is selected before queued recommendations', async t => {
  const f = fixture(t);
  await f.directory.enqueueJob(recommendation('first'));
  await tick();
  const other = await f.directory.enqueueJob(recommendation('other', '1', false, 'other-space'));
  assert.equal(other.status, 'queued');
  const chat = await f.directory.dispatch(f.actor, 'POST', 'chat', {spaceId: 'space', message: 'Private thought'});
  assert.equal(chat.body.status, 'queued');
  assert.equal(f.calls.length, 1);
  await f.finish('first');
  assert.equal(f.calls.at(-1).job.id, chat.body.jobId);
  assert.equal(f.calls.length, 2);
  await f.finish(chat.body.jobId, {text: 'Reply'});
  assert.equal(f.calls.at(-1).job.id, 'other');
  await f.finish('other');
});

test('queued automatic snapshots coalesce and context cancellation preserves a new private chat', async t => {
  const f = fixture(t);
  await f.directory.enqueueJob(recommendation('blocker', '1', false, 'other-space'));
  assert.equal((await f.directory.enqueueJob(recommendation('old'))).status, 'queued');
  assert.equal((await f.directory.enqueueJob(recommendation('new'))).status, 'queued');
  const status = await f.status();
  assert.equal(status.jobs.find(job => job.id === 'old').status, 'stale');
  assert.equal(status.jobs.find(job => job.id === 'new').status, 'queued');
  f.revision('2');
  const chat = await f.directory.dispatch(f.actor, 'POST', 'chat', {spaceId: 'space', message: 'New context'});
  await f.directory.cancelSpaceJobs('space', 'Context refreshed', '2');
  const current = (await f.directory.dispatch(f.actor, 'GET', 'chat', {spaceId: 'space'})).body;
  assert.equal(current.messages[0].text, 'New context');
  assert.equal(current.job.id, chat.body.jobId);
  assert.equal(current.job.status, 'queued');
});

test('running jobs recovered after eviction fail at their deadline without another paid inference', async t => {
  const f = fixture(t);
  const job = recommendation('interrupted');
  f.write(`job:${job.id}`, {job, provider: 'cloudflare', status: 'running', startedAt: Date.now()});
  f.write(`usage:${new Date().toISOString().slice(0, 10)}`, 1);
  f.restart();
  assert.equal((await f.directory.enqueueJob(job)).status, 'running');
  assert.equal((await f.status()).jobs[0].status, 'running');
  assert.equal(f.calls.length, 0);
  assert.equal(f.directory.isJobActive(job.id, job.contextVersion), true);
  f.write(`job:${job.id}`, {...f.read(`job:${job.id}`), startedAt: Date.now() - 4 * 60_000});
  await f.directory.alarm();
  assert.equal((await f.status()).jobs[0].status, 'failed');
  assert.equal((await f.status()).usage.automaticRuns, 1);
  assert.equal(f.directory.isJobActive(job.id, job.contextVersion), false);
  assert.equal(f.calls.length, 0);
});

test('stopping a hosted request aborts when possible and always rejects its late result', async t => {
  const f = fixture(t);
  const sent = await f.directory.dispatch(f.actor, 'POST', 'chat', {spaceId: 'space', message: 'Stop this'});
  await tick();
  f.calls[0].progress('Thinking');
  assert.equal((await f.status()).jobs[0].progress, 'Thinking');
  assert.equal((await f.directory.dispatch(f.actor, 'POST', 'cancel', {jobId: sent.body.jobId})).status, 200);
  assert.equal(f.calls[0].signal.aborted, true);
  f.calls[0].progress('Late progress');
  await f.finish(sent.body.jobId, {text: 'Late answer'});
  const chat = (await f.directory.dispatch(f.actor, 'GET', 'chat', {spaceId: 'space'})).body;
  assert.deepEqual(chat.messages.map(item => item.text), ['Stop this']);
  assert.equal(chat.job.status, 'cancelled');
  assert.equal(chat.job.progress, undefined);
  f.restart();
  assert.equal((await f.status()).jobs[0].status, 'cancelled');
});

test('revocation during inference prevents applying a result', async t => {
  const f = fixture(t);
  await f.directory.enqueueJob(recommendation('access-changed'));
  f.access(false);
  await f.finish('access-changed');
  assert.equal((await f.status()).jobs[0].status, 'stale');
  assert.ok(!f.notifications.some(item => item.status === 'completed'));
});

test('cancellation during result validation cannot mark a request completed', async t => {
  const f = fixture(t);
  let resume;
  f.blockComplete(new Promise(resolve => {resume = resolve;}));
  await f.directory.enqueueJob(recommendation('cancel-during-validation'));
  await f.finish('cancel-during-validation');
  await f.directory.cancelRecommendations('space');
  resume();
  await tick();
  assert.equal((await f.status()).jobs[0].status, 'cancelled');
  assert.ok(!f.notifications.some(item => item.status === 'completed'));
});

test('concurrent retries reserve exactly one job and one daily charge', async t => {
  const f = fixture(t);
  let resume;
  f.blockValidation(new Promise(resolve => {resume = resolve;}));
  const job = recommendation('duplicate');
  const left = f.directory.enqueueJob(job);
  const right = f.directory.enqueueJob(job);
  resume();
  await Promise.all([left, right]);
  await tick();
  assert.equal(f.calls.length, 1);
  assert.equal((await f.status()).usage.automaticRuns, 1);
  await f.finish('duplicate');
});

test('concurrent chat submissions admit one prompt and do not leave a rejected prompt in history', async t => {
  const f = fixture(t);
  let resume;
  f.blockValidation(new Promise(resolve => {resume = resolve;}));
  const left = f.directory.dispatch(f.actor, 'POST', 'chat', {spaceId: 'space', message: 'First'});
  const right = f.directory.dispatch(f.actor, 'POST', 'chat', {spaceId: 'space', message: 'Second'});
  await tick();
  resume();
  const results = await Promise.all([left, right]);
  assert.deepEqual(results.map(result => result.status).sort(), [202, 409]);
  await tick();
  assert.equal(f.calls.length, 1);
  const chat = (await f.directory.dispatch(f.actor, 'GET', 'chat', {spaceId: 'space'})).body;
  assert.deepEqual(chat.messages.map(item => item.text), [f.calls[0].job.message]);
});

test('retirement removes legacy credentials, closes hibernated sockets, and cancels old work without running it', async t => {
  const f = fixture(t);
  f.write('device', {id: 'old', secretHash: 'secret'});
  f.write('account', {account: {type: 'chatgpt'}});
  f.write('pair:pending', {secretHash: 'secret'});
  f.write('job:old', {job: recommendation('old'), status: 'running', startedAt: Date.now()});
  f.write('job:queued-old', {job: recommendation('queued-old'), status: 'queued'});
  const socket = {readyState: 1, close(code) {this.readyState = 3; this.code = code;}};
  f.sockets.push(socket);
  f.restart();
  assert.equal(socket.code, 4001);
  for (const key of ['device', 'account', 'pair:pending']) assert.equal(f.read(key), undefined);
  const status = await f.status();
  assert.ok(status.jobs.every(job => job.status === 'cancelled'));
  assert.equal(f.calls.length, 0);
  assert.equal((await f.directory.fetch(new Request('https://example.test/'))).status, 410);
  assert.equal(typeof f.directory.startPairing, 'undefined');
  assert.ok(f.notifications.some(item => item.id === 'old' && item.status === 'cancelled'));
});

test('disabled hosted AI rejects new work without saving a prompt or spending budget', async t => {
  const f = fixture(t);
  f.env.SPACES_AI_ENABLED = 'false';
  assert.equal((await f.status()).available, false);
  assert.equal((await f.directory.dispatch(f.actor, 'POST', 'chat', {spaceId: 'space', message: 'Do not run'})).status, 503);
  await assert.rejects(f.directory.enqueueJob(recommendation('disabled')), error => error.status === 503);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.status()).usage.automaticRuns, 0);
  assert.equal(f.read('chat:space'), undefined);
});

test('provider failures use a safe message and persisted notifications retry after restart', async t => {
  const f = fixture(t);
  await f.directory.enqueueJob(recommendation('failed'));
  await tick();
  f.failNotifications(true);
  await f.fail('failed', new Error('Private prompt and secret credential'));
  const status = await f.status();
  assert.equal(status.jobs[0].status, 'failed');
  assert.match(status.jobs[0].error, /Hosted AI/);
  assert.ok(!JSON.stringify(status).includes('secret credential'));
  assert.equal(f.read('notify:failed').status, 'failed');
  f.restart();
  f.failNotifications(false);
  await f.directory.alarm();
  assert.equal(f.read('notify:failed'), undefined);
  assert.ok(f.notifications.some(item => item.id === 'failed' && item.status === 'failed'));
});

test('stopping shared recommendations preserves the owner’s private conversation', async t => {
  const f = fixture(t);
  await f.directory.enqueueJob(recommendation('shared-suggestion'));
  const chat = await f.directory.dispatch(f.actor, 'POST', 'chat', {spaceId: 'space', message: 'My private thought'});
  await f.directory.cancelRecommendations('space');
  await tick();
  const current = (await f.directory.dispatch(f.actor, 'GET', 'chat', {spaceId: 'space'})).body;
  assert.equal(current.messages[0].text, 'My private thought');
  assert.equal(current.job.id, chat.body.jobId);
  assert.equal(current.job.status, 'running');
  assert.equal((await f.status()).jobs.find(job => job.id === 'shared-suggestion').status, 'cancelled');
});


test('legacy private conversations remain readable after migration and never become hosted model history', async t => {
  const f = fixture(t);
  const archived = [
    {id: 'old-prompt', role: 'user', text: 'Old private note', createdAt: 1},
    {id: 'old-answer', role: 'assistant', text: 'Old Codex reply', createdAt: 2},
  ];
  f.write('chat:space', {contextVersion: '1', messages: archived});
  f.db.prepare('DELETE FROM space_state WHERE key = ?').run('migration:hosted-ai-v1');
  f.restart();
  f.revision('2');
  const prior = (await f.directory.dispatch(f.actor, 'GET', 'chat', {spaceId: 'space'})).body;
  assert.deepEqual(prior.messages, []);
  assert.deepEqual(prior.archivedMessages, archived);
  assert.equal(f.read('chat:space'), undefined);
  const sent = await f.directory.dispatch(f.actor, 'POST', 'chat', {spaceId: 'space', message: 'New hosted question'});
  await tick();
  assert.deepEqual(f.calls[0].job.history, []);
  assert.ok(!JSON.stringify(f.calls[0].job).includes('Old private note'));
  await f.finish(sent.body.jobId, {text: 'New hosted reply'});
  f.restart();
  const current = (await f.directory.dispatch(f.actor, 'GET', 'chat', {spaceId: 'space'})).body;
  assert.deepEqual(current.archivedMessages, archived);
  assert.deepEqual(current.messages.map(message => message.text), ['New hosted question', 'New hosted reply']);
  assert.ok(!JSON.stringify(await f.status()).includes('Old private note'));
  assert.equal((await f.directory.dispatch({id: 'bob', name: 'Bob'}, 'GET', 'chat', {spaceId: 'space'})).status, 403);
  f.access(false);
  assert.equal((await f.directory.dispatch(f.actor, 'GET', 'chat', {spaceId: 'space'})).status, 404);
  await f.directory.cancelSpaceJobs('space', 'Space access was removed.');
  assert.equal(f.read('chat-archive:space'), undefined);
});
