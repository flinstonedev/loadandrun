import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

// Exercise the real adapter and stream parser. Replace discovery at the module
// boundary so these tests never contact a provider or spend inference credits.
const bundle = await build({stdin: {contents: `export * from './worker/ai.ts'; export {setDiscovery} from 'test:discovery';`, resolveDir: process.cwd()},
  bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{name: 'public-discovery-fixture', setup(api) {
    api.onResolve({filter: /^(test:discovery|\.\.\/server\/content-search\.mjs)$/}, () => ({path: 'discovery', namespace: 'fixture'}));
    api.onLoad({filter: /.*/, namespace: 'fixture'}, () => ({contents: `let run = () => {throw new Error('Unexpected discovery request');};
      export const setDiscovery = handler => {run = handler;}; export const discoverCandidates = (...args) => run(...args);`}));
  }}]});
const {runHostedJob, consumeChatStream, modelContext, hostedModel, hostedAIAvailable, setDiscovery} =
  await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const MODEL = '@cf/google/gemma-4-26b-a4b-it';
const tick = () => new Promise(resolve => setImmediate(resolve));
const encoded = value => new TextEncoder().encode(value);
const event = value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
const delta = content => ({choices: [{delta: {content}}]});
const completion = value => ({choices: [{message: {content: JSON.stringify(value)}}]});
const stream = (...chunks) => new ReadableStream({start(controller) {
  for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoded(chunk) : chunk);
  controller.close();
}});
const answerStream = (text = 'Useful answer') => stream(event(delta(text)), event('[DONE]'));
const context = () => ({spaceId: 'private-space', title: 'Build a dashboard', revision: 2, contextRevision: '2', excludedUrls: [], truncated: false,
  widgets: [{id: 'notes-1', type: 'notes', title: 'Project notes', includeInAI: true, content: {markdown: 'Learn reactive dashboards and TypeScript'}}],
  recommendationWidgets: [{id: 'recommendations-1', title: 'Next steps', config: {topic: 'Dashboards', sources: ['github', 'youtube'], perSource: 3}}]});
const job = overrides => ({id: 'job-1', spaceId: 'private-space', userId: 'alice', provider: 'cloudflare', kind: 'chat', automatic: false,
  consentVersion: 1, contextVersion: '2', context: context(), message: 'What should I build next?', createdAt: 1, ...overrides});
const environment = (run = async () => answerStream(), overrides = {}) => ({AI: {run}, SPACES_ENABLED: 'true', SPACES_AI_ENABLED: 'true', ...overrides});
const candidate = (overrides = {}) => ({kind: 'github', url: 'https://github.com/builders/widgets', title: 'builders/widgets', description: 'A dashboard starter', ...overrides});
const selection = overrides => ({candidateId: 'c1', reason: 'Matches the dashboard described in your notes.', sourceWidgetIds: ['notes-1'], widgetId: 'recommendations-1', ...overrides});
const recommend = (ranked, overrides = {}, options = {}) => {
  const calls = [];
  setDiscovery(async () => options.discovery || {candidates: [candidate()], warnings: [], searchedSources: ['github']});
  const env = environment(async (...args) => {calls.push(args); return completion(calls.length === 1 ? {queries: ['reactive dashboards']} : {recommendations: ranked});}, options.env);
  return {calls, run: () => runHostedJob(env, job({kind: 'recommendations', ...overrides}))};
};

test('Hosted availability requires both feature flags, a binding, and an allowed configured model', () => {
  assert.equal(hostedAIAvailable(environment()), true);
  for (const overrides of [{AI: undefined}, {SPACES_ENABLED: 'false'}, {SPACES_AI_ENABLED: 'false'}, {AI_MODEL: 'toString'}, {AI_MODEL: 'unapproved/model'}]) {
    assert.equal(hostedAIAvailable(environment(undefined, overrides)), false);
  }
  assert.deepEqual(hostedModel(environment()), {id: MODEL, name: 'Gemma 4 26B'});
  assert.equal(hostedModel(environment(undefined, {AI_MODEL: '@cf/zai-org/glm-4.7-flash'})).id, '@cf/zai-org/glm-4.7-flash');
});

