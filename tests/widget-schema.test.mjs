import test from 'node:test';
import assert from 'node:assert/strict';
import {WIDGET_TYPES, WIDGET_DEFAULTS, normalizeWidget, safeLink} from '../src/widget-schema.js';

const rejects = action => assert.throws(action, error => error.status === 400);

test('All seven widgets have isolated data defaults and safe presentation settings', () => {
  assert.deepEqual(WIDGET_TYPES, ['notes', 'links', 'tasks', 'ideas', 'repositories', 'videos', 'recommendations']);
  for (const type of WIDGET_TYPES) {
    const widget = normalizeWidget({type});
    assert.equal(widget.type, type);
    assert.equal(widget.title, WIDGET_DEFAULTS[type].title);
    assert.equal(widget.width, type === 'notes' ? 2 : 1);
    assert.equal(widget.collapsed, false);
    assert.equal(widget.includeInAI, true);
    if (widget.content.items) widget.content.items.push({id: 'local-only'});
    assert.equal(normalizeWidget({type}).content.items?.length || 0, 0);
  }
});

test('Widget types are immutable and server identities survive permitted setting updates', () => {
  const original = {...normalizeWidget({type: 'notes'}), id: 'server-widget', revision: 7, createdAt: 'server-time'};
  const changed = normalizeWidget({id: 'forged-widget', revision: 999, createdAt: 'forged-time', title: ' Edited ', width: 3,
    collapsed: true, includeInAI: false, content: {markdown: 'A draft'}}, original);
  assert.equal(changed.id, 'server-widget');
  assert.equal(changed.revision, 7);
  assert.equal(changed.createdAt, 'server-time');
  assert.equal(changed.title, 'Edited');
  assert.equal(changed.content.markdown, 'A draft');
  assert.equal(changed.includeInAI, false);
  rejects(() => normalizeWidget({type: 'links'}, original));
  rejects(() => normalizeWidget({type: 'script'}));
  rejects(() => normalizeWidget(null));
  rejects(() => normalizeWidget([]));
});

test('Notes and collection items retain only the supported data fields', () => {
  const notes = normalizeWidget({type: 'notes', content: {markdown: '<script>stored as text</script>', html: '<iframe/>', javascript: 'run()'},
    config: {preview: true, onClick: 'run()'}, execute: 'run()'});
  assert.deepEqual(notes.content, {markdown: '<script>stored as text</script>'});
  assert.deepEqual(notes.config, {preview: true});
  assert.equal(notes.execute, undefined);
  const tasks = normalizeWidget({type: 'tasks', content: {items: [{text: 'Build prototype', done: true, html: '<script/>', run: 'shell'}]}});
  assert.deepEqual(tasks.content, {items: [{id: 'item-1', text: 'Build prototype', done: true}]});
  const ideas = normalizeWidget({type: 'ideas', content: {items: [{id: 'idea-1', address: 'published-address', annotation: 'Try this next', title: 'spoof'}]}});
  assert.deepEqual(ideas.content, {items: [{id: 'idea-1', address: 'published-address', annotation: 'Try this next'}]});
});

test('Widget content and lists are bounded and IDs cannot collide or contain markup', () => {
  rejects(() => normalizeWidget({type: 'notes', content: {markdown: 'x'.repeat(50001)}}));
  rejects(() => normalizeWidget({type: 'tasks', content: {items: Array.from({length: 201}, (_, i) => ({id: `task-${i}`, text: 'task'}))}}));
  rejects(() => normalizeWidget({type: 'tasks', content: {items: [{id: 'same'}, {id: 'same'}]}}));
  rejects(() => normalizeWidget({type: 'tasks', content: {items: [{id: '<script>'}]}}));
  rejects(() => normalizeWidget({type: 'tasks', content: {items: [null]}}));
  rejects(() => normalizeWidget({type: 'tasks', content: []}));
  rejects(() => normalizeWidget({type: 'notes', title: ' '}));
  rejects(() => normalizeWidget({type: 'notes', title: 'x'.repeat(101)}));
  for (const width of [0, 4, '2', 1.5]) rejects(() => normalizeWidget({type: 'notes', width}));
});

