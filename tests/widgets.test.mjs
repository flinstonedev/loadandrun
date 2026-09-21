import test from 'node:test';
import assert from 'node:assert/strict';
import {WIDGET_TYPES, WIDGET_DEFAULTS, normalizeWidget, safeLink} from '../src/widget-schema.js';

test('all seven widget types have independent usable defaults', () => {
  assert.deepEqual(WIDGET_TYPES, ['notes', 'links', 'tasks', 'ideas', 'repositories', 'videos', 'recommendations']);
  for (const type of WIDGET_TYPES) {
    const first = normalizeWidget({type});
    const second = normalizeWidget({type});
    assert.equal(first.type, type);
    assert.equal(first.includeInAI, true);
    assert.equal(first.collapsed, false);
    assert.ok([1, 2, 3].includes(first.width));
    if (first.content.items) first.content.items.push({id: 'local-draft'});
    else first.content.markdown = 'Local draft';
    assert.deepEqual(second.content, WIDGET_DEFAULTS[type].content);
  }
});

test('updates preserve identity and reject changing a widget type', () => {
  const old = {...normalizeWidget({type: 'notes', content: {markdown: 'A draft'}}), id: 'widget-1', spaceId: 'space-1', revision: 4};
  const next = normalizeWidget({title: 'Renamed', width: 3, includeInAI: false}, old);
  assert.equal(next.id, old.id);
  assert.equal(next.revision, 4);
  assert.equal(next.content.markdown, 'A draft');
  assert.equal(next.includeInAI, false);
  assert.throws(() => normalizeWidget({type: 'links'}, old), /cannot be changed/);
});

test('rejects unsafe links and embedded credentials while preserving normal links', () => {
  for (const value of ['javascript:alert(1)', 'data:text/html,hello', 'file:///etc/passwd', 'https://user:secret@example.com/path', 'https://example.com/\u0000bad']) {
    assert.throws(() => safeLink(value), {status: 400});
  }
  assert.equal(safeLink('https://example.com/?q=hello#section'), 'https://example.com/?q=hello#section');
});

test('collections reject malformed, duplicate and oversized items', () => {
  assert.throws(() => normalizeWidget({type: 'links', content: {items: Array(201).fill({url: 'https://example.com'})}}), /200/);
  assert.throws(() => normalizeWidget({type: 'tasks', content: {items: [{id: 'same', text: 'a'}, {id: 'same', text: 'b'}]}}), /unique/);
  assert.throws(() => normalizeWidget({type: 'tasks', content: {items: ['oops']}}), /object/);
  assert.throws(() => normalizeWidget({type: 'tasks', content: {items: [{id: '../outside', text: 'a'}]}}), /Item IDs/);
  assert.throws(() => normalizeWidget({type: 'notes', content: {markdown: 'x'.repeat(50001)}}), /50000/);
});

test('widget settings enforce actual booleans and supported widths', () => {
  for (const settings of [{width: 4}, {width: '2'}, {collapsed: 'false'}, {includeInAI: 1}, {title: ''}, {config: []}]) {
    assert.throws(() => normalizeWidget({type: 'notes', ...settings}), {status: 400});
  }
  assert.throws(() => normalizeWidget({type: 'tasks', config: {showCompleted: 'false'}}), {status: 400});
});

test('unverified client metadata cannot become trusted repository metadata', () => {
  const forged = normalizeWidget({type: 'repositories', content: {items: [{id: 'repo', url: 'https://github.com/openai/codex', notes: 'Read it', metadata: {title: 'Forged', verifiedAt: 'today'}}]}});
  assert.equal(forged.content.items[0].metadata, undefined);
  const existing = {...forged, content: {items: [{...forged.content.items[0], metadata: {title: 'Verified', url: 'https://github.com/openai/codex'}}]}};
  assert.equal(normalizeWidget({content: {items: [{...forged.content.items[0], metadata: {title: 'Forged'}}]}}, existing).content.items[0].metadata.title, 'Verified');
  assert.equal(normalizeWidget({content: {items: [{...forged.content.items[0], url: 'https://github.com/another/repo'}]}}, existing).content.items[0].metadata, undefined);
});

test('recommendation results and dismissal history cannot be overwritten by widget edits', () => {
  const old = normalizeWidget({type: 'recommendations'});
  old.content = {items: [{id: 'github:1', url: 'https://github.com/openai/codex'}], dismissedUrls: ['https://github.com/example/old']};
  const updated = normalizeWidget({content: {items: [{id: 'fake', url: 'https://evil.example'}], dismissedUrls: []}, config: {topic: 'Distributed storage'}}, old);
  assert.deepEqual(updated.content, old.content);
  assert.notEqual(updated.content, old.content);
  assert.equal(updated.config.topic, 'Distributed storage');
});

test('recommendation configuration bounds sources and result counts', () => {
  for (const config of [{sources: []}, {sources: ['web']}, {perSource: 0}, {perSource: 6}, {perSource: 1.5}]) assert.throws(() => normalizeWidget({type: 'recommendations', config}), {status: 400});
  const widget = normalizeWidget({type: 'recommendations', config: {sources: ['github', 'github'], perSource: 2}});
  assert.deepEqual(widget.config.sources, ['github']);
});