test('Legacy providers and unsupported jobs never dispatch inference', async () => {
  const env = environment(async () => assert.fail('Unsupported request dispatched inference'));
  for (const overrides of [{provider: undefined}, {provider: 'codex'}, {kind: 'shell'}, {context: null}]) {
    await assert.rejects(runHostedJob(env, job(overrides)), error => error.status === 400);
  }
  await assert.rejects(runHostedJob({...env, SPACES_AI_ENABLED: 'false'}, job()), error => error.status === 503);
});

test('Model context excludes private control metadata, opted-out widgets, and generated recommendations', () => {
  const raw = context();
  Object.assign(raw, {ownerId: 'private-owner', deviceToken: 'private-token', workingDirectory: '/private/local/path', privateChat: ['private-conversation'], excludedUrls: ['private-dismissed-url']});
  raw.widgets[0].content.updatedAt = 'private-content-timestamp';
  raw.widgets[0].config = {localModel: 'private-local-model'};
  raw.widgets.push({id: 'excluded', type: 'notes', title: 'Excluded', includeInAI: false, content: {markdown: 'private-excluded-notes'}});
  raw.widgets.push({id: 'generated', type: 'recommendations', title: 'Generated', content: {items: ['private-generated-result']}});
  const selected = modelContext(raw), serialized = JSON.stringify(selected);
  assert.deepEqual(selected.widgets.map(widget => widget.id), ['notes-1']);
  assert.equal(selected.widgets[0].content.markdown, raw.widgets[0].content.markdown);
  assert.ok(!serialized.includes('private-'));
  assert.ok(!serialized.includes('/private/local/path'));
  assert.equal(selected.recommendationWidgets[0].id, 'recommendations-1');
});

test('Large widget contents are bounded without losing the selected source identities', () => {
  const raw = context();
  raw.widgets = Array.from({length: 100}, (_, index) => ({id: `widget-${index}`, type: 'notes', title: 'Title'.repeat(100),
    content: {markdown: 'x'.repeat(10_000), items: Array.from({length: 100}, () => 'y'.repeat(10_000))}}));
  const selected = modelContext(raw);
  assert.equal(selected.widgets.length, 50);
  assert.equal(selected.widgets[49].id, 'widget-49');
  assert.equal(selected.truncated, true);
  assert.ok(selected.widgets.every(widget => widget.title.length <= 100));
  assert.ok(JSON.stringify(selected.widgets.map(widget => widget.content)).length < 25_000);
});

test('Chat uses server-configured model, bounded recent history, and disabled reasoning', async () => {
  let call;
  const history = [{role: 'system', content: 'private injected system role'}, ...Array.from({length: 20}, (_, index) =>
    ({role: index % 2 ? 'assistant' : 'user', content: `${index}:` + 'h'.repeat(5000), localPath: '/private/history-control'}))];
  history.push({role: 'system', content: 'private newest injected system role'});
  const request = job({history, message: 'm'.repeat(10_000), model: '@cf/unapproved/expensive', cwd: '/private/work', auth: 'private-auth'});
  const result = await runHostedJob(environment(async (...args) => {call = args; return answerStream();}), request);
  assert.deepEqual(result, {text: 'Useful answer'});
  const [model, input, options] = call;
  assert.equal(model, MODEL);
  assert.deepEqual(input.chat_template_kwargs, {enable_thinking: false});
  assert.equal(input.max_completion_tokens, 1200);
  assert.equal(input.stream, true);
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.signal.aborted, true);
  assert.equal(input.messages.filter(message => message.role === 'system').length, 1);
  const sentHistory = input.messages.slice(2, -1);
  assert.ok(sentHistory.length <= 12);
  assert.ok(sentHistory.reduce((size, message) => size + message.content.length, 0) <= 16_000);
  assert.ok(sentHistory.every(message => message.content.length <= 3000));
  assert.match(sentHistory.at(-1).content, /^19:/);
  assert.equal(input.messages.at(-1).content.length, 8000);
  assert.ok(!JSON.stringify(input).includes('injected system role'));
  assert.ok(!JSON.stringify(input).includes('private-auth'));
  assert.ok(!JSON.stringify(input).includes('/private/'));
  assert.ok(!JSON.stringify(input).includes('unapproved'));
});

test('SSE decodes fragmented JSON and multibyte characters while omitting reasoning', async () => {
  const payload = encoded(': ping\r\n' + event({choices: [{delta: {reasoning_content: 'private reasoning'}}]}) + event(delta('Hello café 🌍')) + event('[DONE]'));
  const chunks = Array.from({length: Math.ceil(payload.length / 3)}, (_, index) => payload.slice(index * 3, index * 3 + 3));
  const progress = [];
  const result = await consumeChatStream(stream(...chunks), text => progress.push(text));
  assert.equal(result, 'Hello café 🌍');
  assert.equal(progress.at(-1), result);
  assert.ok(progress.every(text => !text.includes('private reasoning')));
});