test('Links reject executable schemes, credentials, and embedded control characters', () => {
  assert.equal(safeLink(' https://example.com/project?q=idea#notes '), 'https://example.com/project?q=idea#notes');
  assert.equal(safeLink('http://example.com'), 'http://example.com/');
  for (const url of ['javascript:alert(1)', 'data:text/html,<script/>', 'file:///etc/passwd', 'https://user:password@example.com/',
    'https://example.com/\nprivate', 'https://example.com/\u0000', '/relative', '//example.com', 'not a URL']) rejects(() => safeLink(url));
  const links = normalizeWidget({type: 'links', content: {items: [{url: 'https://example.com', tags: ['idea', 'idea', 'build'], extra: 'ignored'}]}});
  assert.deepEqual(links.content.items[0], {id: 'item-1', url: 'https://example.com/', label: '', description: '', tags: ['idea', 'build']});
  rejects(() => normalizeWidget({type: 'links', content: {items: [{url: 'https://example.com', tags: ['x'.repeat(51)]}]}}));
});

test('Client metadata is discarded while unchanged collection items retain verified metadata', () => {
  for (const type of ['repositories', 'videos']) {
    const url = type === 'repositories' ? 'https://github.com/builders/code' : 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const supplied = {id: 'saved-1', url, notes: 'My note', metadata: {title: 'Fake provider title', html: '<script/>'}};
    const created = normalizeWidget({type, content: {items: [supplied]}});
    assert.equal(created.content.items[0].metadata, undefined);
    const metadata = {title: 'Verified title', verifiedAt: '2026-09-07T12:00:00Z'};
    const existing = {...created, content: {items: [{...created.content.items[0], metadata}]}};
    const edited = normalizeWidget({content: {items: [{...supplied, notes: 'Updated note'}]}}, existing);
    assert.deepEqual(edited.content.items[0].metadata, metadata);
    assert.equal(edited.content.items[0].notes, 'Updated note');
    const moved = normalizeWidget({content: {items: [{...supplied, url: 'https://example.com/changed'}]}}, existing);
    assert.equal(moved.content.items[0].metadata, undefined);
    const differentId = normalizeWidget({content: {items: [{...supplied, id: 'saved-2'}]}}, existing);
    assert.equal(differentId.content.items[0].metadata, undefined);
  }
});

test('Clients cannot insert recommendations or edit dismissal history through widget content', () => {
  const supplied = {items: [{id: 'fake', title: 'Invented', url: 'https://evil.test'}], dismissedUrls: ['https://evil.test']};
  const created = normalizeWidget({type: 'recommendations', content: supplied});
  assert.deepEqual(created.content, {items: [], dismissedUrls: []});
  const serverContent = {items: [{id: 'verified', url: 'https://github.com/builders/code'}], dismissedUrls: ['https://github.com/builders/old']};
  const existing = {...created, content: serverContent};
  const changed = normalizeWidget({content: supplied, config: {topic: 'JavaScript', sources: ['github', 'github'], perSource: 5}}, existing);
  assert.deepEqual(changed.content, serverContent);
  assert.deepEqual(changed.config, {topic: 'JavaScript', sources: ['github'], perSource: 5});
  changed.content.items[0].url = 'https://changed.test';
  assert.equal(serverContent.items[0].url, 'https://github.com/builders/code');
  for (const sources of [[], ['web'], 'github']) rejects(() => normalizeWidget({type: 'recommendations', config: {sources}}));
  for (const perSource of [0, 6, 1.5, '3']) rejects(() => normalizeWidget({type: 'recommendations', config: {perSource}}));
});

test('AI inclusion and presentation booleans require explicit booleans and preserve opt-out', () => {
  const existing = normalizeWidget({type: 'notes', includeInAI: false, collapsed: true, config: {preview: true}});
  const edited = normalizeWidget({title: 'Another title'}, existing);
  assert.equal(edited.includeInAI, false);
  assert.equal(edited.collapsed, true);
  assert.equal(edited.config.preview, true);
  for (const value of ['false', 'true', 0, 1, null]) {
    rejects(() => normalizeWidget({type: 'notes', includeInAI: value}));
    rejects(() => normalizeWidget({type: 'notes', collapsed: value}));
    rejects(() => normalizeWidget({type: 'notes', config: {preview: value}}));
    rejects(() => normalizeWidget({type: 'tasks', config: {showCompleted: value}}));
    rejects(() => normalizeWidget({type: 'tasks', content: {items: [{text: 'Task', done: value}]}}));
  }
});
