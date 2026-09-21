import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openTestStore} from './helpers/sqlite.mjs';
import {handleCommunity} from '../server/community.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'lr-community-'));
  const store = openTestStore(join(dir, 'community.sqlite'));
  const stores = [store];
  t.after(async () => {for (const opened of stores) opened.close(); await rm(dir, {recursive: true, force: true});});
  const reopen = () => {const opened = openTestStore(join(dir, 'community.sqlite')); stores.push(opened); return opened;};
  const alice = {id: 'alice', name: 'Alice'}, bob = {id: 'bob', name: 'Bob'}, carol = {id: 'carol', name: 'Carol'};
  await store.transaction(state => {
    state.users.push(alice, bob, carol);
    for (const key of ['groups', 'projects', 'posts', 'comments', 'reactions', 'bookmarks', 'ideaSubmissions', 'reports']) state[key] ||= [];
  });
  const call = async (user, endpoint, body, extra = {}) => handleCommunity({endpoint,
    method: body === undefined ? 'GET' : 'POST', body, user, store, catalogAddresses: ['1a', '1c'], ...extra});
  const group = async (user = alice) => (await call(user, 'community/groups', {name: 'Hypertext builders', description: 'Build better shared documents.', topic: 'Hypertext'})).body;
  const project = async (groupId, user = alice) => (await call(user, 'community/projects', {
    title: 'Addressable notes', goal: 'Ship an addressable notebook prototype.', ideaAddress: '1a', groupId,
  })).body;
  return {store, dir, reopen, alice, bob, carol, call, group, project};
}

const rejectsStatus = (operation, status) => assert.rejects(operation, error => error.status === status);

test('builders can start a project from their own idea without linking a catalog idea', async t => {
  const f = await fixture(t);
  const project = (await f.call(f.alice, 'community/projects', {title: 'Pocket synth', goal: 'Build a browser synth from scratch.'})).body;
  assert.equal(project.ideaAddress, null);
  assert.equal(project.title, 'Pocket synth');
  const plain = (await f.call(f.alice, 'community/posts', {projectId: project.id, content: 'First oscillator works.'})).body;
  assert.equal(plain.ideaAddress, null);
  const linked = (await f.call(f.alice, 'community/posts', {projectId: project.id, content: 'Related reading.', ideaAddress: '1a'})).body;
  assert.equal(linked.ideaAddress, '1a');
  await rejectsStatus(() => f.call(f.alice, 'community/projects', {title: 'Bad', goal: 'Goal', ideaAddress: 'unreviewed'}), 400);
  const reopened = await f.reopen();
  assert.equal((await f.call(null, 'community', undefined, {store: reopened})).body.projects[0].ideaAddress, null);
});

test('community browsing is anonymous but all participation requires a real app account', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.call(null, 'community')).body, {groups: [], projects: [], posts: []});
  await rejectsStatus(() => f.call(null, 'community/groups', {name: 'Test', description: 'Test'}), 401);
  await rejectsStatus(() => f.call({id: 'invented'}, 'community/posts', {content: 'Test'}), 401);
  await rejectsStatus(() => f.call(null, 'community/bookmarks'), 401);
  const group = await f.group();
  const project = await f.project(group.id);
  const visitor = (await f.call(null, 'community')).body;
  assert.equal(visitor.groups[0].name, group.name);
  assert.equal(visitor.groups[0].joined, false);
  assert.equal(visitor.projects[0].id, project.id);
  assert.equal(visitor.projects[0].canManage, false);
  assert.equal(await handleCommunity({endpoint: 'documents', method: 'GET'}), null);
});