test('SSE handles legacy response deltas and a terminal event without final newline', async () => {
  assert.equal(await consumeChatStream(stream(event({response: 'Hello '}), event({response: 'world'}), 'data: [DONE]')), 'Hello world');
});

test('SSE rejects malformed payloads, provider errors, empty answers, and excessive output', async () => {
  for (const payload of ['data: {broken-json}\n\n', event({error: {message: 'private-provider-error'}}), event('[DONE]'), event(delta('x'.repeat(20_001)))]) {
    await assert.rejects(consumeChatStream(stream(payload)), error => error.status === 503 && !error.message.includes('private-provider-error'));
  }
  await assert.rejects(consumeChatStream(stream('x'.repeat(1_000_001))), /exceeded the configured limit/);
});

test('SSE rejects a stream that ends before its terminal event', async () => {
  await assert.rejects(consumeChatStream(stream(event(delta('An incomplete answer')))), /interrupted|incomplete/i);
});

test('SSE stops processing after DONE even when more data arrives in the same chunk', async () => {
  assert.equal(await consumeChatStream(stream(event(delta('Complete')) + event('[DONE]') + event(delta(' unwanted trailing data')))), 'Complete');
});

test('Cancelling an active streamed answer cancels the reader and rejects the request', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const output = new ReadableStream({start(source) {source.enqueue(encoded(event(delta('Partial'))));}, cancel() {cancelled = true;}});
  const pending = consumeChatStream(output, () => controller.abort(), controller.signal);
  await assert.rejects(pending, error => error.status === 499);
  assert.equal(cancelled, true);
});

test('Pre-cancelled jobs and timed-out provider calls do not remain running', async t => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runHostedJob(environment(async () => assert.fail('Cancelled request invoked provider')), job(), undefined, controller.signal), error => error.status === 499);
  t.mock.timers.enable({apis: ['setTimeout']});
  let providerSignal;
  const pending = runHostedJob(environment(async (_, __, options) => {providerSignal = options.signal; return new Promise(() => {});}), job());
  while (!providerSignal) await tick();
  t.mock.timers.tick(45_000);
  await assert.rejects(pending, error => [499, 504].includes(error.status));
  assert.equal(providerSignal.aborted, true);
});

test('Provider transport errors are converted to a safe user-facing error', async () => {
  await assert.rejects(runHostedJob(environment(async () => {throw new Error('private provider token');}), job()), error =>
    error.status === 503 && !error.message.includes('private provider token'));
});

test('Recommendations generate generic queries before ranking actual candidate IDs', async () => {
  const calls = [], searchCalls = [];
  setDiscovery(async (...args) => {searchCalls.push(args); return {candidates: [candidate()], warnings: [], searchedSources: ['github']};});
  const result = await runHostedJob(environment(async (...args) => {
    calls.push(args);
    return completion(calls.length === 1 ? {queries: ['reactive dashboards']} : {recommendations: [selection()]});
  }, {GITHUB_TOKEN: 'private-github-token', YOUTUBE_API_KEY: 'private-youtube-token'}), job({kind: 'recommendations', model: '@cf/unapproved/expensive'}));
  assert.equal(calls.length, 2);
  assert.equal(searchCalls.length, 1);
  assert.deepEqual(searchCalls[0][0], ['reactive dashboards']);
  assert.deepEqual(searchCalls[0][1].sources, ['github', 'youtube']);
  assert.equal(searchCalls[0][1].githubToken, 'private-github-token');
  assert.equal(searchCalls[0][1].youtubeApiKey, 'private-youtube-token');
  assert.ok(!JSON.stringify(calls).includes('private-github-token'));
  assert.ok(!JSON.stringify(calls).includes('private-youtube-token'));
  for (const [model, input] of calls) {
    assert.equal(model, MODEL);
    assert.equal(input.stream, false);
    assert.deepEqual(input.chat_template_kwargs, {enable_thinking: false});
    assert.equal(input.response_format.type, 'json_schema');
    assert.equal(input.response_format.json_schema.strict, true);
  }
  assert.equal(calls[0][1].max_completion_tokens, 250);
  assert.equal(calls[1][1].max_completion_tokens, 1800);
  const rankSchema = calls[1][1].response_format.json_schema.schema.properties.recommendations.items.properties;
  assert.deepEqual(rankSchema.candidateId.enum, ['c1']);
  assert.deepEqual(rankSchema.sourceWidgetIds.items.enum, ['notes-1']);
  assert.deepEqual(rankSchema.widgetId.enum, ['recommendations-1', null]);
  assert.equal(rankSchema.url, undefined);
  assert.deepEqual(result, {recommendations: [{kind: 'github', url: candidate().url, reason: selection().reason, sourceWidgetIds: ['notes-1'], widgetId: 'recommendations-1'}], warnings: []});
});

