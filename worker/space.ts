import {DurableObject} from 'cloudflare:workers';
import {normalizeWidget} from '../src/widget-schema.js';
import catalog from '../src/data.json';
import {resolveRepository, resolveVideo, validateRecommendations} from '../server/discovery.mjs';
import {SqlState, objectName, ok, fail, errorResult, identifier, actorSessionActive} from './spaces-common';
import type {Actor, AgentJob, ApiResult, SpaceInvitation, SpaceRole, SpaceSummary} from './spaces-types';
import type {WidgetRecord, WidgetConfig} from './widget';

export interface SpaceContext {
  spaceId: string; title: string; revision: number; contextRevision: string;
  widgets: WidgetRecord[]; recommendationWidgets: {id: string; title: string; config: WidgetConfig}[];
  excludedUrls: string[]; truncated: boolean; truncationNotice?: string;
}

interface Member {id: string; name: string; role: SpaceRole}
interface WidgetIndex {id: string; type: string; title: string; revision: number; pending?: boolean; resultJobId?: string}
interface SpaceData {
  id: string; title: string; ownerId: string; updatedAt: number; revision: number; contextRevision: number;
  members: Record<string, Member>; invitations: Record<string, SpaceInvitation>;
  widgets: Record<string, WidgetIndex>; layout: string[]; deleted?: boolean;
  settings: {automaticRecommendations: boolean; aiConsent: boolean; consentVersion: number; aiProvider: 'cloudflare'};
  recommendationState: {status: string; jobId?: string; error?: string; updatedAt?: number};
  activeJob?: AgentJob; pendingAutoAt?: number; lastAutomaticAt?: number;
}
type Operation = {id: string; kind: 'index' | 'invite' | 'remove-invite' | 'write' | 'delete-widget'; userId?: string; invitation?: SpaceInvitation; invitationId?: string; widget?: WidgetRecord; widgetId?: string; createdAt: number};