test('member posts and their counts, comments and reactions stay out of every visitor response', async t => {
  const f = await fixture(t), group = await f.group();
  const privatePost = (await f.call(f.alice, 'community/posts', {groupId: group.id, visibility: 'members', content: 'Private planning'})).body;
  const publicPost = (await f.call(f.alice, 'community/posts', {groupId: group.id, visibility: 'public', content: 'Public progress'})).body;
  await f.call(f.alice, `community/posts/${privatePost.id}/comments`, {content: 'Private comment'});
  await f.call(f.alice, `community/posts/${privatePost.id}/react`, {});
  for (const viewer of [null, f.bob]) {
    const overview = (await f.call(viewer, 'community')).body;
    assert.deepEqual(overview.posts.map(post => post.id), [publicPost.id]);
    assert.equal(overview.groups[0].postCount, 1);
    const detail = (await f.call(viewer, `community/groups/${group.id}`)).body;
    assert.equal(detail.group.postCount, 1);
    assert.deepEqual(detail.posts.map(post => post.id), [publicPost.id]);
    assert.ok(!JSON.stringify(detail).includes('Private'));
    await rejectsStatus(() => f.call(viewer, `community/posts/${privatePost.id}`), 404);
  }
  for (const action of ['comments', 'react']) {
    await rejectsStatus(() => f.call(f.bob, `community/posts/${privatePost.id}/${action}`, {content: 'Intrusion'}), 404);
  }
  await rejectsStatus(() => f.call(f.bob, 'community/reports', {postId: privatePost.id, reason: 'Guessing an ID'}), 404);
  await f.call(f.bob, `community/groups/${group.id}/join`, {});
  assert.equal((await f.call(f.bob, 'community')).body.groups[0].postCount, 2);
  const visible = (await f.call(f.bob, `community/posts/${privatePost.id}`)).body;
  assert.equal(visible.post.reactionCount, 1);
  assert.equal(visible.comments[0].content, 'Private comment');
  await f.call(f.bob, `community/groups/${group.id}/leave`, {});
  await rejectsStatus(() => f.call(f.bob, `community/posts/${privatePost.id}`), 404);
  await rejectsStatus(() => f.call(f.alice, `community/groups/${group.id}/leave`, {}), 409);
});

test('groups and projects enforce membership, scope consistency, and immediate revocation', async t => {
  const f = await fixture(t), group = await f.group(), project = await f.project(group.id);
  await rejectsStatus(() => f.project(group.id, f.bob), 403);
  await rejectsStatus(() => f.call(f.bob, `community/projects/${project.id}/join`, {}), 403);
  await rejectsStatus(() => f.call(f.bob, 'community/posts', {groupId: group.id, content: 'Not a member'}), 403);
  const privatePost = (await f.call(f.alice, 'community/posts', {projectId: project.id, visibility: 'members', content: 'Project planning'})).body;
  await f.call(f.bob, `community/groups/${group.id}/join`, {});
  assert.equal((await f.call(f.bob, `community/projects/${project.id}`)).body.project.postCount, 0);
  await rejectsStatus(() => f.call(f.bob, `community/posts/${privatePost.id}`), 404);
  await rejectsStatus(() => f.call(f.bob, 'community/posts', {projectId: project.id, content: 'Not on project yet'}), 403);
  await f.call(f.bob, `community/projects/${project.id}/join`, {});
  assert.equal((await f.call(f.bob, `community/projects/${project.id}`)).body.posts.length, 1);
  await f.call(f.bob, 'community/posts', {projectId: project.id, visibility: 'members', content: 'I can help'});
  const otherGroup = await f.group(f.bob);
  await rejectsStatus(() => f.call(f.bob, 'community/posts', {projectId: project.id, groupId: otherGroup.id, content: 'Wrong group'}), 400);
  await f.call(f.bob, `community/groups/${group.id}/leave`, {});
  assert.equal((await f.call(f.bob, `community/projects/${project.id}`)).body.project.joined, false);
  await rejectsStatus(() => f.call(f.bob, `community/posts/${privatePost.id}`), 404);
  await rejectsStatus(() => f.call(f.bob, 'community/posts', {projectId: project.id, content: 'After leaving'}), 403);
  await rejectsStatus(() => f.call(f.bob, 'community/posts', {visibility: 'members', content: 'No scope'}), 400);
});

test('repository and progress changes require ownership and repository permission is rechecked after fetching', async t => {
  const f = await fixture(t), group = await f.group();
  await f.call(f.bob, `community/groups/${group.id}/join`, {});
  const project = await f.project(group.id, f.bob);
  let fetches = 0;
  const metadata = {id: 1, url: 'https://github.com/example/code', fullName: 'example/code', license: {spdxId: 'MIT'}, fetchedAt: new Date().toISOString()};
  const fetchRepository = async () => {fetches++; return metadata;};
  await rejectsStatus(() => f.call(f.carol, `community/projects/${project.id}/repository`, {url: metadata.url}, {fetchRepository}), 403);
  assert.equal(fetches, 0);
  const linked = await f.call(f.alice, `community/projects/${project.id}/repository`, {url: metadata.url}, {fetchRepository});
  assert.equal(linked.body.repository.id, 1);
  assert.equal(linked.body.repositoryLinkedBy, f.alice.id);
  const changed = await f.call(f.bob, `community/projects/${project.id}/settings`, {stage: 'building', helpNeeded: 'A browser engineer'});
  assert.equal(changed.body.stage, 'building');
  await rejectsStatus(() => f.call(f.carol, `community/projects/${project.id}/settings`, {stage: 'shipped'}), 403);
  await rejectsStatus(() => f.call(f.bob, `community/projects/${project.id}/settings`, {stage: 'pretend'}), 400);
  await rejectsStatus(() => f.call(f.bob, `community/projects/${project.id}/repository`, {url: metadata.url}, {
    fetchRepository: async () => {
      await f.store.transaction(state => {state.projects.find(record => record.id === project.id).owner = f.carol.id;});
      return {...metadata, id: 2};
    },
  }), 403);
  assert.equal(f.store.read().projects.find(record => record.id === project.id).repository.id, 1);
  const removed = await f.call(f.alice, `community/projects/${project.id}/repository`, {url: ''}, {fetchRepository});
  assert.equal(removed.body.repository, null);
});