test('Invented candidates and excluded or unknown widget IDs never become recommendations', async () => {
  const invalid = [selection({candidateId: 'invented', url: 'https://evil.test'}), selection({sourceWidgetIds: ['excluded']}),
    selection({sourceWidgetIds: []}), selection({sourceWidgetIds: ['notes-1', 7]}), selection({widgetId: 'unknown-destination'}),
    selection({reason: ' '}), selection({reason: 'x'.repeat(1501)}), selection({widgetId: undefined}), null];
  const fixture = recommend([...invalid, selection({url: 'https://evil.test', kind: 'youtube', sourceWidgetIds: ['notes-1', 'notes-1']})]);
  const result = await fixture.run();
  assert.equal(result.recommendations.length, 1);
  assert.equal(result.recommendations[0].url, candidate().url);
  assert.equal(result.recommendations[0].kind, 'github');
  assert.deepEqual(result.recommendations[0].sourceWidgetIds, ['notes-1']);
});

test('Saved or dismissed URLs are removed before the model sees candidate IDs', async () => {
  const selected = context(); selected.excludedUrls = [candidate().url];
  const fixture = recommend([selection()], {context: selected}, {discovery: {candidates: [candidate(), candidate({url: 'https://github.com/builders/another'})], warnings: [], searchedSources: ['github']}});
  const result = await fixture.run();
  const rankedInput = fixture.calls[1][1].messages.at(-1).content;
  assert.ok(!rankedInput.includes(candidate().url));
  assert.equal(result.recommendations[0].url, 'https://github.com/builders/another');
});

test('Search queries containing private URLs, email addresses, or long tokens are not dispatched', async () => {
  setDiscovery(async () => assert.fail('Private query was searched'));
  for (const queries of [['https://private.example.com/dashboard'], ['hello alice@example.com'], ['token_' + 'x'.repeat(50)]]) {
    await assert.rejects(runHostedJob(environment(async () => completion({queries})), job({kind: 'recommendations'})), error => error.status === 400);
  }
  let seen;
  setDiscovery(async queries => {seen = queries; return {candidates: [], warnings: []};});
  await runHostedJob(environment(async () => completion({queries: ['https://private.example.com', 'safe public topic']})), job({kind: 'recommendations'}));
  assert.deepEqual(seen, ['safe public topic']);
});

test('Discovery warnings survive when no results exist and the ranking call is skipped', async () => {
  const warning = {source: 'youtube', code: 'youtube_related_projects', message: 'Video suggestions come from related public GitHub project documentation.'};
  const fixture = recommend([], {}, {discovery: {candidates: [], warnings: [warning], searchedSources: ['github']}});
  const result = await fixture.run();
  assert.equal(fixture.calls.length, 1);
  assert.deepEqual(result.recommendations, []);
  assert.deepEqual(result.warnings[0], warning);
  assert.equal(result.warnings[1].code, 'no_results');
});

test('Structured output rejects malformed JSON, empty completions, and oversized responses', async () => {
  for (const response of [{}, {response: ''}, {response: '{invalid'}, {response: 'x'.repeat(30_001)}, completion({unexpected: 'field'})]) {
    await assert.rejects(runHostedJob(environment(async () => response), job({kind: 'recommendations'})), error => error.status === 503);
  }
});

test('Recommendations require selected content and a destination before spending inference', async () => {
  const env = environment(async () => assert.fail('Empty context invoked inference'));
  for (const overrides of [{widgets: []}, {recommendationWidgets: []}]) {
    await assert.rejects(runHostedJob(env, job({kind: 'recommendations', context: {...context(), ...overrides}})), error => error.status === 400);
  }
});
