// Shared by the browser and Durable Objects. Stored content is data, never HTML.
export const WIDGET_TYPES = ['notes', 'links', 'tasks', 'ideas', 'repositories', 'videos', 'recommendations'];
export const WIDGET_DEFAULTS = {
  notes: {title: 'Notes', content: {markdown: ''}, config: {preview: false}},
  links: {title: 'Links', content: {items: []}, config: {}},
  tasks: {title: 'Tasks', content: {items: []}, config: {showCompleted: true}},
  ideas: {title: 'Saved ideas', content: {items: []}, config: {}},
  repositories: {title: 'GitHub projects', content: {items: []}, config: {}},
  videos: {title: 'Videos', content: {items: []}, config: {}},
  recommendations: {title: 'Recommendations', content: {items: [], dismissedUrls: []}, config: {topic: '', sources: ['github', 'youtube'], perSource: 3}},
};

function invalid(message) {const error = new Error(message); error.status = 400; throw error;}
function record(value) {return value && typeof value === 'object' && !Array.isArray(value);}
function text(value, name, max, fallback = '') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > max) invalid(`${name} must be text of at most ${max} characters.`);
  return value;
}
function boolean(value, name, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') invalid(`${name} must be true or false.`);
  return value;
}
export function safeLink(value) {
  const url = text(value, 'URL', 2000).trim();
  let parsed;
  try {parsed = new URL(url);} catch {invalid('Enter a complete http or https URL.');}
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || /[\u0000-\u001f\u007f]/.test(url)) invalid('Enter a complete http or https URL without credentials.');
  return parsed.href;
}
function itemId(value, index) {
  const id = text(value, 'Item ID', 100, `item-${index + 1}`);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) invalid('Item IDs must contain letters, numbers, underscores, or hyphens.');
  return id;
}
function collection(value) {
  if (!record(value) || !Array.isArray(value.items) || value.items.length > 200) invalid('A widget can contain at most 200 items.');
  if (value.items.some(item => !record(item))) invalid('Every item must be an object.');
  const ids = value.items.map((item, index) => itemId(item.id, index));
  if (new Set(ids).size !== ids.length) invalid('Item IDs must be unique.');
  return value.items.map((item, index) => ({...item, id: ids[index]}));
}
/** @param {Record<string, any>} input @param {Record<string, any> | null | undefined} existing */
export function normalizeWidget(input, existing = null) {
  if (!record(input)) invalid('Enter widget settings.');
  const type = existing?.type || input.type;
  if (!WIDGET_TYPES.includes(type)) invalid('Choose a supported widget type.');
  if (existing && input.type !== undefined && input.type !== existing.type) invalid('A widget type cannot be changed.');
  const defaults = WIDGET_DEFAULTS[type];
  const title = text(input.title, 'Title', 100, existing?.title || defaults.title).trim();
  if (!title) invalid('Give the widget a title.');
  const width = input.width ?? existing?.width ?? (type === 'notes' ? 2 : 1);
  if (![1, 2, 3].includes(width)) invalid('Choose a width of 1, 2, or 3.');
  const sourceContent = input.content ?? existing?.content ?? defaults.content;
  if (!record(sourceContent)) invalid('Widget content must be an object.');
  const sourceConfig = {...defaults.config, ...(existing?.config || {}), ...(input.config || {})};
  if (input.config !== undefined && !record(input.config)) invalid('Widget configuration must be an object.');
  let content, config = {};
  if (type === 'notes') {
    content = {markdown: text(sourceContent.markdown, 'Notes', 50000)};
    config = {preview: boolean(sourceConfig.preview, 'Preview', false)};
  } else if (type === 'recommendations') {
    // The child DO is the only writer of verified results and dismissal history.
    content = structuredClone(existing?.content || defaults.content);
    const sources = sourceConfig.sources;
    if (!Array.isArray(sources) || !sources.length || sources.some(source => !['github', 'youtube'].includes(source))) invalid('Choose GitHub, YouTube, or both.');
    const perSource = sourceConfig.perSource;
    if (!Number.isInteger(perSource) || perSource < 1 || perSource > 5) invalid('Choose between 1 and 5 results per source.');
    config = {topic: text(sourceConfig.topic, 'Topic', 1000), sources: [...new Set(sources)], perSource};
  } else {
    const items = collection(sourceContent);
    content = {items: items.map(item => {
      if (type === 'tasks') return {id: item.id, text: text(item.text, 'Task', 2000), done: boolean(item.done, 'Completed', false)};
      if (type === 'ideas') return {id: item.id, address: text(item.address, 'Idea address', 100), annotation: text(item.annotation, 'Annotation', 5000)};
      const url = safeLink(item.url);
      if (type === 'links') {
        const tags = item.tags ?? [];
        if (!Array.isArray(tags) || tags.length > 20 || tags.some(tag => typeof tag !== 'string' || tag.length > 50)) invalid('Use at most 20 short tags.');
        return {id: item.id, url, label: text(item.label, 'Label', 200), description: text(item.description, 'Description', 5000), tags: [...new Set(tags)]};
      }
      // Do not trust metadata from an HTTP caller; Space resolves it server-side.
      const old = existing?.content?.items?.find(previous => previous.id === item.id && previous.url === url);
      return {id: item.id, url, notes: text(item.notes, 'Notes', 5000), ...(old?.metadata ? {metadata: old.metadata} : {})};
    })};
    if (type === 'tasks') config = {showCompleted: boolean(sourceConfig.showCompleted, 'Show completed', true)};
  }
  return {
    ...(existing || {}), type, title, width,
    collapsed: boolean(input.collapsed, 'Collapsed', existing?.collapsed ?? false),
    includeInAI: boolean(input.includeInAI, 'Include in AI context', existing?.includeInAI ?? true),
    content, config,
  };
}
