import test from 'node:test';
import assert from 'node:assert/strict';
import {renderMarkdown, safeLink, moveWidget, createSpacesApp} from '../src/spaces.js';

test('notes and chat Markdown render formatting while treating HTML as text', () => {
  const html = renderMarkdown('# A direction\n**Build** something with `code`\n- Read a source\n- Try a small step\n<script>alert(1)</script>\n```html\n<img src=x onerror=alert(1)>\n```');
  assert.match(html, /<h3>A direction<\/h3>/);
  assert.match(html, /<strong>Build<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<ul><li>Read a source<\/li><li>Try a small step<\/li><\/ul>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script|<img|onerror="/);
});

test('notes links reject executable schemes, credentials, and embedded control characters', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,test', 'file:///tmp/private', 'https://name:password@example.com', 'https://exa\nmple.com']) assert.equal(safeLink(url), '');
  assert.equal(safeLink('https://example.com/path?x=1&y=2'), 'https://example.com/path?x=1&y=2');
  const html = renderMarkdown('[Unsafe](javascript:run) [Source](https://example.com/?x=1&y=2)');
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /href="https:\/\/example.com\/\?x=1&amp;y=2" target="_blank" rel="noopener noreferrer"/);
  assert.match(renderMarkdown('`[x](https://example.com)`'), /<code>\[x\]\(https:\/\/example.com\)<\/code>/);
});

test('keyboard and pointer reordering share deterministic non-mutating movement', () => {
  const layout = ['a','b','c','d'];
  assert.deepEqual(moveWidget(layout, 'a', 2), ['b','c','a','d']);
  assert.deepEqual(moveWidget(layout, 'c', 0), ['c','a','b','d']);
  assert.deepEqual(moveWidget(layout, 'b', 99), ['a','c','d','b']);
  assert.deepEqual(moveWidget(layout, 'b', -3), ['b','a','c','d']);
  assert.deepEqual(moveWidget(layout, 'missing', 1), layout);
  assert.deepEqual(layout, ['a','b','c','d']);
});


// Exercise the app boundary without starting a browser or a live AI request.
function spacesHarness(t, {available = true, role = 'owner', consent = false, search = '', archivedMessages = []} = {}) {
  const calls = [], listeners = new Map(), notices = [];
  const page = {innerHTML: '', classList: {add() {}}}, modalNode = {open: false, innerHTML: ''};
  const messageInput = {focus() {}}, log = {scrollTop: 0, scrollHeight: 0}, dialogForm = {};
  const snapshot = {space: {id: 'space-1', title: 'Research', role, settings: {aiConsent: consent, automaticRecommendations: false}, members: []}, widgets: [], layout: []};
  const status = {provider: 'cloudflare', available, model: {id: 'test-model', name: 'Test <model>'}, jobs: [], usage: {manualRuns: 3, manualLimit: 40, automaticRuns: 2, automaticLimit: 12}};
  const replacements = {
    document: {querySelector(selector) {return {'#page': page, '#modal': modalNode, '#space-chat-message': page.innerHTML.includes('id="space-chat-message"') ? messageInput : null, '#space-chat-log': page.innerHTML.includes('id="space-chat-log"') ? log : null, '#space-dialog-form': dialogForm}[selector] || null;}, addEventListener(name, callback) {listeners.set(name, callback);}, activeElement: null, getElementById() {return null;}},
    window: {addEventListener() {}}, location: {origin: 'https://loadandrun.test', protocol: 'https:', search},
    matchMedia: () => ({matches: false}),
    WebSocket: class {static OPEN = 1; readyState = 0; close() {}},
  };
  for (const [key, value] of Object.entries(replacements)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {value, configurable: true, writable: true});
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key]);
  }
  const app = createSpacesApp({
    getSession: () => ({features: {spaces: true}, user: {id: 'user-1', name: 'Builder'}}),
    getCatalog: () => [], toast: value => notices.push(value), close() {modalNode.open = false;}, formError: error => {throw error;}, requireAccount: action => action(),
    modal(title, html) {modalNode.open = true;modalNode.innerHTML = html;},
    async api(path, body) {
      calls.push({path, body});
      if (path === 'agent/status') return status;
      if (path === 'spaces/space-1') return snapshot;
      if (path === 'agent/chat?spaceId=space-1') return {messages: [], archivedMessages};
      if (path === 'agent/chat' && body) return {jobId: 'reply-1', status: 'queued', messages: [{role: 'user', text: body.message}]};
      throw Error('Unexpected API request: ' + path);
    },
  });
  t.after(() => app.dispose());
  async function click(action) {
    const source = {dataset: {spaceAction: action}};
    listeners.get('click')({preventDefault() {}, target: {closest(selector) {return selector === '[data-space-action]' ? source : null;}}});
    await new Promise(resolve => setImmediate(resolve));
  }
  return {app, page, calls, modalNode, notices, status, click, listeners};
}

