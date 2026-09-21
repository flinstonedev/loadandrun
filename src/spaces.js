// Spaces is a standalone vanilla UI. Authentication, navigation and dialogs belong to the shell.
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const clone = value => structuredClone(value);
const types = {
  notes: ['▤', 'Notes', 'Write a brief, keep research, or think out loud.'],
  links: ['↗', 'Links', 'Collect useful sources, descriptions, and tags.'],
  tasks: ['☑', 'Tasks', 'Turn a direction into small next steps.'],
  ideas: ['◇', 'Saved ideas', 'Bring published ideas and your annotations together.'],
  repositories: ['⌘', 'GitHub projects', 'Keep public source code and project notes close.'],
  videos: ['▷', 'Videos', 'Collect YouTube videos to watch and learn from.'],
  recommendations: ['✧', 'Recommendations', 'Discover videos and code related to this space.'],
};

export function safeLink(value) {
  try {const url = new URL(value);return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !/[\u0000-\u001f\u007f]/.test(String(value)) ? url.href : '';}
  catch {return '';}
}

// Raw HTML is always escaped. This small Markdown subset has no HTML/embed execution path.
export function renderMarkdown(value) {
  const inline = text => {
    const tokens = [];
    const marked = String(text).replace(/`([^`\n]+)`|\[([^\]\n]+)\]\(([^\s)]+)\)/g, (match, code, label, href) => {
      const html = code !== undefined ? `<code>${escape(code)}</code>` : safeLink(href) ? `<a href="${escape(safeLink(href))}" target="_blank" rel="noopener noreferrer">${escape(label)}</a>` : escape(label);
      tokens.push(html);return `\u0000${tokens.length - 1}\u0000`;
    });
    return escape(marked).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*\n]+)\*/g, '<em>$1</em>').replace(/\u0000(\d+)\u0000/g, (_, index) => tokens[Number(index)] || '');
  };
  const lines = String(value || '').split('\n');let html = '', code = null, list = false;
  for (const line of lines) {
    if (/^```/.test(line)) {if (list) {html += '</ul>';list = false;}if (code) {html += `<pre><code>${escape(code.join('\n'))}</code></pre>`;code = null;} else code = [];continue;}
    if (code) {code.push(line);continue;}
    const item = line.match(/^\s*[-*] (.*)$/);
    if (item) {if (!list) html += '<ul>';list = true;html += `<li>${inline(item[1])}</li>`;continue;}
    if (list) {html += '</ul>';list = false;}
    const heading = line.match(/^(#{1,6}) (.*)$/);
    html += heading ? `<h${Math.min(heading[1].length + 2, 6)}>${inline(heading[2])}</h${Math.min(heading[1].length + 2, 6)}>` : line.trim() ? `<p>${inline(line)}</p>` : '';
  }
  if (list) html += '</ul>';
  if (code) html += `<pre><code>${escape(code.join('\n'))}</code></pre>`;
  return html || '<p class="hint">Your notes will appear here.</p>';
}

export function moveWidget(layout, id, position) {
  const next = layout.filter(item => item !== id);
  if (!layout.includes(id)) return [...layout];
  next.splice(Math.max(0, Math.min(position, next.length)), 0, id);
  return next;
}