test('comments, likes, bookmarks and soft deletion persist and stay scoped to their owner or visible post', async t => {
  const f = await fixture(t), group = await f.group();
  const post = (await f.call(f.alice, 'community/posts', {groupId: group.id, content: 'A public update', ideaAddress: '1a'})).body;
  await f.call(f.bob, `community/posts/${post.id}/comments`, {content: 'Interested in helping'});
  assert.deepEqual((await f.call(f.bob, `community/posts/${post.id}/react`, {})).body, {reacted: true, reactionCount: 1});
  assert.deepEqual((await f.call(f.bob, `community/posts/${post.id}/react`, {})).body, {reacted: false, reactionCount: 0});
  await f.call(f.bob, `community/posts/${post.id}/react`, {});
  await f.call(f.bob, 'community/bookmarks', {ideaAddress: '1a'});
  assert.equal((await f.call(f.alice, 'community/bookmarks')).body.length, 0);
  const reopened = f.reopen();
  const persisted = await f.call(f.bob, `community/posts/${post.id}`, undefined, {store: reopened});
  assert.equal(persisted.body.post.reacted, true);
  assert.equal(persisted.body.post.commentCount, 1);
  assert.equal(persisted.body.comments[0].author.name, 'Bob');
  assert.equal((await f.call(f.bob, 'community/bookmarks', undefined, {store: reopened})).body[0].ideaAddress, '1a');
  await rejectsStatus(() => f.call(f.bob, `community/posts/${post.id}/remove`, {}), 403);
  await f.call(f.bob, 'community/reports', {postId: post.id, reason: 'Needs a source'});
  await f.call(f.bob, 'community/reports', {postId: post.id, reason: 'Duplicate report'});
  assert.equal(f.store.read().reports.length, 1);
  await f.call(f.alice, `community/posts/${post.id}/remove`, {});
  assert.equal(f.store.read().posts[0].deleted, true);
  assert.equal((await f.call(null, 'community')).body.posts.length, 0);
  assert.equal((await f.call(null, `community/groups/${group.id}`)).body.group.postCount, 0);
  await rejectsStatus(() => f.call(f.alice, `community/posts/${post.id}`), 404);
});

test('only published ideas can be referenced and sourced submissions remain pending and private', async t => {
  const f = await fixture(t);
  await f.store.transaction(state => state.ideaSubmissions.push({id: 'unreviewed', status: 'pending'}));
  for (const endpoint of ['community/posts', 'community/projects', 'community/bookmarks']) {
    await rejectsStatus(() => f.call(f.alice, endpoint, {ideaAddress: 'unreviewed', content: 'Text', title: 'Title', goal: 'Goal'}), 400);
  }
  await rejectsStatus(() => f.call(f.alice, 'community/posts', {content: 'Text', ideaAddress: '../bad'}), 400);
  await rejectsStatus(() => f.call(f.alice, 'community/groups', {name: '   ', description: 'Test'}), 400);
  await rejectsStatus(() => f.call(f.alice, 'community/posts', {content: 'x'.repeat(5001)}), 400);
  const submission = {title: 'An idea to research', summary: 'Needs evidence review.',
    sourceUrl: 'https://example.org/research', licenseUrl: 'https://example.org/LICENSE'};
  for (const sourceUrl of ['javascript:alert(1)', 'http://example.org/paper', 'https://name:password@example.org/paper']) {
    await rejectsStatus(() => f.call(f.alice, 'community/ideas', {...submission, sourceUrl}), 400);
  }
  const result = (await f.call(f.alice, 'community/ideas', submission)).body;
  assert.equal(result.status, 'pending');
  assert.equal(f.store.read().ideaSubmissions.length, 2);
  assert.equal(f.store.read().ideaSubmissions.find(item => item.id === result.id).status, 'pending');
  const visitor = (await f.call(null, 'community')).body;
  assert.ok(!JSON.stringify(visitor).includes(submission.title));
  await rejectsStatus(() => f.call(f.alice, 'community/bookmarks', {ideaAddress: result.id}), 400);
  await rejectsStatus(() => f.call(f.bob, `community/ideas/${result.id}`), 404);
});