test('legacy connection links open hosted AI status without pairing or local setup requests', async t => {
  const ui = spacesHarness(t, {search: '?pair=retired-device'});
  await ui.app.render('/spaces/connect');
  assert.deepEqual(ui.calls.map(call => call.path), ['agent/status']);
  assert.match(ui.page.innerHTML, /CLOUDFLARE AI/);
  assert.match(ui.page.innerHTML, /Ready to help/);
  assert.match(ui.page.innerHTML, /Test &lt;model&gt;/);
  assert.match(ui.page.innerHTML, /3 of 40/);
  assert.match(ui.page.innerHTML, /2 of 12/);
  assert.doesNotMatch(ui.page.innerHTML, /Codex|ChatGPT|pair-approve|npm install|<select/);
  ui.status.available = false;
  await ui.click('ai-status-refresh');
  assert.match(ui.page.innerHTML, /Temporarily unavailable/);
});

test('private AI chat works without a companion and sends only the message and space', async t => {
  const ui = spacesHarness(t, {archivedMessages: [{role: 'user', text: 'Earlier private context'}, {role: 'assistant', text: 'Earlier helpful reply'}]});
  await ui.app.render('/spaces/space-1');
  await ui.click('chat-toggle');
  assert.match(ui.page.innerHTML, /Ask AI/);
  assert.match(ui.page.innerHTML, /<details class="space-chat-archive" id="space-chat-archive" >/);
  assert.match(ui.page.innerHTML, /Earlier private context/);
  assert.match(ui.page.innerHTML, /read-only history is not sent to Cloudflare AI/);
  assert.match(ui.page.innerHTML, /conversation is visible only to you/);
  assert.match(ui.page.innerHTML, /By sending, you agree to send this conversation and included widget content to Cloudflare AI/);
  assert.match(ui.page.innerHTML, /Long spaces may be shortened/);
  assert.doesNotMatch(ui.page.innerHTML, /Codex|ChatGPT|<select/);
  ui.listeners.get('input')({target: {id: 'space-chat-message', value: 'What should I explore?'}});
  ui.listeners.get('submit')({preventDefault() {}, target: {id: 'space-chat-form', dataset: {}, querySelector() {return {disabled: false};}}});
  await new Promise(resolve => setImmediate(resolve));
  const request = ui.calls.find(call => call.path === 'agent/chat');
  assert.deepEqual(request.body, {spaceId: 'space-1', message: 'What should I explore?'});
  assert.match(ui.page.innerHTML, /Your message is queued/);
  assert.match(ui.page.innerHTML, /<button class="primary" disabled>Send message/);
});

test('unavailable AI shows a reason and disables sending without offering a local connection', async t => {
  const ui = spacesHarness(t, {available: false});
  await ui.app.render('/spaces/space-1');
  await ui.click('chat-toggle');
  assert.match(ui.page.innerHTML, /AI is temporarily unavailable/);
  assert.match(ui.page.innerHTML, /<button class="primary" disabled>Send message/);
  assert.doesNotMatch(ui.page.innerHTML, /Queue message|Connect local/);
});

test('recommendation refresh requires the owner’s new hosted consent before dispatching work', async t => {
  const ui = spacesHarness(t);
  await ui.app.render('/spaces/space-1');
  await ui.click('refresh-recommendations');
  assert.equal(ui.modalNode.open, true);
  assert.match(ui.modalNode.innerHTML, /Send included widget content to Cloudflare AI/);
  assert.match(ui.modalNode.innerHTML, /derived topics in public content searches for GitHub projects and YouTube videos/);
  assert.doesNotMatch(ui.modalNode.innerHTML, /name="aiConsent" checked/);
  assert.equal(ui.calls.some(call => call.path.endsWith('/recommendations')), false);
});