export function createSpacesApp(context) {
  const {api, getSession, getCatalog, go, toast, modal, close, formError, requireAccount} = context;
  const $ = selector => document.querySelector(selector);
  const button = (action, label, attrs = '', primary = false) => `<button type="button" class="${primary ? 'primary' : 'quiet'}" data-space-action="${action}" ${attrs}>${label}</button>`;
  const list = value => Array.isArray(value) ? value : [];
  const date = value => value ? new Date(value).toLocaleString(undefined, {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '';
  const external = (url, label) => safeLink(url) ? `<a href="${escape(safeLink(url))}" target="_blank" rel="noopener noreferrer">${escape(label)} ↗</a>` : `<span>${escape(label)}</span>`;
  const endpoint = (suffix = '') => `spaces/${encodeURIComponent(state.space.id)}${suffix ? '/' + suffix : ''}`;
  let state = null, epoch = 0, controller = null, socket = null, socketTimer = null, statusTimer = null, reconnects = 0;
  let agentStatus = {}, chat = {messages:[]}, chatOpen = false, chatArchiveOpen = false, chatText = '', dragId = '', refreshPromise = null;
  const drafts = new Map(), localCollapsed = new Map(), removedItems = new Map();

  function dispose() {
    if (state && editable()) for (const widget of widgets()) {const draft = getDraft(widget.id);if (draft?.dirty && !draft.conflict) void saveDraft(draft);}
    epoch++;
    controller?.abort();controller = null;
    clearTimeout(socketTimer);clearTimeout(statusTimer);
    if (socket) {socket.onclose = null;socket.close();socket = null;}
    for (const draft of drafts.values()) {clearTimeout(draft.timer);persist(draft);}
    state = null;refreshPromise = null;localCollapsed.clear();removedItems.clear();chatOpen = false;chatArchiveOpen = false;chatText = '';chat = {messages:[]};
  }
  function storageKey(spaceId, widgetId) {return `lr-space-draft:${getSession().user?.id}:${spaceId}:${widgetId}`;}
  function persist(draft) {
    try {
      const key = draft.storageKey;
      if (draft.dirty) sessionStorage.setItem(key, JSON.stringify({widget:draft.widget,baseRevision:draft.baseRevision}));
      else sessionStorage.removeItem(key);
    } catch { /* The in-memory draft still survives route navigation when storage is unavailable. */ }
  }
  function fromServer(widget) {
    const key = storageKey(widget.spaceId, widget.id);
    let draft = drafts.get(key);
    if (!draft) {
      let saved;
      try {saved = JSON.parse(sessionStorage.getItem(key) || 'null');} catch {}
      draft = {storageKey:key,widget:clone(saved?.widget || widget),baseRevision:saved?.baseRevision ?? widget.revision,dirty:!!saved,saving:false,version:0,error:'',conflict:null};
      drafts.set(key, draft);
      if (saved) {draft.error = 'Recovered unsaved changes. Review and retry.';if (saved.baseRevision !== widget.revision) draft.conflict = widget;}
    }
    if (draft.dirty || draft.saving) {
      if (widget.revision !== draft.baseRevision && !draft.saving) {draft.conflict = widget;draft.error = 'Someone updated this widget. Your draft is safe.';}
    } else {draft.widget = clone(widget);draft.baseRevision = widget.revision;draft.error = '';draft.conflict = null;}
    return draft;
  }
  const getDraft = id => drafts.get(storageKey(state?.space.id, id));
  const editable = () => ['owner', 'editor'].includes(state?.space.role);
  const owner = () => state?.space.role === 'owner';
  const widgets = () => state ? state.layout.map(id => getDraft(id)?.widget).filter(Boolean) : [];

  async function render(path) {
    dispose();const version = epoch;controller = new AbortController();
    const page = $('#page');page.classList.add('spaces-page');
    bindEvents(controller.signal);
    if (!getSession().features?.spaces) {page.innerHTML = '<div class="empty-state"><h1>Spaces are coming soon</h1><p>This feature is available in the Spaces beta.</p><a href="/">Back to the community →</a></div>';return;}
    const aiPage = path === '/spaces/connect' || new URLSearchParams(location.search).has('pair');
    if (!getSession().user) {document.title = 'Spaces · Load and Run';page.innerHTML = aiPage ? '<div class="empty-state"><div class="empty-symbol" aria-hidden="true">✧</div><h1>AI for what you’re exploring.</h1><p>Sign in to discuss your widgets and discover relevant videos and GitHub projects with Cloudflare AI.</p><button type="button" class="primary" data-action="login">Sign in</button></div>' : `<div class="empty-state"><div class="space-preview" aria-hidden="true"><span>▤ Notes</span><span>↗ Links</span><span>✧ AI suggestions</span></div><h1>Your space, your widgets.</h1><p>Collect notes, links, tasks, videos, and GitHub projects in widgets you can arrange and customize. Get AI suggestions for relevant videos and projects based on what you add.</p>${button('create-space','Create your space','',true)} <button type="button" class="quiet" data-action="login">Sign in</button></div>`;return;}
    page.innerHTML = '<div class="spaces-loading" role="status"><span class="eyebrow">YOUR SPACES</span><h1>Making room…</h1><div></div><div></div></div>';
    if (aiPage) {await renderAIOverview(version);return;}
    if (path === '/spaces' || path === '/spaces/') {await renderList(version);return;}
    const id = decodeURIComponent(path.slice('/spaces/'.length));
    const result = await api(`spaces/${encodeURIComponent(id)}`);
    if (version !== epoch) return;
    acceptState(result);document.title = state.space.title + ' · Spaces · Load and Run';draw();connectSocket(version);pollAgent(version);
  }
  async function renderList(version = epoch) {
    document.title = 'Your spaces · Load and Run';
    const [result, invited] = await Promise.all([api('spaces'), api('space-invitations')]);
    if (version !== epoch) return;
    const spaces = list(result.spaces || result), invitations = list(invited.invitations || invited);
    $('#page').innerHTML = `<div class="page-heading"><div><span class="eyebrow">WIDGETS + RELEVANT DISCOVERIES</span><h1>Your spaces.</h1><p>Arrange your own widgets. Get AI suggestions based on the notes, links, and projects you collect.</p></div>${button('create-space','＋ Create space','',true)}</div>
      ${invitations.length ? `<section class="space-invitations" aria-labelledby="invitation-title"><h2 id="invitation-title">Invitations <span class="hint">${invitations.length}</span></h2>${invitations.map(invitation => `<article><div><strong>${escape(invitation.spaceTitle || invitation.title || 'A shared space')}</strong><p class="hint">${escape(invitation.from?.name || invitation.inviterName || invitation.ownerName || 'A builder')} invited you as ${escape(invitation.role)}.</p></div><div class="space-actions">${button('accept-invitation','Join space',`data-id="${escape(invitation.id)}" data-space="${escape(invitation.spaceId)}"`)}${button('decline-invitation','Decline',`data-id="${escape(invitation.id)}" data-space="${escape(invitation.spaceId)}"`)}</div></article>`).join('')}</section>` : ''}
      <div class="spaces-list">${spaces.map(space => `<a class="space-card" href="/spaces/${encodeURIComponent(space.id || space.spaceId)}"><div class="space-card-top"><span aria-hidden="true">▦</span><span class="space-role">${escape(space.role || 'owner')}</span></div><h2>${escape(space.title)}</h2><p>${space.role && space.role !== 'owner' ? 'Shared with you' : 'Your space'}${space.widgetCount != null ? ` · ${space.widgetCount} widget${space.widgetCount === 1 ? '' : 's'}` : ''}</p><span class="space-card-open">Open space →</span></a>`).join('')}${!spaces.length ? `<section class="space-first"><div class="space-preview" aria-hidden="true"><span>▤ Notes</span><span>↗ Links</span><span>✧ AI suggestions</span></div><h2>Build your space with widgets.</h2><p>Start with notes, links, or a project. Add a Recommendations widget to discover related YouTube videos and GitHub projects.</p>${button('create-space','Create your first space','',true)}</section>` : ''}</div>
      <aside class="space-ai-callout"><div><span class="eyebrow">AI BUILT INTO YOUR SPACES</span><h2>Discover content related to your widgets</h2><p>Choose which widgets AI can use for video and GitHub suggestions, or discuss your space in private chat. Powered by Cloudflare AI.</p></div><a class="button quiet" href="/spaces/connect">How AI works →</a></aside>`;
  }
  function acceptState(result) {
    state = {...result,layout:result.layout || list(result.widgets).map(widget => widget.id)};
    for (const widget of result.widgets || []) fromServer(widget);
  }
  async function reload() {
    if (!state) return;
    if (refreshPromise) return refreshPromise;
    const id = state.space.id, version = epoch;
    refreshPromise = api(endpoint()).then(result => {if (version === epoch && state?.space.id === id) {acceptState(result);draw();}}).finally(() => {if (version === epoch) refreshPromise = null;});
    return refreshPromise;
  }
  function draw() {
    if (!state) return;
    const focused = document.activeElement, focusId = focused?.id, selection = typeof focused?.selectionStart === 'number' ? [focused.selectionStart,focused.selectionEnd] : null;
    const scroll = $('#space-chat-log')?.scrollTop, archiveScroll = $('.space-chat-archive-log')?.scrollTop;
    chatArchiveOpen = $('#space-chat-archive')?.open ?? chatArchiveOpen;
    const space = state.space;
    $('#page').innerHTML = `<a class="back-link" href="/spaces">← Your spaces</a><div class="page-heading space-heading"><div><span class="eyebrow">${space.members?.length > 1 ? 'SHARED SPACE' : 'PERSONAL SPACE'} <span class="space-role">${escape(space.role)}</span></span><h1>${escape(space.title)}</h1><p>${editable() ? 'Arrange what you’re exploring. Changes save as you go.' : 'Explore the work collected here. You have viewing access.'}</p></div><div class="space-actions">${editable() ? button('add-widget','＋ Add widget','',true) : ''}${owner() ? button('sharing','Share') + button('settings','Settings') : button('leave-space','Leave space')}${button('chat-toggle',chatOpen ? 'Close chat' : 'Ask AI',`aria-expanded="${chatOpen}" aria-controls="space-chat"`)}</div></div>
      <div class="space-status-bar"><span id="space-sync-status" role="status">${socket?.readyState === WebSocket.OPEN ? 'Live updates connected' : 'Connecting live updates…'}</span><span>${space.settings?.automaticRecommendations ? 'Automatic recommendations on' : 'Automatic recommendations off'}</span>${owner() ? button('settings','AI settings') : ''}</div>
      <div class="space-workbench ${chatOpen ? 'with-chat' : ''}"><div><div class="widget-grid" aria-label="Space widgets">${widgets().map(widgetCard).join('')}</div>${!widgets().length ? `<section class="empty-state"><div class="empty-symbol" aria-hidden="true">▦</div><h2>${editable() ? 'Make this space yours.' : 'This space is ready for widgets.'}</h2><p>${editable() ? 'Add notes, links, tasks, or collections of ideas, videos, and projects. Add a Recommendations widget for relevant videos and GitHub projects based on your included widgets.' : 'Widgets and shared recommendations will appear here when an editor adds them.'}</p>${editable() ? button('add-widget','Add your first widget','',true) : ''}</section>` : ''}</div>${chatOpen ? chatPanel() : ''}</div>`;
    if (focusId) {const next = document.getElementById(focusId);if (next) {next.focus({preventScroll:true});if (selection && next.setSelectionRange) next.setSelectionRange(...selection);}}
    if (scroll != null && $('#space-chat-log')) $('#space-chat-log').scrollTop = scroll;
    if (archiveScroll != null && $('.space-chat-archive-log')) $('.space-chat-archive-log').scrollTop = archiveScroll;
  }
  function saveStatus(draft) {
    return draft.conflict ? 'Conflict · draft kept' : draft.saving ? 'Saving…' : draft.error ? 'Not saved · draft kept' : draft.dirty ? 'Unsaved changes' : 'Saved';
  }
  function widgetCard(widget) {
    const draft = getDraft(widget.id), index = state.layout.indexOf(widget.id), info = types[widget.type] || types.notes, collapsed = localCollapsed.get(widget.id) ?? widget.collapsed;
    return `<article class="space-widget widget-width-${widget.width || 1}" id="widget-${escape(widget.id)}" data-widget="${escape(widget.id)}" aria-labelledby="widget-title-${escape(widget.id)}"><header class="widget-header"><span class="widget-symbol" aria-hidden="true">${info[0]}</span><h2 id="widget-title-${escape(widget.id)}">${escape(widget.title)}</h2>${editable() ? `<button type="button" class="widget-grip" draggable="true" data-drag-widget="${escape(widget.id)}" title="Drag to reorder; use Move controls for keyboard" aria-label="Drag ${escape(widget.title)} to reorder">⠿</button>${button('widget-settings','Settings',`data-id="${escape(widget.id)}" aria-label="Customize ${escape(widget.title)}"`)}` : ''}</header>
      <div class="widget-toolbar"><span>${escape(info[1])}${widget.includeInAI ? ' · AI context' : ' · excluded from AI'}</span>${editable() ? `<div class="widget-move">${button('move-up','↑',`data-id="${escape(widget.id)}" aria-label="Move ${escape(widget.title)} earlier" ${index === 0 ? 'disabled' : ''}`)}${button('move-down','↓',`data-id="${escape(widget.id)}" aria-label="Move ${escape(widget.title)} later" ${index === state.layout.length-1 ? 'disabled' : ''}`)}</div>` : ''}${button('collapse',collapsed ? 'Expand' : 'Collapse',`data-id="${escape(widget.id)}" aria-expanded="${!collapsed}" aria-controls="widget-body-${escape(widget.id)}"`)}</div>
      <div class="widget-body" id="widget-body-${escape(widget.id)}" ${collapsed ? 'hidden' : ''}>${widgetBody(widget)}</div>
      ${editable() ? `<div class="widget-footer"><span data-save-status="${escape(widget.id)}" role="status">${saveStatus(draft)}</span>${removedItems.has(widget.id) ? button('undo-remove','Undo remove',`data-id="${escape(widget.id)}"`) : ''}<span data-save-action="${escape(widget.id)}">${draft.error ? button(draft.conflict ? 'review-conflict' : 'retry-save',draft.conflict ? 'Review changes' : 'Retry save',`data-id="${escape(widget.id)}"`) : ''}</span></div>` : ''}</article>`;
  }
  function widgetBody(widget) {
    const items = list(widget.content?.items), edit = editable(), wid = escape(widget.id);
    if (widget.type === 'notes') return `<div class="widget-inline-actions">${edit ? button('notes-preview',widget.config?.preview ? 'Edit Markdown' : 'Preview',`data-id="${wid}"`) : ''}</div>${edit && !widget.config?.preview ? `<label class="sr-only" for="notes-${wid}">${escape(widget.title)} Markdown</label><textarea id="notes-${wid}" class="widget-notes" data-wfield="markdown" data-id="${wid}" maxlength="40000" rows="9" placeholder="What are you exploring?">${escape(widget.content?.markdown || '')}</textarea><p class="hint">Markdown supported. HTML is shown as text.</p>` : `<div class="space-markdown">${renderMarkdown(widget.content?.markdown)}</div>`}`;
    if (widget.type === 'tasks') return `<ul class="widget-items task-items">${items.filter(item => widget.config?.showCompleted !== false || !item.done).map(item => `<li class="${item.done ? 'task-done' : ''}"><input id="task-done-${escape(item.id)}" type="checkbox" data-wfield="done" data-id="${wid}" data-item="${escape(item.id)}" aria-label="Complete ${escape(item.text)}" ${item.done ? 'checked' : ''} ${edit ? '' : 'disabled'}>${edit ? `<input id="task-text-${escape(item.id)}" data-wfield="text" data-id="${wid}" data-item="${escape(item.id)}" aria-label="Task text" value="${escape(item.text)}" maxlength="500">` : `<label for="task-done-${escape(item.id)}">${escape(item.text)}</label>`}${edit ? button('remove-item','×',`data-id="${wid}" data-item="${escape(item.id)}" aria-label="Remove ${escape(item.text)}"`) : ''}</li>`).join('')}</ul>${!items.length ? '<p class="widget-empty">One small next step is a good place to start.</p>' : ''}${edit ? `<form class="widget-add-task" data-task-form="${wid}"><label class="sr-only" for="new-task-${wid}">New task</label><input id="new-task-${wid}" name="text" maxlength="500" required placeholder="Add a next step…"><button class="quiet">Add</button></form>` : ''}`;
    if (widget.type === 'recommendations') return recommendations(widget);
    return `<ul class="widget-items">${items.map(item => collectionItem(widget,item)).join('')}</ul>${!items.length ? `<p class="widget-empty">${escape({links:'Keep a useful link and why it matters.',ideas:'Choose an idea from the repository.',repositories:'Add a public GitHub repository to explore.',videos:'Save a YouTube video for your next learning session.'}[widget.type] || 'Add your first item.')}</p>` : ''}${edit ? button('add-item',`＋ ${escape({links:'Add link',ideas:'Choose an idea',repositories:'Add repository',videos:'Add video'}[widget.type])}`,`data-id="${wid}"`) : ''}`;
  }
  function collectionItem(widget,item) {
    const edit = editable(), wid = escape(widget.id), iid = escape(item.id), metadata = item.metadata || {};
    let title, url, detail = '', notes;
    if (widget.type === 'ideas') {const idea = getCatalog().find(entry => entry.addr === item.address);title = idea?.name || item.address;url = `/ideas/${encodeURIComponent(item.address)}`;detail = idea?.line || '';notes = item.annotation;}
    else if (widget.type === 'links') {title = item.label || item.url;url = item.url;detail = item.description || '';}
    else {title = metadata.fullName || metadata.title || item.url;url = item.url;detail = metadata.description || metadata.authorName || metadata.channel || '';notes = item.notes;}
    return `<li class="widget-collection-item">${widget.type === 'videos' && safeLink(metadata.thumbnailUrl || metadata.thumbnail) ? `<img class="video-thumbnail" src="${escape(safeLink(metadata.thumbnailUrl || metadata.thumbnail))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}<div class="widget-item-heading"><h3>${widget.type === 'ideas' ? `<a href="${url}">${escape(title)} →</a>` : external(url,title)}</h3>${edit ? `<div>${button('edit-item','Edit',`data-id="${wid}" data-item="${iid}"`)}${button('remove-item','×',`data-id="${wid}" data-item="${iid}" aria-label="Remove ${escape(title)}"`)}</div>` : ''}</div>${detail ? `<p class="widget-item-description">${escape(detail)}</p>` : ''}${list(item.tags).length ? `<div class="widget-tags">${item.tags.map(tag => `<span>${escape(tag)}</span>`).join('')}</div>` : ''}${widget.type === 'repositories' || widget.type === 'videos' ? `<p class="hint">${metadata.fetchedAt || metadata.verifiedAt ? `Verified ${escape(date(metadata.fetchedAt || metadata.verifiedAt))}` : 'Metadata will be verified when saved.'}${metadata.language ? ` · ${escape(metadata.language)}` : ''}</p>` : ''}${notes ? `<p class="widget-item-notes">${escape(notes)}</p>` : ''}</li>`;
  }
  function recommendations(widget) {
    const recState = state.space.recommendationState || {}, items = list(widget.content?.items).filter(item => !list(widget.content?.dismissedUrls).includes(item.url));
    const status = {idle:'Ready to discover',queued:'Discovery queued',pending:'Discovery queued',running:'Searching for useful connections…',searching:'Searching for useful connections…',disconnected:'AI temporarily unavailable',unavailable:'AI temporarily unavailable',paused:'Automatic recommendations paused',rate_limited:'Daily AI limit reached','rate-limited':'Daily AI limit reached','up-to-date':'Up to date',stale:'Space changed · refresh for new discoveries',failed:'Discovery needs another try',completed:'Up to date',complete:'Up to date',cancelled:'Discovery stopped',stopped:'Discovery stopped'}[recState.status] || recState.status || 'Ready to discover';
    return `<div class="recommendation-status"><span role="status">${escape(status)}</span>${recState.error ? `<p class="hint">${escape(recState.error)}</p>` : ''}<p class="hint">${escape(widget.config?.topic || 'Based on the widgets included in AI context')} · ${list(widget.config?.sources).map(source => source === 'github' ? 'GitHub' : 'YouTube').join(' + ')}</p>${editable() ? `<div class="space-actions">${button('refresh-recommendations','Refresh')}${['running','queued','pending','searching'].includes(recState.status) ? button('stop-recommendations','Stop') : ''}</div>` : ''}</div>
      <ul class="widget-items">${items.map(item => `<li class="recommendation-item"><span class="eyebrow">${(item.kind || item.source) === 'github' ? 'GITHUB PROJECT' : 'YOUTUBE VIDEO'}</span><h3>${external(item.url,item.metadata?.fullName || item.metadata?.title || item.title || item.url)}</h3><p>${escape(item.explanation || item.reason || item.relevance || '')}</p>${list(item.widgetIds || item.contributingWidgetIds || item.sourceWidgetIds).length ? `<p class="recommendation-sources">Connected to ${list(item.widgetIds || item.contributingWidgetIds || item.sourceWidgetIds).map(id => `<a href="#widget-${escape(id)}" data-widget-link="${escape(id)}">${escape(getDraft(id)?.widget.title || 'a widget')}</a>`).join(', ')}</p>` : ''}<p class="hint">Verified ${escape(date(item.verifiedAt || item.metadata?.fetchedAt))}</p>${editable() ? `<div class="space-actions">${button('save-recommendation','＋ Save to space',`data-id="${escape(widget.id)}" data-item="${escape(item.id)}"`)}${button('dismiss-recommendation','Dismiss',`data-id="${escape(widget.id)}" data-item="${escape(item.id)}"`)}</div>` : ''}</li>`).join('')}</ul>${!items.length ? '<p class="widget-empty">Add a little context, then refresh to discover related videos and GitHub projects. Only verified results appear here.</p>' : ''}`;
  }
  function chatPanel() {
    const available = agentStatus.available === true, pending = ['queued','running'].includes(chat.job?.status), archive = list(chat.archivedMessages);
    return `<aside class="space-chat" id="space-chat" aria-labelledby="space-chat-title" ${matchMedia('(max-width: 950px)').matches ? 'role="dialog" aria-modal="true"' : ''}><div class="space-chat-head"><div><span class="eyebrow">PRIVATE CONVERSATION</span><h2 id="space-chat-title">Ask AI.</h2></div>${button('chat-toggle','×','aria-label="Close private chat"')}</div><p class="hint">Your conversation is visible only to you. Choose what AI can see with each widget’s AI context setting.</p><div class="chat-availability" role="status">${available ? '● AI is ready' : '○ AI is temporarily unavailable. Try again shortly.'}</div>${archive.length ? `<details class="space-chat-archive" id="space-chat-archive" ${chatArchiveOpen ? 'open' : ''}><summary id="space-chat-archive-summary">Earlier conversation</summary><p class="hint">From your previous AI provider. This read-only history is not sent to Cloudflare AI.</p><div class="space-chat-archive-log">${archive.map(message => `<article class="chat-message chat-${message.role === 'user' ? 'user' : 'assistant'}"><strong>${message.role === 'user' ? 'You' : 'Earlier AI'}</strong><div class="space-markdown">${renderMarkdown(message.text)}</div></article>`).join('')}</div></details>` : ''}<div id="space-chat-log" class="space-chat-log" role="log" aria-label="Your private conversation" aria-live="polite">${list(chat.messages).map(message => `<article class="chat-message chat-${message.role === 'user' ? 'user' : 'assistant'}"><strong>${message.role === 'user' ? 'You' : 'AI'}</strong><div class="space-markdown">${renderMarkdown(message.text)}</div></article>`).join('')}${!chat.messages?.length ? '<p class="widget-empty">Ask a question about your space, connect ideas, or find a useful next step.</p>' : ''}${pending ? `<p class="hint" role="status">${chat.job.status === 'queued' ? 'Your message is queued…' : 'Thinking through your space…'}</p>` : ''}${chat.job?.error ? `<p class="error">${escape(chat.job.error)}</p>` : ''}</div><form id="space-chat-form"><label for="space-chat-message">Your message</label><textarea id="space-chat-message" name="message" maxlength="8000" rows="3" required aria-describedby="chat-content-notice" placeholder="What could I build from these ideas?">${escape(chatText)}</textarea><p id="chat-content-notice" class="hint">By sending, you agree to send this conversation and included widget content to Cloudflare AI. Long spaces may be shortened to fit the context limit.</p><div class="space-actions"><button class="primary" ${pending || !available ? 'disabled' : ''}>Send message</button>${pending ? button('cancel-chat','Stop') : ''}</div><p class="error" id="chat-error" role="alert" hidden></p></form>${chat.messages?.length ? button('reset-chat','Clear current conversation') : ''}</aside>`;
  }

  function bindEvents(signal) {
    document.addEventListener('click', event => {
      const source = event.target.closest('[data-space-action]');
      if (source) {event.preventDefault();runAction(source).catch(error => $('#modal')?.open ? formError(error) : toast(error.message));}
      const link = event.target.closest('[data-widget-link]');
      if (link) {event.preventDefault();const widget = document.getElementById('widget-' + link.dataset.widgetLink);widget?.scrollIntoView({behavior:'smooth',block:'center'});widget?.querySelector('h2')?.setAttribute('tabindex','-1');widget?.querySelector('h2')?.focus({preventScroll:true});}
    }, {signal});
    document.addEventListener('input', event => {
      if (event.target.id === 'space-chat-message') {chatText = event.target.value;return;}
      const input = event.target.closest('[data-wfield]');if (!input || input.type === 'checkbox') return;
      updateInput(input);
    }, {signal});
    document.addEventListener('change', event => {
      if (event.target.matches('[data-wfield][type=checkbox]')) updateInput(event.target);
    }, {signal});
    document.addEventListener('submit', event => {
      if (event.target.dataset.taskForm) {
        event.preventDefault();const input = event.target.elements.text, text = input.value.trim();if (!text) return;
        editDraft(event.target.dataset.taskForm, widget => widget.content.items.push({id:crypto.randomUUID(),text,done:false}));input.value = '';draw();$('#new-task-' + event.target.dataset.taskForm)?.focus();
      } else if (event.target.id === 'space-chat-form') {event.preventDefault();sendChat(event.target).catch(error => {const el = $('#chat-error');if (el) {el.hidden = false;el.textContent = error.message;} else toast(error.message);});}
    }, {signal});
    document.addEventListener('keydown', event => {
      if (!chatOpen || $('#modal')?.open) return;
      if (event.key === 'Escape') {event.preventDefault();chatOpen = false;draw();$('[data-space-action="chat-toggle"]')?.focus();return;}
      if (event.key !== 'Tab' || !matchMedia('(max-width: 950px)').matches) return;
      const controls = [...document.querySelectorAll('#space-chat a[href],#space-chat button:not(:disabled),#space-chat textarea,#space-chat summary')].filter(control => control.getClientRects().length);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || !$('#space-chat')?.contains(document.activeElement))) {event.preventDefault();last?.focus();}
      else if (!event.shiftKey && (document.activeElement === last || !$('#space-chat')?.contains(document.activeElement))) {event.preventDefault();first?.focus();}
    }, {signal});
    document.addEventListener('dragstart', event => {const grip = event.target.closest('[data-drag-widget]');if (!grip) return;dragId = grip.dataset.dragWidget;event.dataTransfer.effectAllowed = 'move';event.dataTransfer.setData('text/plain',dragId);}, {signal});
    document.addEventListener('dragover', event => {if (dragId && event.target.closest('[data-widget]')) {event.preventDefault();event.dataTransfer.dropEffect = 'move';}}, {signal});
    document.addEventListener('drop', event => {const target = event.target.closest('[data-widget]');if (!dragId || !target || !editable()) return;event.preventDefault();const moved = dragId;dragId = '';reorder(moved,state.layout.indexOf(target.dataset.widget)).catch(error => toast(error.message));}, {signal});
    document.addEventListener('dragend', () => {dragId = '';}, {signal});
    window.addEventListener('beforeunload', event => {if ([...drafts.values()].some(draft => draft.dirty && draft.storageKey.startsWith(`lr-space-draft:${getSession().user?.id}:`))) {event.preventDefault();event.returnValue = ''; }}, {signal});
  }
  function updateInput(input) {
    editDraft(input.dataset.id, widget => {
      const value = input.type === 'checkbox' ? input.checked : input.value;
      if (input.dataset.item) {const item = widget.content.items.find(item => item.id === input.dataset.item);if (item) item[input.dataset.wfield] = value;}
      else widget.content[input.dataset.wfield] = value;
    });
    if (input.type === 'checkbox') draw();
  }
  function editDraft(id, change) {
    if (!editable()) return;
    const draft = getDraft(id);if (!draft) return;
    change(draft.widget);draft.version++;draft.dirty = true;draft.error = draft.conflict ? draft.error : '';persist(draft);updateSaveStatus(id);
    clearTimeout(draft.timer);if (!draft.conflict) draft.timer = setTimeout(() => saveDraft(draft),700);
  }
  function updateSaveStatus(id) {
    const draft = getDraft(id);if (!draft) return;
    const status = document.querySelector(`[data-save-status="${CSS.escape(id)}"]`), action = document.querySelector(`[data-save-action="${CSS.escape(id)}"]`);
    if (status) status.textContent = saveStatus(draft);
    if (action) action.innerHTML = draft.error ? button(draft.conflict ? 'review-conflict' : 'retry-save',draft.conflict ? 'Review changes' : 'Retry save',`data-id="${escape(id)}"`) : '';
  }
  async function saveDraft(draft) {
    clearTimeout(draft.timer);
    if (!draft.dirty || draft.saving || draft.conflict) return;
    const version = draft.version, widget = clone(draft.widget);
    draft.saving = true;draft.error = '';updateSaveStatus(widget.id);
    try {
      const response = await api(`spaces/${encodeURIComponent(widget.spaceId)}/widgets/${encodeURIComponent(widget.id)}`,{revision:draft.baseRevision,title:widget.title,width:widget.width,collapsed:widget.collapsed,includeInAI:widget.includeInAI,config:widget.config,...(widget.type === 'recommendations' ? {} : {content:widget.content})});
      draft.baseRevision = response.widget.revision;draft.widget.revision = response.widget.revision;
      if (version === draft.version) {draft.widget = clone(response.widget);draft.dirty = false;draft.conflict = null;}
    } catch (error) {draft.error = error.message;if (error.status === 409 && error.data?.widget) draft.conflict = error.data.widget;}
    finally {draft.saving = false;persist(draft);updateSaveStatus(widget.id);}
    if (draft.dirty && !draft.error && !draft.conflict) draft.timer = setTimeout(() => saveDraft(draft),50);
  }
  async function flush() {await Promise.all(widgets().map(widget => saveDraft(getDraft(widget.id))));if (widgets().some(widget => getDraft(widget.id).dirty)) throw Error('Resolve or retry unsaved widget changes before continuing. Your drafts are kept.');}
  async function reorder(id, position) {
    const before = [...state.layout], next = moveWidget(before,id,position);state.layout = next;draw();
    try {await api(endpoint('layout'),{revision:state.space.revision,widgetIds:next});await reload();document.getElementById('widget-' + id)?.querySelector('[data-space-action="move-up"]')?.focus({preventScroll:true});toast('Widget moved.');}
    catch (error) {if (state) {state.layout = before;await reload();}throw error;}
  }
  function openForm(title, fields, submitLabel, action) {
    modal(title, `<form id="space-dialog-form" class="space-form">${fields}<button type="submit" class="primary wide">${escape(submitLabel)}</button></form>`);
    $('#space-dialog-form').onsubmit = async event => {
      event.preventDefault();const submit = event.target.querySelector('[type=submit]');submit.disabled = true;
      try {await action(new FormData(event.target));} catch (error) {formError(error);submit.disabled = false;}
    };
  }
  async function runAction(source) {
    const action = source.dataset.spaceAction, id = source.dataset.id;
    if (action === 'create-space') return requireAccount(() => openForm('Create a space','<p class="form-intro">Give your space a name, then add and customize widgets. Your space starts private; you can invite others later.</p><label for="space-title">Space name</label><input id="space-title" name="title" required maxlength="100" placeholder="What are you exploring?">','Create space',async fields => {const result = await api('spaces',{title:fields.get('title')});close();await go('/spaces/' + (result.space?.id || result.id));}));
    if (action === 'accept-invitation' || action === 'decline-invitation') {source.disabled = true;try {await api(`space-invitations/${encodeURIComponent(id)}/${action === 'accept-invitation' ? 'accept' : 'decline'}`,{spaceId:source.dataset.space});await renderList();toast(action === 'accept-invitation' ? 'You joined the space.' : 'Invitation declined.');} finally {source.disabled = false;}return;}
    if (action === 'ai-status-refresh') return renderAIOverview(epoch);
    if (!state) return;
    const draft = getDraft(id);
    if (action === 'add-widget') {modal('Add a widget',`<p class="form-intro">Choose what belongs in this space. You can customize every widget and add more than one of any type.</p><div class="widget-picker">${Object.entries(types).map(([type,[symbol,title,description]]) => `<button type="button" data-space-action="create-widget" data-type="${type}"><span aria-hidden="true">${symbol}</span><strong>${title}</strong><small>${description}</small></button>`).join('')}</div>`);return;}
    if (action === 'create-widget') {source.disabled = true;try {const result = await api(endpoint('widgets'),{type:source.dataset.type});close();await reload();document.getElementById('widget-' + result.widget?.id)?.scrollIntoView({block:'center'});}finally {source.disabled = false;}return;}
    if (action === 'widget-settings') return widgetSettings(draft.widget);
    if (action === 'collapse') {if (editable()) editDraft(id,widget => {widget.collapsed = !widget.collapsed;});else localCollapsed.set(id,!(localCollapsed.get(id) ?? draft.widget.collapsed));draw();return;}
    if (action === 'notes-preview') {editDraft(id,widget => {widget.config.preview = !widget.config.preview;});draw();return;}
    if (action === 'move-up' || action === 'move-down') return reorder(id,state.layout.indexOf(id) + (action === 'move-up' ? -1 : 1));
    if (action === 'add-item' || action === 'edit-item') return itemForm(draft.widget,source.dataset.item);
    if (action === 'undo-remove') {const removed = removedItems.get(id);if (removed) {editDraft(id,widget => {if (!widget.content.items.some(item => item.id === removed.item.id)) widget.content.items.splice(removed.index,0,removed.item);});removedItems.delete(id);draw();toast('Item restored.');}return;}
    if (action === 'remove-item') {const index = draft.widget.content.items.findIndex(item => item.id === source.dataset.item), item = draft.widget.content.items[index];if (!item) return;removedItems.set(id,{item:clone(item),index});editDraft(id,widget => {widget.content.items = widget.content.items.filter(item => item.id !== source.dataset.item);});draw();toast('Item removed.');return item;}
    if (action === 'delete-widget') return confirmDelete('Remove widget?',`“${draft.widget.title}” and its content will be deleted for everyone in this space.`,async () => {await api(endpoint(`widgets/${encodeURIComponent(id)}/delete`),{revision:draft.baseRevision});draft.dirty = false;persist(draft);drafts.delete(storageKey(state.space.id,id));close();await reload();toast('Widget removed.');});
    if (action === 'retry-save') return saveDraft(draft);
    if (action === 'review-conflict') return reviewConflict(draft);
    if (action === 'settings') return spaceSettings();
    if (action === 'sharing') return sharing();
    if (action === 'revoke-invitation') {await api(endpoint(`invitations/${encodeURIComponent(id)}/revoke`),{});await reload();sharing();toast('Invitation revoked.');return;}
    if (action === 'remove-member') {await api(endpoint(`members/${encodeURIComponent(id)}/remove`),{});await reload();sharing();return;}
    if (action === 'leave-space') return confirmDelete('Leave this space?','You will need a new invitation to return.',async () => {await api(endpoint('leave'),{});close();await go('/spaces');});
    if (action === 'delete-space') return confirmDelete('Delete this space?',`“${state.space.title}”, its widgets, and shared recommendations will be deleted for everyone.`,async () => {await api(endpoint('delete'),{});for (const widget of widgets()) {const draft = getDraft(widget.id);draft.dirty = false;persist(draft);}close();await go('/spaces');});
    if (action === 'refresh-recommendations') {if (!state.space.settings?.aiConsent) {if (owner()) {spaceSettings();toast('Allow Cloudflare AI to use included content, then refresh.');}else toast('Ask the space owner to allow Cloudflare AI in space settings.');return;}source.disabled = true;try {await flush();await api(endpoint('recommendations'),{});await reload();toast('Discovery queued. Relevant videos and projects will appear here.');}finally {source.disabled = false;}return;}
    if (action === 'stop-recommendations') {await api(endpoint('recommendations/stop'),{});await reload();return;}
    if (action === 'save-recommendation' || action === 'dismiss-recommendation') {await api(endpoint('recommendations/' + (action === 'save-recommendation' ? 'save' : 'dismiss')),{widgetId:id,recommendationId:source.dataset.item});await reload();toast(action === 'save-recommendation' ? 'Saved to your space.' : 'Suggestion dismissed.');return;}
    if (action === 'chat-toggle') {chatOpen = !chatOpen;if (chatOpen) {await readAgent();draw();$('#space-chat-message')?.focus();}else draw();return;}
    if (action === 'cancel-chat') {await api('agent/cancel',{jobId:chat.job.id});await readAgent();draw();return;}
    if (action === 'reset-chat') return confirmDelete('Clear your current conversation?','Your current AI chat history will be deleted and the next message will start with the current included widgets. Any earlier provider conversation stays in its read-only archive.',async () => {await api('agent/chat/reset',{spaceId:state.space.id});close();await readAgent();draw();});
  }
  function widgetSettings(widget) {
    openForm('Customize widget',`<label for="widget-title">Title</label><input id="widget-title" name="title" required maxlength="100" value="${escape(widget.title)}"><label for="widget-width">Width</label><select id="widget-width" name="width">${[[1,'Compact · one column'],[2,'Wide · two columns'],[3,'Full width']].map(([value,label]) => `<option value="${value}" ${widget.width === value ? 'selected' : ''}>${label}</option>`).join('')}</select><label class="space-check"><input type="checkbox" name="collapsed" ${widget.collapsed ? 'checked' : ''}> Start collapsed</label><label class="space-check"><input type="checkbox" name="includeInAI" ${widget.includeInAI ? 'checked' : ''}> Include in AI context</label><p class="hint">Included content can be sent to Cloudflare AI for members’ private chats and shared recommendations. Excluded content stays out of AI requests.</p>${widget.type === 'tasks' ? `<label class="space-check"><input type="checkbox" name="showCompleted" ${widget.config?.showCompleted !== false ? 'checked' : ''}> Show completed tasks</label>` : ''}${widget.type === 'recommendations' ? `<label for="recommendation-topic">Discovery focus (optional)</label><input id="recommendation-topic" name="topic" maxlength="500" value="${escape(widget.config?.topic || '')}" placeholder="For example: local-first collaboration"><fieldset class="space-fieldset"><legend>Sources</legend><label class="space-check"><input type="checkbox" name="github" ${widget.config?.sources?.includes('github') ? 'checked' : ''}> GitHub projects</label><label class="space-check"><input type="checkbox" name="youtube" ${widget.config?.sources?.includes('youtube') ? 'checked' : ''}> YouTube videos</label></fieldset><label for="recommendation-count">Results per source</label><select id="recommendation-count" name="perSource">${[1,2,3,4,5].map(value => `<option ${widget.config?.perSource === value ? 'selected' : ''}>${value}</option>`).join('')}</select>` : ''}<div class="space-danger">${button('delete-widget','Remove widget',`data-id="${escape(widget.id)}"`)}</div>`,'Save settings',async fields => {
      const sources = ['github','youtube'].filter(source => fields.has(source));if (widget.type === 'recommendations' && !sources.length) throw Error('Choose at least one recommendation source.');
      editDraft(widget.id,current => {current.title = fields.get('title').trim();current.width = Number(fields.get('width'));current.collapsed = fields.has('collapsed');current.includeInAI = fields.has('includeInAI');if (current.type === 'tasks') current.config.showCompleted = fields.has('showCompleted');if (current.type === 'recommendations') Object.assign(current.config,{topic:fields.get('topic'),sources,perSource:Number(fields.get('perSource'))});});
      await saveDraft(getDraft(widget.id));if (getDraft(widget.id).error) throw Error(getDraft(widget.id).error);close();draw();
    });
  }
  function itemForm(widget, itemId) {
    const item = widget.content.items.find(item => item.id === itemId) || {id:crypto.randomUUID()}, isIdea = widget.type === 'ideas', isLink = widget.type === 'links';
    let fields = isIdea ? `<label for="item-address">Published idea</label><select id="item-address" name="address">${getCatalog().map(idea => `<option value="${escape(idea.addr)}" ${item.address === idea.addr ? 'selected' : ''}>${escape(idea.name)}</option>`).join('')}</select><label for="item-annotation">Your annotation</label><textarea id="item-annotation" name="annotation" maxlength="4000" rows="4">${escape(item.annotation || '')}</textarea>` : `<label for="item-url">${widget.type === 'repositories' ? 'Public GitHub repository URL' : widget.type === 'videos' ? 'YouTube video URL' : 'Web URL'}</label><input id="item-url" name="url" type="url" required maxlength="2000" value="${escape(item.url || '')}" placeholder="${widget.type === 'repositories' ? 'https://github.com/owner/repository' : widget.type === 'videos' ? 'https://www.youtube.com/watch?v=…' : 'https://…'}">`;
    if (isLink) fields += `<label for="item-label">Label</label><input id="item-label" name="label" maxlength="200" value="${escape(item.label || '')}"><label for="item-description">Why is it useful?</label><textarea id="item-description" name="description" maxlength="4000" rows="3">${escape(item.description || '')}</textarea><label for="item-tags">Tags, separated by commas</label><input id="item-tags" name="tags" maxlength="500" value="${escape(list(item.tags).join(', '))}">`;
    if (!isIdea && !isLink) fields += `<p class="hint">${widget.type === 'repositories' ? 'Public repositories only. Metadata is verified with GitHub.' : 'Video details are verified with YouTube. Videos open on YouTube.'}</p><label for="item-notes">Your notes</label><textarea id="item-notes" name="notes" maxlength="4000" rows="4">${escape(item.notes || '')}</textarea>`;
    openForm((itemId ? 'Edit ' : 'Add ') + (isIdea ? 'idea' : isLink ? 'link' : widget.type === 'videos' ? 'video' : 'repository'),fields,itemId ? 'Save changes' : 'Add to widget',async data => {
      const entry = {...item,...Object.fromEntries(data),id:item.id};if (isLink) entry.tags = String(data.get('tags')).split(',').map(tag => tag.trim()).filter(Boolean);
      if (!isIdea && !safeLink(entry.url)) throw Error('Enter a complete http:// or https:// URL.');
      editDraft(widget.id,current => {const index = current.content.items.findIndex(item => item.id === entry.id);if (index >= 0) current.content.items[index] = entry;else current.content.items.push(entry);});
      await saveDraft(getDraft(widget.id));if (getDraft(widget.id).error) throw Error(getDraft(widget.id).error);close();draw();
    });
  }
  function conflictVersion(widget) {
    const settings = `Width: ${widget.width} column${widget.width === 1 ? '' : 's'} · ${widget.collapsed ? 'Collapsed' : 'Expanded'} · ${widget.includeInAI ? 'Included in AI' : 'Excluded from AI'}`;
    const content = widget.type === 'notes' ? `<pre>${escape(widget.content.markdown)}</pre>` : `<ul>${list(widget.content.items).map(item => `<li><strong>${escape(item.text || item.label || item.metadata?.title || item.metadata?.fullName || item.address || item.title || item.url)}</strong>${typeof item.done === 'boolean' ? `<span> · ${item.done ? 'Completed' : 'To do'}</span>` : ''}${item.url ? `<p>${escape(item.url)}</p>` : ''}${item.description || item.annotation || item.notes || item.reason ? `<p>${escape(item.description || item.annotation || item.notes || item.reason)}</p>` : ''}${item.tags?.length ? `<p>Tags: ${escape(item.tags.join(', '))}</p>` : ''}</li>`).join('')}</ul>`;
    return `<div class="space-conflict-copy"><h3>${escape(widget.title)}</h3><p class="hint">${settings}</p>${widget.type === 'tasks' ? `<p class="hint">Completed tasks ${widget.config.showCompleted ? 'shown' : 'hidden'}</p>` : widget.type === 'notes' ? `<p class="hint">${widget.config.preview ? 'Preview' : 'Markdown editor'} open</p>` : widget.type === 'recommendations' ? `<p class="hint">Focus: ${escape(widget.config.topic || 'General')} · ${escape(widget.config.sources.join(', '))} · ${widget.config.perSource} per source</p>` : ''}${content}</div>`;
  }
  function reviewConflict(draft) {
    modal('Review simultaneous changes',`<p class="form-intro">Another builder saved changes while you were editing. Your local draft is kept in this browser tab. Review both versions before choosing.</p><div class="space-conflict"><div><h2>Your draft</h2>${conflictVersion(draft.widget)}</div><div><h2>Saved version</h2>${conflictVersion(draft.conflict)}</div></div><div class="space-actions"><button id="conflict-keep" class="primary">Save my version</button><button id="conflict-server" class="quiet">Use saved version</button></div><p class="hint">Saving your version replaces the current widget content. A newer edit will ask you to review again.</p>`);
    $('#conflict-keep').onclick = async () => {draft.baseRevision = draft.conflict.revision;draft.conflict = null;draft.error = '';await saveDraft(draft);close();draw();};
    $('#conflict-server').onclick = () => {draft.widget = clone(draft.conflict);draft.baseRevision = draft.conflict.revision;draft.dirty = false;draft.conflict = null;draft.error = '';persist(draft);close();draw();};
  }
  function confirmDelete(title, copy, action) {
    openForm(title,`<p class="form-intro">${escape(copy)}</p>`,'Confirm',async () => action());
  }
  function spaceSettings() {
    const space = state.space;
    openForm('Space settings',`<label for="settings-title">Space name</label><input id="settings-title" name="title" maxlength="100" required value="${escape(space.title)}"><fieldset class="space-fieldset"><legend>AI recommendations</legend><p class="form-intro">Discover videos and GitHub projects based on included widgets. Everyone in this space sees the recommendations.</p><label class="space-check"><input type="checkbox" name="aiConsent" ${space.settings?.aiConsent ? 'checked' : ''}> Send included widget content to Cloudflare AI and use derived topics in public content searches for GitHub projects and YouTube videos.</label><label class="space-check"><input type="checkbox" name="automaticRecommendations" ${space.settings?.automaticRecommendations ? 'checked' : ''}> Suggest discoveries automatically when included widgets change</label><p class="hint">Choose included widgets in each widget’s Settings. Automatic discovery waits one minute after changes, runs at most every ten minutes per space, and shares a daily limit of twelve across your spaces. You can also refresh recommendations manually.</p>${agentStatus.model?.name ? `<p class="hint">Powered by Cloudflare AI · ${escape(agentStatus.model.name)}</p>` : ''}<a class="quiet-link" href="/spaces/connect">AI privacy and usage →</a></fieldset><div class="space-danger">${button('delete-space','Delete space')}</div>`,'Save settings',async fields => {if (fields.has('automaticRecommendations') && !fields.has('aiConsent')) throw Error('Allow Cloudflare AI to use included content before turning on automatic recommendations.');await api(endpoint('settings'),{title:fields.get('title'),automaticRecommendations:fields.has('automaticRecommendations'),aiConsent:fields.has('aiConsent')});close();await reload();});
  }

  function sharing() {
    const space = state.space;
    openForm('Share your space',`<p class="form-intro">Invite an existing builder. Viewers can read; editors can update widgets and layout. Only you can manage sharing and shared AI settings.</p><ul class="space-member-list">${list(space.members).map(member => `<li><div><strong>${escape(member.name)}</strong><small>${escape(member.role)}</small></div>${member.role !== 'owner' ? `<div><select data-member-role="${escape(member.id)}" aria-label="Role for ${escape(member.name)}"><option value="viewer" ${member.role === 'viewer' ? 'selected' : ''}>Viewer</option><option value="editor" ${member.role === 'editor' ? 'selected' : ''}>Editor</option></select>${button('remove-member','Remove',`data-id="${escape(member.id)}"`)}</div>` : ''}</li>`).join('')}</ul>${list(space.invitations).length ? `<h2 class="space-small-heading">Pending invitations</h2><ul class="space-member-list">${space.invitations.map(invitation => `<li><div><strong>${escape(invitation.toName || invitation.name || invitation.inviteeName || 'Builder')}</strong><small>${escape(invitation.role)}</small></div>${button('revoke-invitation','Revoke',`data-id="${escape(invitation.id)}"`)}</li>`).join('')}</ul>` : ''}<label for="invite-name">Builder username</label><input id="invite-name" name="name" required maxlength="80" autocomplete="off"><label for="invite-role">Access</label><select id="invite-role" name="role"><option value="viewer">Viewer · read this space</option><option value="editor">Editor · edit widgets and layout</option></select>`,'Send invitation',async fields => {await api(endpoint('invitations'),Object.fromEntries(fields));await reload();sharing();toast('Invitation added to the builder’s Spaces page.');});
    document.querySelectorAll('[data-member-role]').forEach(select => {select.onchange = async () => {try {await api(endpoint('members'),{userId:select.dataset.memberRole,role:select.value});await reload();toast('Member role updated.');}catch(error) {formError(error);}};});
  }
  function connectSocket(version) {
    if (!state || version !== epoch) return;
    const url = new URL('/api/' + endpoint('events'),location.origin);url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(url);
    socket.onopen = () => {reconnects = 0;const status = $('#space-sync-status');if (status) status.textContent = 'Live updates connected';reload().catch(error => toast(error.message));};
    socket.onmessage = event => {try {const payload = JSON.parse(event.data);if (payload.type === 'space.changed') reload().catch(error => toast(error.message));}catch { /* Ignore malformed/unrelated events. */ }};
    socket.onclose = event => {
      if (version !== epoch) return;
      const status = $('#space-sync-status');if (status) status.textContent = 'Live updates disconnected · reconnecting';
      if ([4001,4003,4401,4403].includes(event.code)) {if (status) status.textContent = 'Access changed. Reload this space to continue.';return;}
      socketTimer = setTimeout(() => connectSocket(version),Math.min(30000,1000 * 2 ** reconnects++));
    };
  }
  async function readAgent() {
    if (!state) return;
    const version = epoch, spaceId = state.space.id;
    const [status, messages] = await Promise.all([api('agent/status'),chatOpen ? api('agent/chat?spaceId=' + encodeURIComponent(spaceId)) : Promise.resolve(chat)]);
    if (version === epoch) {agentStatus = status;chat = messages;}
  }
  async function pollAgent(version) {
    try {
      const before = JSON.stringify([agentStatus,chat]);await readAgent();
      if (version === epoch && chatOpen && before !== JSON.stringify([agentStatus,chat])) draw();
    } catch (error) {if (version === epoch && chatOpen) {const status = $('.chat-availability');if (status) status.textContent = error.message;}}
    if (version === epoch && state) statusTimer = setTimeout(() => pollAgent(version),chatOpen ? 3000 : 10000);
  }
  async function sendChat(form) {
    const message = chatText.trim();if (!message) return;
    const submit = form.querySelector('button.primary');submit.disabled = true;
    try {if (editable()) await flush();const result = await api('agent/chat',{spaceId:state.space.id,message});chatText = '';chat = {...chat,messages:result.messages || chat.messages,job:{id:result.jobId,status:result.status}};draw();$('#space-chat-message')?.focus();const log = $('#space-chat-log');if (log) log.scrollTop = log.scrollHeight;}
    finally {submit.disabled = false;}
  }
  async function renderAIOverview(version) {
    document.title = 'AI in your spaces · Load and Run';
    const focusedId = document.activeElement?.id;
    const status = await api('agent/status');
    if (version !== epoch) return;agentStatus = status;
    $('#page').innerHTML = `<a class="back-link" href="/spaces">← Your spaces</a><div class="page-heading"><div><span class="eyebrow">AI BUILT INTO YOUR SPACES</span><h1>Follow your curiosity.</h1><p>Discover relevant videos and GitHub projects, or talk through what you’re collecting.</p></div></div><div class="space-ai-layout"><section class="space-ai-guide"><ol><li><span class="eyebrow">01 / YOUR CONTEXT</span><h2>Choose what AI can see</h2><p>Collect notes, links, tasks, and projects in your space. Use each widget’s Settings to include or exclude it from AI context.</p></li><li><span class="eyebrow">02 / USEFUL DISCOVERIES</span><h2>Find your next source</h2><p>Add a Recommendations widget. The space owner allows Cloudflare AI to use included content and derive topics for public content searches in space settings. Refresh for suggestions, or turn on automatic discovery as your widgets change.</p></li><li><span class="eyebrow">03 / A PRIVATE CONVERSATION</span><h2>Think it through with AI</h2><p>Open Ask AI in any space to connect ideas or explore a next step. Your conversation is visible only to you. Sending a message shares the conversation and included widgets with Cloudflare AI.</p></li></ol><a class="button primary" href="/spaces">Open your spaces →</a></section><aside class="space-ai-status"><span class="eyebrow">CLOUDFLARE AI</span><h2 role="status">${status.available ? 'Ready to help' : 'Temporarily unavailable'}</h2><p>${status.available ? 'Chat and recommendations run in the cloud when you request them.' : 'AI requests are unavailable right now. Try refreshing the status shortly; you can keep working on your widgets.'}</p>${status.model?.name ? `<p class="hint">Model: ${escape(status.model.name)}</p>` : ''}${status.usage ? `<h3>Today’s usage</h3><p>${Number(status.usage.manualRuns) || 0} of ${Number(status.usage.manualLimit) || 40} chat and manual discovery requests.</p><p>${Number(status.usage.automaticRuns) || 0} of ${Number(status.usage.automaticLimit) || 12} automatic discovery requests across your spaces.</p>` : ''}${button('ai-status-refresh','Refresh status','id="ai-status-refresh"')}<hr><h3>Your context, your choice</h3><p>Only included widgets are used for AI. Shared recommendations are visible to space members; private chat history is yours.</p><p class="hint">Long spaces and conversations may be shortened to fit the context limit.</p></aside></div>`;
    if (focusedId) document.getElementById(focusedId)?.focus({preventScroll:true});
  }
  async function addIdea(address) {
    return requireAccount(async () => {
      const result = await api('spaces'), spaces = list(result.spaces || result).filter(space => ['owner','editor'].includes(space.role || 'owner'));
      if (!spaces.length) {modal('Add an idea to a space',`<p class="form-intro">Create a space, then add a Saved ideas widget to collect this idea.</p><a class="button primary wide" href="/spaces">Create your first space →</a>`);return;}
      openForm('Add idea to a space',`<label for="idea-space">Space</label><select id="idea-space" name="spaceId">${spaces.map(space => `<option value="${escape(space.id || space.spaceId)}">${escape(space.title)}</option>`).join('')}</select><label for="idea-space-note">Your annotation (optional)</label><textarea id="idea-space-note" name="annotation" maxlength="4000" rows="3"></textarea>`,'Add idea',async fields => {
        const spaceId = String(fields.get('spaceId')), snapshot = await api(`spaces/${encodeURIComponent(spaceId)}`);
        let widget = snapshot.widgets.find(widget => widget.type === 'ideas');
        if (!widget) widget = (await api(`spaces/${encodeURIComponent(spaceId)}/widgets`,{type:'ideas'})).widget;
        await api(`spaces/${encodeURIComponent(spaceId)}/widgets/${encodeURIComponent(widget.id)}`,{revision:widget.revision,content:{items:[...widget.content.items,{id:crypto.randomUUID(),address,annotation:fields.get('annotation')}]}});close();toast('Idea added to your space.');
      });
    });
  }
  return {render,dispose,addIdea};
}