export class Space extends DurableObject<Env> {
  private state: SqlState;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.state = new SqlState(ctx.storage);
    const saved = this.state.get<SpaceData>('space');
    if (saved && saved.settings.aiProvider !== 'cloudflare') {
      // A local Codex permission is not permission to send content to a hosted provider.
      saved.settings = {aiProvider: 'cloudflare', automaticRecommendations: false, aiConsent: false, consentVersion: (saved.settings.consentVersion || 0) + 1};
      saved.activeJob = undefined;
      saved.pendingAutoAt = undefined;
      saved.contextRevision++;
      saved.revision++;
      saved.recommendationState = {status: 'paused', updatedAt: Date.now()};
      this.save(saved);
    }
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  private data(): SpaceData {const data = this.state.get<SpaceData>('space'); if (!data || data.deleted) fail('Space not found.', 404); return data;}
  private member(actorId: string, minimum: 'viewer' | 'editor' | 'owner' = 'viewer'): {space: SpaceData; member: Member} {
    const space = this.data(), member = space.members[actorId];
    if (!member) fail('Space not found.', 404);
    if (minimum === 'owner' && member.role !== 'owner' || minimum === 'editor' && member.role === 'viewer') fail('You do not have permission to change this space.', 403);
    return {space, member};
  }
  private save(space: SpaceData): void {this.state.set('space', space);}
  private summary(space: SpaceData, userId: string): SpaceSummary {return {id: space.id, title: space.title, ownerId: space.ownerId, role: space.members[userId]?.role, updatedAt: space.updatedAt};}
  private directory(userId: string) {return this.env.SPACE_DIRECTORIES.getByName(objectName(this.env.WORKSPACE_ID, userId));}
  private widget(id: string) {return this.env.WIDGETS.getByName(objectName(this.env.WORKSPACE_ID, id));}
  private async readWidget(id: string, spaceId: string): Promise<WidgetRecord | null> {return await this.widget(id).read(spaceId);}
  private pending(operation: Omit<Operation, 'id' | 'createdAt'>): Operation {
    const item = {...operation, id: crypto.randomUUID(), createdAt: Date.now()};
    this.state.set(`pending:${item.id}`, item); return item;
  }
  private changed(space: SpaceData, context = true): void {
    space.revision++; space.updatedAt = Date.now();
    if (context) {
      space.contextRevision++;
      if (space.activeJob) space.recommendationState = {status: 'stale'};
      space.activeJob = undefined;
      if (this.env.SPACES_AI_ENABLED === 'true' && space.settings.aiProvider === 'cloudflare' && space.settings.automaticRecommendations && space.settings.aiConsent && Object.values(space.widgets).some(widget => widget.type === 'recommendations')) space.pendingAutoAt = Date.now() + 60_000;
      else space.pendingAutoAt = undefined;
    }
    this.save(space);
    if (context) this.ctx.waitUntil(this.cancelOldContexts(space));
  }
  private async cancelOldContexts(space: SpaceData): Promise<void> {
    await Promise.allSettled(Object.keys(space.members).map(id => this.directory(id).cancelSpaceJobs(space.id, 'Space context changed.', String(space.contextRevision))));
  }
  private async schedule(): Promise<void> {
    const data = this.state.get<SpaceData>('space');
    const pending = this.state.list<Operation>('pending:');
    const deadlines = [...(pending.length ? [Date.now() + 15_000] : []), ...(data?.pendingAutoAt ? [Math.max(data.pendingAutoAt, (data.lastAutomaticAt || 0) + 600_000)] : [])];
    if (deadlines.length) await this.ctx.storage.setAlarm(Math.min(...deadlines));
    else await this.ctx.storage.deleteAlarm();
  }
  private async perform(operation: Operation): Promise<ApiResult | undefined> {
    const space = this.state.get<SpaceData>('space');
    if (!space) return;
    let response: ApiResult | undefined;
    if (operation.kind === 'index' && operation.userId) {
      const directory = this.directory(operation.userId);
      await directory.initialize(operation.userId);
      const latest = this.state.get<SpaceData>('space')!;
      if (latest.deleted || !latest.members[operation.userId]) await directory.removeSpaceIndex(latest.id);
      else await directory.setSpaceIndex(this.summary(latest, operation.userId));
    } else if (operation.kind === 'invite' && operation.invitation) {
      const invitation = this.state.get<SpaceData>('space')?.invitations[operation.invitation.id];
      if (invitation && !space.deleted) await this.directory(invitation.toUserId).putInvitation(invitation);
      else await this.directory(operation.invitation.toUserId).removeInvitation(operation.invitation.id);
    } else if (operation.kind === 'remove-invite' && operation.userId && operation.invitationId) {
      await this.directory(operation.userId).removeInvitation(operation.invitationId);
    } else if (operation.kind === 'delete-widget' && operation.widgetId) {
      await this.widget(operation.widgetId).discard(space.id);
    } else if (operation.kind === 'write' && operation.widget) {
      const input = operation.widget;
      if (space.deleted || !space.widgets[input.id]) {await this.widget(input.id).discard(space.id);}
      else {
        response = await this.widget(input.id).write(space.id, input, operation.id);
        const latest = this.state.get<SpaceData>('space')!;
        if (!latest.deleted && latest.widgets[input.id]) {
          const result = response.body.widget as WidgetRecord | undefined;
          if (result) latest.widgets[input.id] = {...latest.widgets[input.id], id: result.id, title: result.title, type: result.type, revision: result.revision, pending: false};
          else if (input.revision === 0) {delete latest.widgets[input.id]; latest.layout = latest.layout.filter(id => id !== input.id);}
          else latest.widgets[input.id].pending = false;
          this.save(latest);
        }
      }
    }
    this.state.delete(`pending:${operation.id}`);
    return response;
  }
  private async flush(operations: Operation[]): Promise<void> {
    await Promise.allSettled(operations.map(operation => this.perform(operation)));
    await this.schedule();
  }
  private indexOperations(space: SpaceData): Operation[] {return Object.keys(space.members).map(userId => this.pending({kind: 'index', userId}));}

  async init(actor: Actor, input: {id: string; title: string}): Promise<ApiResult> {
    try {
      const old = this.state.get<SpaceData>('space');
      if (old) {if (old.deleted || old.ownerId !== actor.id || old.id !== input.id) fail('Space not found.', 404); return ok({space: this.summary(old, actor.id)});}
      const title = this.title(input.title);
      const space: SpaceData = {id: identifier(input.id), title, ownerId: actor.id, updatedAt: Date.now(), revision: 1, contextRevision: 1,
        members: {[actor.id]: {id: actor.id, name: actor.name, role: 'owner'}}, invitations: {}, widgets: {}, layout: [],
        settings: {aiProvider: 'cloudflare', automaticRecommendations: false, aiConsent: false, consentVersion: 0}, recommendationState: {status: 'paused'}};
      this.save(space);
      await this.flush(this.indexOperations(space));
      return ok({space: this.summary(space, actor.id)}, 201);
    } catch (error) {return errorResult(error);}
  }
  private title(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || value.length > 100) fail('Give the space a title of at most 100 characters.');
    return value.trim();
  }
  async inspectAccess(userId: string): Promise<(SpaceSummary & {revision: number; settings: SpaceData['settings']}) | null> {
    const space = this.state.get<SpaceData>('space');
    if (!space || space.deleted || !space.members[userId]) return null;
    return {...this.summary(space, userId), revision: space.revision, settings: space.settings};
  }
  async inspectInvitation(userId: string, invitationId: string): Promise<SpaceInvitation | null> {
    const space = this.state.get<SpaceData>('space');
    const invitation = space?.invitations[invitationId];
    return space && !space.deleted && invitation?.toUserId === userId ? invitation : null;
  }
  async currentSnapshot(actor: Actor): Promise<ApiResult> {
    try {
      const {space} = this.member(actor.id);
      const widgets = (await Promise.all(space.layout.map(id => this.readWidget(id, space.id)))).filter((widget): widget is WidgetRecord => Boolean(widget));
      const latest = this.member(actor.id).space;
      for (const widget of widgets) {
        if (widget.type === 'recommendations' && widget.recommendationJobId !== latest.widgets[widget.id]?.resultJobId) widget.content.items = [];
      }
      const contextTruncated = new TextEncoder().encode(JSON.stringify(widgets.filter(widget => widget.includeInAI && widget.type !== 'recommendations'))).byteLength > 110_000;
      return ok({space: {...this.summary(latest, actor.id), revision: latest.revision, settings: latest.settings, members: Object.values(latest.members),
        invitations: actor.id === latest.ownerId ? Object.values(latest.invitations) : [], recommendationState: latest.recommendationState,
        contextNotice: contextTruncated ? 'This is a large space. Some content may be shortened for the agent; exclude unrelated widgets to give it more focused context.' : null},
        widgets: widgets.filter(widget => latest.widgets[widget.id]), layout: latest.layout});
    } catch (error) {return errorResult(error);}
  }

  async dispatch(actor: Actor, method: string, action: string, body: Record<string, any> = {}): Promise<ApiResult> {
    try {
      if (method === 'GET' && !action) return this.currentSnapshot(actor);
      if (method !== 'POST') fail('Not found.', 404);
      if (action === 'settings') return await this.settings(actor, body);
      if (action === 'delete') return await this.deleteSpace(actor);
      if (action === 'leave') return await this.removeMember(actor, actor.id);
      if (action === 'members') return await this.changeMember(actor, body);
      if (/^members\/[^/]+\/remove$/.test(action)) return await this.removeMember(actor, action.split('/')[1]);
      if (action === 'invitations') return await this.invite(actor, body);
      if (/^invitations\/[^/]+\/revoke$/.test(action)) return await this.revokeInvitation(actor, action.split('/')[1]);
      if (action === 'widgets') return await this.writeWidget(actor, null, body);
      if (/^widgets\/[^/]+$/.test(action)) return await this.writeWidget(actor, action.split('/')[1], body);
      if (/^widgets\/[^/]+\/delete$/.test(action)) return await this.deleteWidget(actor, action.split('/')[1], body);
      if (action === 'layout') return await this.layout(actor, body);
      if (action === 'recommendations') return await this.requestRecommendations(actor, false);
      if (action === 'recommendations/stop') return await this.stopRecommendations(actor);
      if (action === 'recommendations/dismiss') return await this.dismissRecommendation(actor, body);
      if (action === 'recommendations/save') return await this.saveRecommendation(actor, body);
      fail('Not found.', 404);
    } catch (error) {return errorResult(error);}
  }
  private async settings(actor: Actor, body: Record<string, any>): Promise<ApiResult> {
    const {space} = this.member(actor.id, 'owner');
    const oldSettings = JSON.stringify(space.settings);
    const wasAutomatic = space.settings.automaticRecommendations;
    if (body.title !== undefined) space.title = this.title(body.title);
    for (const key of ['automaticRecommendations', 'aiConsent'] as const) {
      if (body[key] !== undefined) {if (typeof body[key] !== 'boolean') fail('Choose true or false for AI settings.'); space.settings[key] = body[key];}
    }
    if (body.aiConsent !== undefined) space.settings.aiProvider = 'cloudflare';
    if (space.settings.automaticRecommendations && !space.settings.aiConsent) fail('Allow Cloudflare AI to use selected space content before enabling automatic recommendations.');
    const contextChanged = oldSettings !== JSON.stringify(space.settings);
    if (contextChanged) space.settings.consentVersion++;
    this.changed(space, contextChanged);
    if (contextChanged && (!space.settings.aiConsent || (wasAutomatic && !space.settings.automaticRecommendations))) {space.pendingAutoAt = undefined; space.recommendationState = {status: 'paused'}; this.save(space);}
    await this.flush(this.indexOperations(space));
    await this.broadcast(); return this.currentSnapshot(actor);
  }
  private async changeMember(actor: Actor, body: Record<string, any>): Promise<ApiResult> {
    const {space} = this.member(actor.id, 'owner');
    const id = identifier(body.userId);
    if (!space.members[id] || id === space.ownerId) fail('Choose an existing editor or viewer.');
    if (!['editor', 'viewer'].includes(body.role)) fail('Choose editor or viewer.');
    space.members[id].role = body.role;
    this.changed(space); await this.flush([this.pending({kind: 'index', userId: id})]);
    await this.broadcast(); return this.currentSnapshot(actor);
  }
  private async removeMember(actor: Actor, userId: string): Promise<ApiResult> {
    const {space} = this.member(actor.id, actor.id === userId ? 'viewer' : 'owner');
    if (userId === space.ownerId) fail('Owners must delete their space instead of leaving.');
    delete space.members[userId]; this.changed(space);
    await this.directory(userId).cancelSpaceJobs(space.id, 'Space access was removed.');
    await this.flush([this.pending({kind: 'index', userId})]);
    await this.broadcast(); return ok({ok: true});
  }
  private async invite(actor: Actor, body: Record<string, any>): Promise<ApiResult> {
    this.member(actor.id, 'owner');
    if (!['editor', 'viewer'].includes(body.role) || typeof body.name !== 'string') fail('Enter a builder username and choose editor or viewer.');
    const user = await this.env.WORKSPACES.getByName(this.env.WORKSPACE_ID).findBuilder(body.name);
    if (!user) fail('That builder username does not exist.', 404);
    const {space} = this.member(actor.id, 'owner');
    if (space.members[user.id]) fail('This builder already belongs to the space.');
    const existing = Object.values(space.invitations).find(invitation => invitation.toUserId === user.id);
    if (existing) return ok({invitation: existing});
    if (Object.keys(space.members).length + Object.keys(space.invitations).length >= 50) fail('A space supports up to 50 members and invitations.');
    const invitation: SpaceInvitation = {id: crypto.randomUUID(), spaceId: space.id, spaceTitle: space.title, from: {id: actor.id, name: actor.name}, toUserId: user.id, toName: user.name, role: body.role, createdAt: Date.now()};
    space.invitations[invitation.id] = invitation; this.changed(space, false);
    await this.flush([this.pending({kind: 'invite', invitation})]); await this.broadcast(); return ok({invitation}, 201);
  }
  async acceptInvitation(actor: Actor, invitationId: string): Promise<ApiResult> {
    try {
      const space = this.data(), invitation = space.invitations[invitationId];
      const receipt = this.state.get<{userId: string; action: string}>(`invitation-result:${invitationId}`);
      if (receipt?.userId === actor.id && receipt.action === 'accept' && space.members[actor.id]) return ok({space: this.summary(space, actor.id)});
      if (!invitation || invitation.toUserId !== actor.id) fail('Invitation not found.', 404);
      space.members[actor.id] = {id: actor.id, name: actor.name, role: invitation.role};
      delete space.invitations[invitationId]; this.changed(space);
      this.state.set(`invitation-result:${invitationId}`, {userId: actor.id, action: 'accept'});
      await this.flush([this.pending({kind: 'index', userId: actor.id}), this.pending({kind: 'remove-invite', userId: actor.id, invitationId})]);
      await this.broadcast(); return ok({space: this.summary(space, actor.id)});
    } catch (error) {return errorResult(error);}
  }
  async declineInvitation(actor: Actor, invitationId: string): Promise<ApiResult> {
    try {
      const space = this.data(), invitation = space.invitations[invitationId];
      const receipt = this.state.get<{userId: string; action: string}>(`invitation-result:${invitationId}`);
      if (receipt?.userId === actor.id && receipt.action === 'decline') return ok({ok: true});
      if (!invitation || invitation.toUserId !== actor.id) fail('Invitation not found.', 404);
      delete space.invitations[invitationId]; this.changed(space, false);
      this.state.set(`invitation-result:${invitationId}`, {userId: actor.id, action: 'decline'});
      await this.flush([this.pending({kind: 'remove-invite', userId: actor.id, invitationId})]);
      await this.broadcast(); return ok({ok: true});
    } catch (error) {return errorResult(error);}
  }
  private async revokeInvitation(actor: Actor, invitationId: string): Promise<ApiResult> {
    const {space} = this.member(actor.id, 'owner'), invitation = space.invitations[invitationId];
    if (!invitation) return ok({ok: true});
    delete space.invitations[invitationId]; this.changed(space, false);
    await this.flush([this.pending({kind: 'remove-invite', userId: invitation.toUserId, invitationId})]);
    await this.broadcast(); return ok({ok: true});
  }
  private async verifiedWidget(input: Record<string, any>, old: WidgetRecord | null): Promise<WidgetRecord> {
    const result = normalizeWidget(input, old) as WidgetRecord;
    if (result.type === 'ideas') {
      const addresses = new Set(catalog.blueprints.map(idea => idea.addr));
      if (result.content.items?.some(item => !addresses.has(item.address || ''))) fail('Choose a published catalog idea.');
    }
    if (['repositories', 'videos'].includes(result.type)) {
      if ((result.content.items || []).filter(item => !item.metadata).length > 20) fail('Add at most 20 new provider links at a time.');
      // Limit concurrent network verification while keeping mutations atomic in the child.
      for (const item of result.content.items || []) {
        if (!item.metadata) {
          const metadata = result.type === 'repositories' ? await resolveRepository(item.url) : await resolveVideo(item.url);
          item.url = metadata.url; item.metadata = metadata;
        }
      }
    }
    return result;
  }
  private async writeWidget(actor: Actor, widgetId: string | null, body: Record<string, any>): Promise<ApiResult> {
    let {space} = this.member(actor.id, 'editor');
    const requestKey = !widgetId && body.operationId ? `widget-request:${actor.id}:${identifier(body.operationId, 'Operation')}` : null;
    const fingerprint = requestKey ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(body))))).map(byte => byte.toString(16).padStart(2, '0')).join('') : '';
    const replay = async (): Promise<ApiResult | null> => {
      const receipt = requestKey ? this.state.get<{fingerprint: string; widgetId: string}>(requestKey) : null;
      if (!receipt) return null;
      if (receipt.fingerprint !== fingerprint) fail('This operation ID was already used for a different widget.', 409);
      const current = this.member(actor.id, 'editor').space;
      if (!current.widgets[receipt.widgetId]) fail('The widget from this operation was deleted.', 404);
      const widget = await this.readWidget(receipt.widgetId, current.id);
      this.member(actor.id, 'editor');
      return widget ? ok({widget}, 201) : {status: 409, body: {error: 'This widget is still saving. Retry shortly.'}};
    };
    const previous = await replay(); if (previous) return previous;
    space = this.member(actor.id, 'editor').space;
    if (widgetId && !space.widgets[widgetId]) fail('Widget not found.', 404);
    if (!widgetId && space.layout.length >= 50) fail('A space supports up to 50 widgets.');
    const old = widgetId ? await this.widget(widgetId).read(space.id) : null;
    if (widgetId && !old) fail('Widget not found.', 404);
    if (old && body.revision !== old.revision) return {status: 409, body: {error: 'This widget changed. Review the latest version before saving.', widget: old}};
    const normalized = await this.verifiedWidget(body, old);
    if (requestKey && this.state.get(requestKey)) return (await replay())!;
    space = this.member(actor.id, 'editor').space;
    if (widgetId && !space.widgets[widgetId]) fail('Widget not found.', 404);
    if (widgetId && space.widgets[widgetId].pending) return {status: 409, body: {error: 'This widget is still saving. Retry shortly.', widget: old}};
    if (widgetId && space.widgets[widgetId].revision !== old!.revision) return {status: 409, body: {error: 'This widget changed. Review the latest version before saving.', widget: await this.widget(widgetId).read(space.id)}};
    const id = widgetId || crypto.randomUUID();
    if (requestKey) this.state.set(requestKey, {fingerprint, widgetId: id});
    const widget: WidgetRecord = {...normalized, id, spaceId: space.id, revision: old?.revision || 0, updatedAt: Date.now()};
    space.widgets[id] = {...space.widgets[id], id, title: widget.title, type: widget.type, revision: widget.revision, pending: true};
    if (!widgetId) space.layout.push(id);
    const contextChanged = !old || old.includeInAI !== widget.includeInAI
      || (widget.type === 'recommendations' && JSON.stringify(old.config) !== JSON.stringify(widget.config))
      || (widget.includeInAI && widget.type !== 'recommendations' && JSON.stringify(old.content) !== JSON.stringify(widget.content));
    this.changed(space, contextChanged);
    const operation = this.pending({kind: 'write', widget});
    await this.schedule();
    const result = await this.perform(operation);
    this.member(actor.id, 'editor');
    await this.schedule(); await this.broadcast();
    return result || ok({widget});
  }
  private async deleteWidget(actor: Actor, widgetId: string, body: Record<string, any>): Promise<ApiResult> {
    const {space} = this.member(actor.id, 'editor');
    if (!space.widgets[widgetId]) return ok({ok: true});
    if (body.revision !== undefined && body.revision !== space.widgets[widgetId].revision) return {status: 409, body: {error: 'This widget changed. Reload before deleting.', widget: await this.widget(widgetId).read(space.id)}};
    delete space.widgets[widgetId]; space.layout = space.layout.filter(id => id !== widgetId); this.changed(space);
    await this.flush([this.pending({kind: 'delete-widget', widgetId})]); await this.broadcast(); return ok({ok: true});
  }
  private async layout(actor: Actor, body: Record<string, any>): Promise<ApiResult> {
    const {space} = this.member(actor.id, 'editor');
    if (body.revision !== space.revision) return {status: 409, body: {error: 'The space changed. Reload before reordering.', revision: space.revision}};
    const ids = body.widgetIds;
    if (!Array.isArray(ids) || ids.length !== space.layout.length || new Set(ids).size !== ids.length || ids.some(id => !space.widgets[id])) fail('Include each widget exactly once.');
    space.layout = ids; this.changed(space, false); await this.broadcast(); return ok({layout: ids, revision: space.revision});
  }
  private async deleteSpace(actor: Actor): Promise<ApiResult> {
    const {space} = this.member(actor.id, 'owner');
    const members = Object.keys(space.members), operations = this.indexOperations(space);
    for (const invitation of Object.values(space.invitations)) operations.push(this.pending({kind: 'remove-invite', userId: invitation.toUserId, invitationId: invitation.id}));
    for (const widgetId of space.layout) operations.push(this.pending({kind: 'delete-widget', widgetId}));
    space.deleted = true; space.members = {}; space.invitations = {}; space.widgets = {}; space.layout = []; space.activeJob = undefined; space.pendingAutoAt = undefined;
    this.changed(space);
    await Promise.allSettled(members.map(id => this.directory(id).cancelSpaceJobs(space.id, 'Space deleted.')));
    await this.flush(operations); await this.broadcast(); return ok({ok: true});
  }

  async contextFor(userId: string): Promise<SpaceContext> {
    const {space} = this.member(userId);
    const widgets = (await Promise.all(space.layout.map(id => this.readWidget(id, space.id)))).filter((widget): widget is WidgetRecord => Boolean(widget));
    const current = this.member(userId).space;
    if (current.contextRevision !== space.contextRevision || Object.values(current.widgets).some(widget => widget.pending)) fail('Space content is still saving. Try again shortly.', 409);
    const included = widgets.filter(widget => widget.includeInAI && widget.type !== 'recommendations' && current.widgets[widget.id]);
    const recommendations = widgets.filter(widget => widget.type === 'recommendations' && widget.includeInAI && current.widgets[widget.id]);
    const context: SpaceContext = {spaceId: space.id, title: space.title, revision: space.contextRevision, contextRevision: String(space.contextRevision),
      widgets: included, recommendationWidgets: recommendations.map(widget => ({id: widget.id, title: widget.title, config: widget.config})),
      excludedUrls: [...new Set(included.flatMap(widget => widget.content.items || []).flatMap(item => item.url ? [item.url] : []))], truncated: false};
    // Keep every source ID, then reduce only content while explicitly reporting truncation.
    const bytes = () => new TextEncoder().encode(JSON.stringify(context)).byteLength;
    if (bytes() > 120_000) {
      context.truncated = true;
      context.truncationNotice = 'This space exceeds the agent context limit. Some widget content and saved URLs were shortened; ask the user for missing details instead of assuming them.';
      context.excludedUrls = context.excludedUrls.slice(0, 100);
      let budget = 1000;
      while (bytes() > 120_000 && budget >= 20) {
        for (const widget of context.widgets) {
          if (widget.content.markdown) widget.content.markdown = widget.content.markdown.slice(0, budget);
          widget.content.items = (widget.content.items || []).slice(0, Math.max(1, Math.floor(budget / 200))).map(item => {
            const shortened = {...item};
            for (const key of ['text', 'label', 'description', 'annotation', 'notes'] as const) if (shortened[key]) shortened[key] = shortened[key]!.slice(0, budget);
            return shortened;
          });
        }
        context.excludedUrls = context.excludedUrls.slice(0, Math.max(0, Math.floor(budget / 10)));
        budget = Math.floor(budget / 2);
      }
      if (bytes() > 120_000) {
        for (const widget of context.widgets) widget.content = {markdown: 'Content omitted because this space exceeds the context size limit.'};
        context.excludedUrls = [];
      }
    }
    return context;
  }
  async validateAgentJob(job: AgentJob): Promise<boolean> {
    if (this.env.SPACES_ENABLED !== 'true' || this.env.SPACES_AI_ENABLED !== 'true' || job.provider !== 'cloudflare') return false;
    const space = this.state.get<SpaceData>('space');
    if (!space || space.deleted || space.settings.aiProvider !== 'cloudflare' || space.id !== job.spaceId || !space.members[job.userId] || String(space.contextRevision) !== job.contextVersion || Object.values(space.widgets).some(widget => widget.pending)) return false;
    if (job.kind === 'chat') return true;
    return job.userId === space.ownerId && space.settings.aiConsent && job.consentVersion === space.settings.consentVersion && (!job.automatic || space.settings.automaticRecommendations) && space.activeJob?.id === job.id;
  }
  private async requestRecommendations(actor: Actor, automatic: boolean): Promise<ApiResult> {
    const {space} = this.member(actor.id, 'editor');
    if (this.env.SPACES_AI_ENABLED !== 'true') fail('Cloudflare AI is unavailable. Your widgets are still saved.', 503);
    if (!space.settings.aiConsent) fail('The space owner must enable shared AI context in space settings first.', 403);
    if (space.activeJob) return ok({jobId: space.activeJob.id, status: space.recommendationState.status});
    const context = await this.contextFor(space.ownerId);
    if (!context.recommendationWidgets.length) fail('Add a Recommendations widget and include it in AI context first.');
    if (!context.widgets.length) fail('Include at least one widget in AI context first.');
    const latest = this.member(actor.id, 'editor').space;
    if (String(latest.contextRevision) !== context.contextRevision || latest.settings.aiProvider !== 'cloudflare' || !latest.settings.aiConsent) fail('Space context changed. Try again.', 409);
    if (latest.activeJob) return ok({jobId: latest.activeJob.id, status: latest.recommendationState.status});
    const job: AgentJob = {id: crypto.randomUUID(), spaceId: latest.id, userId: latest.ownerId, kind: 'recommendations', provider: 'cloudflare', consentVersion: latest.settings.consentVersion, automatic, contextVersion: context.contextRevision, context, createdAt: Date.now()};
    latest.activeJob = job; latest.pendingAutoAt = undefined; latest.recommendationState = {status: 'queued', jobId: job.id};
    if (automatic) latest.lastAutomaticAt = Date.now();
    this.save(latest);
    try {
      const response = await this.directory(latest.ownerId).enqueueJob(job);
      await this.agentJobState(job.id, response.status);
      await this.schedule();
      return ok({jobId: job.id, status: response.status});
    } catch (error) {
      const result = errorResult(error);
      await this.agentJobState(job.id, 'failed', result.body.error);
      return result;
    }
  }
  private async stopRecommendations(actor: Actor): Promise<ApiResult> {
    const {space} = this.member(actor.id, 'editor');
    space.activeJob = undefined; space.pendingAutoAt = undefined; space.recommendationState = {status: 'paused'}; this.save(space);
    await this.directory(space.ownerId).cancelRecommendations(space.id, 'Recommendations stopped.');
    await this.schedule(); await this.broadcast(); return ok({ok: true});
  }
  async agentJobState(jobId: string, status: string, error?: string): Promise<void> {
    const space = this.state.get<SpaceData>('space');
    if (!space || space.deleted || space.activeJob?.id !== jobId) return;
    if (status === 'running' && space.activeJob.automatic) space.lastAutomaticAt = Date.now();
    space.recommendationState = {status, jobId, ...(error ? {error: error.slice(0, 300)} : {}), updatedAt: Date.now()};
    if (['failed', 'cancelled', 'stale'].includes(status)) space.activeJob = undefined;
    this.save(space); await this.schedule(); await this.broadcast();
  }
  async completeAgentJob(job: AgentJob, candidates: any[], warnings: {message: string}[] = []): Promise<{accepted: boolean; error?: string}> {
    if (this.state.get(`accepted-result:${job.id}`)) return {accepted: true};
    if (!await this.validateAgentJob(job) || job.kind !== 'recommendations') return {accepted: false};
    const space = this.data();
    const widgets = (await Promise.all(space.layout.map(id => this.readWidget(id, space.id)))).filter((widget): widget is WidgetRecord => Boolean(widget));
    const outputIds = new Set<string>(job.context.recommendationWidgets.map((widget: {id: string}) => widget.id));
    const outputs = widgets.filter(widget => widget.type === 'recommendations' && widget.includeInAI && outputIds.has(widget.id));
    const savedUrls = widgets.filter(widget => widget.type !== 'recommendations').flatMap(widget => widget.content.items || []).map((item: any) => item.url).filter(Boolean);
    const dismissedUrls = outputs.flatMap(widget => widget.content.dismissedUrls || []);
    const verified = await validateRecommendations(candidates, {sourceWidgetIds: job.context.widgets.map((widget: WidgetRecord) => widget.id), recommendationWidgetIds: outputs.map(widget => widget.id), savedUrls, dismissedUrls, limit: 30, maxPerKind: 15});
    if (!await this.validateAgentJob(job) || !await this.directory(job.userId).isJobActive(job.id, job.contextVersion)) return {accepted: false};
    if (!verified.items.length) {const error = warnings.length ? warnings.map(warning => warning.message).join(' ').slice(0, 300) : 'No new verified recommendations were found. Try refreshing or adding more context.'; await this.agentJobState(job.id, 'failed', error); return {accepted: false, error};}
    const applied: WidgetRecord[] = [];
    for (const output of outputs) {
      if (!await this.validateAgentJob(job)) return {accepted: false};
      const items = verified.items.filter((item: any) => output.config.sources?.includes(item.kind) && (!item.widgetId || item.widgetId === output.id));
      const count: Record<string, number> = {};
      const updated = await this.widget(output.id).replaceRecommendations(space.id, job.id, items.filter((item: any) => (count[item.kind] = (count[item.kind] || 0) + 1) <= (output.config.perSource || 3)));
      if (updated) applied.push(updated);
    }
    if (!await this.directory(job.userId).isJobActive(job.id, job.contextVersion)) return {accepted: false};
    const current = this.data();
    if (current.activeJob?.id !== job.id || current.contextRevision !== space.contextRevision) return {accepted: false};
    this.state.transaction(() => {
      for (const widget of applied) if (current.widgets[widget.id]) {current.widgets[widget.id].revision = widget.revision; current.widgets[widget.id].resultJobId = job.id;}
      current.activeJob = undefined; current.recommendationState = {status: 'up-to-date', ...(warnings.length ? {error: warnings.map(warning => warning.message).join(' ').slice(0, 300)} : {}), updatedAt: Date.now()}; this.changed(current, false);
      this.state.set(`accepted-result:${job.id}`, Date.now());
    });
    await this.broadcast(); return {accepted: true};
  }
  private async dismissRecommendation(actor: Actor, body: Record<string, any>): Promise<ApiResult> {
    const {space} = this.member(actor.id, 'editor'), id = identifier(body.widgetId);
    if (space.widgets[id]?.type !== 'recommendations' || typeof body.recommendationId !== 'string') fail('Recommendation not found.', 404);
    const widget = await this.widget(id).dismiss(space.id, body.recommendationId);
    const latest = this.member(actor.id, 'editor').space;
    if (widget && latest.widgets[id]) {latest.widgets[id].revision = widget.revision; this.changed(latest, false);}
    await this.broadcast(); return ok({widget});
  }
  private async saveRecommendation(actor: Actor, body: Record<string, any>): Promise<ApiResult> {
    const {space} = this.member(actor.id, 'editor'), id = identifier(body.widgetId);
    if (space.widgets[id]?.type !== 'recommendations') fail('Recommendation not found.', 404);
    const source = await this.widget(id).read(space.id);
    const item = source?.recommendationJobId === space.widgets[id].resultJobId ? source?.content.items?.find(entry => entry.id === body.recommendationId) : null;
    if (!item) fail('Recommendation not found.', 404);
    const type = item.kind === 'github' ? 'repositories' : 'videos';
    const targetId = body.targetWidgetId ? identifier(body.targetWidgetId) : space.layout.find(widgetId => space.widgets[widgetId].type === type);
    const target = targetId ? await this.widget(targetId).read(space.id) : null;
    if (targetId && (!target || target.type !== type || !space.widgets[targetId])) fail('Choose a matching video or repository widget.');
    if (target?.content.items?.some(saved => saved.url === item.url)) return ok({widget: target});
    const result = await this.writeWidget(actor, targetId || null, {type, ...(target ? {revision: target.revision} : {}), content: {items: [...(target?.content.items || []), {id: crypto.randomUUID(), url: item.url, notes: item.reason || ''}]}});
    if (result.status < 300) await this.dismissRecommendation(actor, body);
    return result;
  }

  async fetch(request: Request): Promise<Response> {
    if (this.env.SPACES_ENABLED !== 'true') return new Response('Not found.', {status: 404});
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket required.', {status: 426});
    let actor: Actor;
    try {actor = JSON.parse(request.headers.get('x-lr-actor') || 'null'); if (!actor?.id) throw new Error(); this.member(actor.id);}
    catch {return new Response('Space not found.', {status: 404});}
    if (!await actorSessionActive(this.env, actor)) return new Response('Session expired.', {status: 401});
    try {this.member(actor.id);} catch {return new Response('Space not found.', {status: 404});}
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]); pair[1].serializeAttachment(actor);
    pair[1].send(JSON.stringify({type: 'space.changed', revision: this.data().revision}));
    return new Response(null, {status: 101, webSocket: pair[0]});
  }
  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (this.env.SPACES_ENABLED !== 'true') {socket.close(4003, 'Spaces are disabled.'); return;}
    const actor = socket.deserializeAttachment() as Actor;
    if (!await actorSessionActive(this.env, actor) || !await this.inspectAccess(actor.id)) {socket.close(4003, 'Session or membership expired.'); return;}
    if (typeof message !== 'string' || message.length > 1000) {socket.close(1009, 'Message too large.'); return;}
    socket.send(JSON.stringify({type: 'space.changed', revision: this.data().revision}));
  }
  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {socket.close(code, reason);}
  async webSocketError(socket: WebSocket): Promise<void> {socket.close(1011, 'Connection interrupted.');}
  private async broadcast(): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    await Promise.all(sockets.map(async socket => {
      try {
        const actor = socket.deserializeAttachment() as Actor;
        if (!await actorSessionActive(this.env, actor) || !await this.inspectAccess(actor.id)) {socket.close(4003, 'Session or membership expired.'); return;}
        socket.send(JSON.stringify({type: 'space.changed', revision: this.data().revision}));
      } catch {try {socket.close(1011, 'Connection interrupted.');} catch { /* Already closed. */ }}
    }));
  }
  async alarm(): Promise<void> {
    await this.flush(this.state.list<Operation>('pending:').slice(0, 50).map(row => row.value));
    const space = this.state.get<SpaceData>('space');
    if (!space || space.deleted) return;
    if (this.env.SPACES_ENABLED !== 'true' || this.env.SPACES_AI_ENABLED !== 'true') {space.pendingAutoAt = undefined; this.save(space); await this.ctx.storage.deleteAlarm(); return;}
    if (space.pendingAutoAt && space.pendingAutoAt <= Date.now() && (space.lastAutomaticAt || 0) + 600_000 <= Date.now() && space.settings.automaticRecommendations && space.settings.aiConsent) {
      try {await this.requestRecommendations(space.members[space.ownerId], true);}
      catch (error) {const latest = this.data(); latest.pendingAutoAt = undefined; latest.recommendationState = {status: 'failed', error: 'Add some included content and refresh recommendations.'}; this.save(latest);}
    }
    await this.schedule();
  }
}
