import {DurableObject} from 'cloudflare:workers';
import {hostedModel, hostedAIAvailable, runHostedJob} from './ai';
import {errorResult, fail, identifier, objectName, ok, SqlState} from './spaces-common';
import type {Actor, AgentJob, ApiResult, SpaceInvitation, SpaceSummary} from './spaces-types';

const JOB_LIFETIME = 3 * 60_000;
const DAILY_AUTOMATIC_LIMIT = 12;
const DAILY_MANUAL_LIMIT = 40;
const RETENTION = 7 * 86400_000;
const TERMINAL = new Set(['completed', 'cancelled', 'failed', 'stale']);
type JobStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed' | 'stale';
interface StoredJob {job: AgentJob; provider?: 'cloudflare'; status: JobStatus; startedAt?: number; finishedAt?: number; error?: string; progress?: string;}
interface ChatMessage {id: string; role: 'user' | 'assistant'; text: string; createdAt: number;}
interface ChatState {contextVersion: string; messages: ChatMessage[];}
interface JobNotification {jobId: string; spaceId: string; status: string; error?: string;}

function shortText(value: unknown, max: number, fallback = '') {
  return typeof value === 'string' ? value.trim().slice(0, max) : fallback;
}
function publicJob(row: StoredJob) {
  return {id: row.job.id, spaceId: row.job.spaceId, kind: row.job.kind, automatic: row.job.automatic, status: row.status, error: row.error, progress: row.progress, createdAt: row.job.createdAt};
}

/** Per-builder discovery indexes, private conversations, and metered hosted AI jobs. */
export class SpaceDirectory extends DurableObject<Env> {
  private data: SqlState;
  // Abort handles are an optimization; SQL terminal states are the authority after cancellation/restart.
  private runs = new Map<string, AbortController>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.data = new SqlState(ctx.storage);
    this.retireLocalAgent();
    this.ctx.waitUntil(this.schedule());
  }

  initialize(builderId: string) {
    identifier(builderId, 'Builder');
    const existing = this.data.get<string>('builder');
    if (existing && existing !== builderId) fail('Directory identity mismatch.', 403);
    if (!existing) this.data.set('builder', builderId);
  }

  setSpaceIndex(entry: SpaceSummary) {this.data.set(`space:${identifier(entry.id)}`, entry);}
  removeSpaceIndex(spaceId: string) {this.data.delete(`space:${identifier(spaceId)}`);}
  putInvitation(invitation: SpaceInvitation) {
    this.initialize(invitation.toUserId);
    this.data.set(`invite:${identifier(invitation.id)}`, invitation);
  }
  removeInvitation(invitationId: string) {this.data.delete(`invite:${identifier(invitationId)}`);}
  private space(spaceId: string) {return this.env.SPACES.getByName(objectName(this.env.WORKSPACE_ID, identifier(spaceId, 'Space')));}
  private rows() {return this.data.list<StoredJob>('job:').map(entry => entry.value);}
  private saveJob(row: StoredJob) {this.data.set(`job:${row.job.id}`, row);}
  private usage(automatic = true) {return this.data.get<number>(`${automatic ? 'usage' : 'manual-usage'}:${new Date().toISOString().slice(0, 10)}`) || 0;}

  private retireLocalAgent() {
    this.ctx.setWebSocketAutoResponse();
    for (const ws of this.ctx.getWebSockets('companion')) this.closeRetiredSocket(ws);
    this.data.transaction(() => {
      this.data.delete('device');
      this.data.delete('account');
      if (!this.data.get('migration:hosted-ai-v1')) {
        // Previous conversations remain readable, but their contents never become
        // Cloudflare model history merely because the provider changed.
        for (const {key, value} of this.data.list<ChatState>('chat:')) {
          if (value.messages.length) this.data.set(`chat-archive:${key.slice(5)}`, value.messages);
          this.data.delete(key);
        }
        this.data.set('migration:hosted-ai-v1', true);
      }
      for (const {key} of this.data.list('pair:')) this.data.delete(key);
      for (const row of this.rows()) {
        if (row.provider === 'cloudflare' || TERMINAL.has(row.status)) continue;
        const reason = 'Local Codex connections have been retired. Start a new request with hosted AI.';
        this.saveJob({...row, status: 'cancelled', progress: undefined, finishedAt: Date.now(), error: reason});
        if (row.job.kind === 'recommendations') this.notifyJob(row.job, 'cancelled', reason);
      }
    });
  }

  private closeRetiredSocket(ws: WebSocket) {
    try {ws.close(4001, 'Local connections have been retired. Use hosted AI in Spaces.');} catch { /* Socket already closed. */ }
  }

  private manualCapacity() {
    const queued = this.rows().filter(row => !row.job.automatic && row.status === 'queued').length;
    if (this.usage(false) + queued >= DAILY_MANUAL_LIMIT) fail('Daily AI request limit reached. Try again tomorrow (UTC).', 429);
  }

  async dispatch(actor: Actor, method: string, action: string, body: Record<string, unknown> = {}): Promise<ApiResult> {
    try {
      this.initialize(actor.id);
      action = action.replace(/^\/+|\/+$/g, '');
      if (action === 'spaces' && method === 'GET') {
        const spaces: SpaceSummary[] = [];
        for (const {value: entry} of this.data.list<SpaceSummary>('space:')) {
          const current = await this.space(entry.id).inspectAccess(actor.id);
          if (!current) this.removeSpaceIndex(entry.id);
          else spaces.push({id: current.id, title: current.title, ownerId: current.ownerId, role: current.role, updatedAt: 'updatedAt' in current ? Number(current.updatedAt) : entry.updatedAt});
        }
        return ok({spaces: spaces.sort((a, b) => b.updatedAt - a.updatedAt), invitations: await this.invitations(actor.id)});
      }
      if (action === 'spaces' && method === 'POST') {
        const title = shortText(body.title, 100, 'My space') || 'My space';
        const operationId = body.operationId ? identifier(body.operationId, 'Operation') : crypto.randomUUID();
        const operationKey = `create:${operationId}`;
        const pending = this.data.get<{id: string; title: string; actor: Actor}>(operationKey) || {id: crypto.randomUUID(), title, actor: {id: actor.id, name: actor.name}};
        this.data.set(operationKey, pending);
        await this.schedule();
        const result = await this.space(pending.id).init(actor, {id: pending.id, title: pending.title});
        if (result.status < 400) this.data.set(operationKey, {...pending, completed: true});
        return result;
      }
      if (action === 'invitations' && method === 'GET') return ok({invitations: await this.invitations(actor.id)});
      if (method === 'POST' && /^invitations(?:\/[^/]+)?\/(accept|decline)$/.test(action)) {
        const invitationId = identifier(body.invitationId || body.id || action.split('/')[1], 'Invitation');
        const invitation = this.data.get<SpaceInvitation>(`invite:${invitationId}`);
        if (!invitation || invitation.toUserId !== actor.id) fail('Invitation not found.', 404);
        const result = action.endsWith('/accept') ? await this.space(invitation.spaceId).acceptInvitation(actor, invitationId) : await this.space(invitation.spaceId).declineInvitation(actor, invitationId);
        if (result.status < 400 || result.status === 404) this.removeInvitation(invitationId);
        return result;
      }
      if (action === 'status' && method === 'GET') {
        await this.pump();
        return ok({provider: 'cloudflare', available: hostedAIAvailable(this.env), model: hostedModel(this.env),
          jobs: this.rows().sort((a, b) => b.job.createdAt - a.job.createdAt).slice(0, 30).map(publicJob),
          usage: {automaticRuns: this.usage(), limit: DAILY_AUTOMATIC_LIMIT, manualRuns: this.usage(false), manualLimit: DAILY_MANUAL_LIMIT}});
      }
      if (action === 'chat' && method === 'GET') {
        const spaceId = identifier(body.spaceId, 'Space');
        const context = await this.space(spaceId).contextFor(actor.id);
        const chat = await this.currentChat(spaceId, context.contextRevision);
        if (!await this.space(spaceId).inspectAccess(actor.id)) fail('Space not found.', 404);
        const job = this.rows().filter(row => row.job.spaceId === spaceId && row.job.kind === 'chat').sort((a, b) => b.job.createdAt - a.job.createdAt)[0];
        return ok({messages: chat.messages, archivedMessages: this.data.get<ChatMessage[]>(`chat-archive:${spaceId}`) || [], job: job ? publicJob(job) : null, contextRevision: chat.contextVersion});
      }
      if (action === 'chat' && method === 'POST') {
        const spaceId = identifier(body.spaceId, 'Space');
        const message = shortText(body.message, 8_000);
        if (!message) fail('Write a message first.');
        if (!hostedAIAvailable(this.env)) fail('Hosted AI is currently unavailable. Try again later.', 503);
        this.manualCapacity();
        const context = await this.space(spaceId).contextFor(actor.id);
        const chat = await this.currentChat(spaceId, context.contextRevision);
        if (this.rows().some(row => row.job.kind === 'chat' && row.job.spaceId === spaceId && !TERMINAL.has(row.status))) fail('Wait for the current reply or stop it first.', 409);
        const job: AgentJob = {id: crypto.randomUUID(), spaceId, userId: actor.id, kind: 'chat', provider: 'cloudflare', automatic: false, contextVersion: context.contextRevision, context,
          message, history: chat.messages.slice(-30).map(item => ({role: item.role, content: item.text})), model: hostedModel(this.env).id, createdAt: Date.now()};
        const queued = await this.enqueueJob(job);
        if (queued.status === 'stale') fail('Space context changed. Send your message again.', 409);
        return ok({...queued, messages: this.data.get<ChatState>(`chat:${spaceId}`)?.messages || []}, 202);
      }
      if (action === 'chat/reset' && method === 'POST') {
        const spaceId = identifier(body.spaceId, 'Space');
        await this.space(spaceId).contextFor(actor.id);
        this.data.delete(`chat:${spaceId}`);
        await this.cancelJobs(spaceId, 'Conversation reset.', 'chat');
        return ok({ok: true, messages: []});
      }
      if (action === 'cancel' && method === 'POST') {
        const row = this.data.get<StoredJob>(`job:${identifier(body.jobId, 'Job')}`);
        if (!row || row.job.userId !== actor.id) fail('Job not found.', 404);
        if (!await this.space(row.job.spaceId).inspectAccess(actor.id)) fail('Space not found.', 404);
        await this.finish(row, 'cancelled', 'Stopped by you.');
        await this.pump();
        return ok({ok: true});
      }
      return {status: 404, body: {error: 'Not found.'}};
    } catch (error) {return errorResult(error);}
  }

  private async invitations(userId: string) {
    const result: SpaceInvitation[] = [];
    for (const {value: invitation} of this.data.list<SpaceInvitation>('invite:')) {
      const current = await this.space(invitation.spaceId).inspectInvitation(userId, invitation.id);
      if (current) result.push(current);
      else this.removeInvitation(invitation.id);
    }
    return result;
  }

  // Retain only closed transport handlers for sockets hibernated by the previous release.
  async fetch(_request: Request): Promise<Response> {
    return Response.json({error: 'Local agent connections have been retired. Use hosted AI in Spaces.'}, {status: 410});
  }
  async webSocketMessage(ws: WebSocket, _raw: string | ArrayBuffer) {this.closeRetiredSocket(ws);}
  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean) {this.closeRetiredSocket(ws);}
  async webSocketError(ws: WebSocket) {this.closeRetiredSocket(ws);}

  async enqueueJob(job: AgentJob) {
    this.initialize(job.userId);
    if (!hostedAIAvailable(this.env)) fail('Hosted AI is currently unavailable. Try again later.', 503);
    if (job.kind !== 'recommendations' && job.kind !== 'chat') fail('Unsupported agent job.');
    identifier(job.id, 'Job');
    const existing = this.data.get<StoredJob>(`job:${job.id}`);
    if (existing) return {jobId: job.id, status: this.queueStatus(existing)};
    if (!await this.space(job.spaceId).validateAgentJob(job)) return {jobId: job.id, status: 'stale'};
    if (job.kind === 'chat' && job.automatic) fail('Private chat cannot run automatically.');
    if (JSON.stringify(job).length > 300_000) fail('Selected context is too large. Exclude some widgets from AI context.', 413);
    if (this.rows().filter(row => !TERMINAL.has(row.status)).length >= 50) fail('Too many pending agent requests. Stop a request first.', 429);
    if (job.automatic) {
      for (const row of this.rows()) if (row.job.id !== job.id && row.job.automatic && row.job.spaceId === job.spaceId && row.status === 'queued') await this.finish(row, 'stale', 'Replaced by newer space content.');
    }
    // Recheck after awaited cross-object validation: duplicate RPC retries reserve one queue entry.
    const concurrent = this.data.get<StoredJob>(`job:${job.id}`);
    if (concurrent) return {jobId: job.id, status: this.queueStatus(concurrent)};
    if (!job.automatic) this.manualCapacity();
    if (job.kind === 'chat' && this.rows().some(row => row.job.kind === 'chat' && row.job.spaceId === job.spaceId && !TERMINAL.has(row.status))) fail('Wait for the current reply or stop it first.', 409);
    this.data.transaction(() => {
      if (job.kind === 'chat') {
        // Queue admission and prompt persistence must be one atomic operation. Concurrent
        // submissions otherwise overwrite each other's prompt before either reserves a job.
        const previous = this.data.get<ChatState>(`chat:${job.spaceId}`);
        const chat: ChatState = previous?.contextVersion === job.contextVersion ? previous : {contextVersion: job.contextVersion, messages: []};
        job = {...job, history: chat.messages.slice(-30).map(item => ({role: item.role, content: item.text}))};
        chat.messages.push({id: crypto.randomUUID(), role: 'user', text: shortText(job.message, 8_000), createdAt: Date.now()});
        chat.messages = chat.messages.slice(-60);
        this.data.set(`chat:${job.spaceId}`, chat);
      }
      this.saveJob({job: {...job, model: hostedModel(this.env).id}, provider: 'cloudflare', status: 'queued'});
    });
    await this.schedule();
    await this.pump();
    return {jobId: job.id, status: this.queueStatus(this.data.get<StoredJob>(`job:${job.id}`)!)};
  }

  private queueStatus(row: StoredJob): string {
    if (row.status === 'queued' && row.job.kind === 'recommendations') {
      if (row.job.automatic && this.usage() >= DAILY_AUTOMATIC_LIMIT) return 'rate-limited';
    }
    return row.status;
  }

  async cancelSpaceJobs(spaceId: string, reason = 'Space context changed. Refresh to use the latest content.', keepContextVersion?: string) {
    await this.cancelJobs(spaceId, reason, undefined, keepContextVersion);
    const chat = this.data.get<ChatState>(`chat:${spaceId}`);
    if (!keepContextVersion || chat?.contextVersion !== keepContextVersion) this.data.delete(`chat:${spaceId}`);
    if (!keepContextVersion) this.data.delete(`chat-archive:${spaceId}`);
    await this.pump();
    await this.schedule();
  }
  async cancelRecommendations(spaceId: string, reason = 'Recommendations stopped.') {
    await this.cancelJobs(spaceId, reason, 'recommendations');
    await this.pump();
    await this.schedule();
  }
  isJobActive(jobId: string, contextVersion: string) {
    const row = this.data.get<StoredJob>(`job:${identifier(jobId, 'Job')}`);
    return Boolean(row && row.status === 'running' && row.job.contextVersion === contextVersion);
  }
  private async cancelJobs(spaceId: string, reason: string, kind?: AgentJob['kind'], keepContextVersion?: string) {
    for (const row of this.rows()) if (row.job.spaceId === spaceId && (!kind || row.job.kind === kind) && (!keepContextVersion || row.job.contextVersion !== keepContextVersion) && !TERMINAL.has(row.status)) await this.finish(row, 'cancelled', reason);
  }
  private async currentChat(spaceId: string, contextVersion: string): Promise<ChatState> {
    const existing = this.data.get<ChatState>(`chat:${spaceId}`);
    if (existing && existing.contextVersion !== contextVersion) {
      await this.cancelJobs(spaceId, 'The selected context changed. A fresh conversation is ready.', 'chat');
      if (this.data.get<ChatState>(`chat:${spaceId}`)?.contextVersion === existing.contextVersion) this.data.delete(`chat:${spaceId}`);
    }
    return existing?.contextVersion === contextVersion ? existing : {contextVersion, messages: []};
  }

  private notifyJob(job: AgentJob, status: string, error?: string) {
    this.data.set(`notify:${job.id}`, {jobId: job.id, spaceId: job.spaceId, status, error} satisfies JobNotification);
  }

  private async notifications() {
    for (const {key, value} of this.data.list<JobNotification>('notify:')) {
      try {
        await this.space(value.spaceId).agentJobState(value.jobId, value.status, value.error);
        // A later state may have replaced this notification during the RPC.
        if (JSON.stringify(this.data.get(key)) === JSON.stringify(value)) this.data.delete(key);
      } catch { /* Retry the durable notification on an alarm. */ }
    }
  }

  private async finish(row: StoredJob, status: JobStatus, error?: string) {
    const current = this.data.get<StoredJob>(`job:${row.job.id}`);
    if (!current || TERMINAL.has(current.status)) return;
    this.data.transaction(() => {
      this.saveJob({...current, status, error, progress: undefined, finishedAt: Date.now()});
      if (row.job.kind === 'recommendations') this.notifyJob(row.job, status, error);
    });
    if (status !== 'completed') this.runs.get(row.job.id)?.abort();
    await this.notifications();
    await this.schedule();
  }

  private async pump() {
    await this.notifications();
    if (!hostedAIAvailable(this.env) || this.rows().some(row => row.status === 'running')) return;
    const candidates = this.rows().filter(row => row.status === 'queued').sort((a, b) => Number(a.job.kind !== 'chat') - Number(b.job.kind !== 'chat') || a.job.createdAt - b.job.createdAt);
    for (const row of candidates) {
      if (row.provider !== 'cloudflare' || !await this.space(row.job.spaceId).validateAgentJob(row.job)) {
        await this.finish(row, 'stale', 'Space context or access changed.'); continue;
      }
      // Every await above permits a concurrent request to reserve or cancel work.
      if (this.rows().some(candidate => candidate.status === 'running')) return;
      const current = this.data.get<StoredJob>(`job:${row.job.id}`);
      if (!current || current.status !== 'queued') continue;
      if (row.job.automatic && this.usage() >= DAILY_AUTOMATIC_LIMIT) {
        this.notifyJob(row.job, 'rate-limited', 'Daily automatic recommendation limit reached. Your latest context is queued for tomorrow (UTC).');
        await this.notifications();
        continue;
      }
      if (!row.job.automatic && this.usage(false) >= DAILY_MANUAL_LIMIT) {
        await this.finish(row, 'failed', 'Daily AI request limit reached. Try again tomorrow (UTC).'); continue;
      }
      this.data.transaction(() => {
        const usageKey = `${row.job.automatic ? 'usage' : 'manual-usage'}:${new Date().toISOString().slice(0, 10)}`;
        this.data.set(usageKey, this.usage(row.job.automatic) + 1);
        this.saveJob({...current, status: 'running', startedAt: Date.now()});
        if (row.job.kind === 'recommendations') this.notifyJob(row.job, 'running');
      });
      // Set a recovery deadline before starting paid inference. Never replay a running job.
      await this.schedule();
      const controller = new AbortController();
      this.runs.set(row.job.id, controller);
      this.ctx.waitUntil(this.run(row.job, controller));
      return;
    }
    await this.schedule();
  }

  private async run(job: AgentJob, controller: AbortController) {
    try {
      await this.notifications();
      if (!await this.space(job.spaceId).validateAgentJob(job)) {await this.finish({job, status: 'running'}, 'stale', 'Space context or access changed.'); return;}
      if (!this.isJobActive(job.id, job.contextVersion)) return;
      const result = await runHostedJob(this.env, job, text => {
        const current = this.data.get<StoredJob>(`job:${job.id}`);
        if (current?.status === 'running') this.saveJob({...current, progress: shortText(text, 2_000)});
      }, controller.signal);
      if (!this.isJobActive(job.id, job.contextVersion)) return;
      if (!await this.space(job.spaceId).validateAgentJob(job)) {await this.finish({job, status: 'running'}, 'stale', 'Space context or access changed.'); return;}
      if (!this.isJobActive(job.id, job.contextVersion)) return;
      let accepted = false;
      let error: string | undefined;
      if (job.kind === 'recommendations') {
        const candidates = Array.isArray(result.recommendations) ? result.recommendations.slice(0, 30) : [];
        const outcome = await this.space(job.spaceId).completeAgentJob(job, candidates, result.warnings);
        if (!this.isJobActive(job.id, job.contextVersion)) return;
        accepted = outcome.accepted;
        error = outcome.error;
      } else {
        const reply = shortText(result.text, 40_000);
        const chat = this.data.get<ChatState>(`chat:${job.spaceId}`);
        if (reply && chat?.contextVersion === job.contextVersion) {
          chat.messages.push({id: job.id, role: 'assistant', text: reply, createdAt: Date.now()});
          chat.messages = chat.messages.slice(-60);
          this.data.set(`chat:${job.spaceId}`, chat);
          accepted = true;
        }
      }
      await this.finish({job, status: 'running'}, accepted ? 'completed' : error ? 'failed' : 'stale', accepted ? undefined : error || 'The result was no longer applicable or had no verified content.');
    } catch {
      // Provider errors may contain prompts or credentials; expose a fixed retry message only.
      await this.finish({job, status: 'running'}, 'failed', 'Hosted AI could not complete this request. Try again later.');
    } finally {
      this.runs.delete(job.id);
      await this.pump();
      await this.schedule();
    }
  }

  private async schedule() {
    const now = Date.now();
    const rows = this.rows();
    const times = rows.filter(row => row.status === 'running').map(row => (row.startedAt || now) + JOB_LIFETIME);
    for (const row of rows) if (TERMINAL.has(row.status)) times.push((row.finishedAt || row.job.createdAt) + RETENTION);
    if (rows.some(row => row.status === 'queued')) {
      const midnight = new Date(now); midnight.setUTCHours(24, 0, 0, 0);
      // The latest automatic snapshot resumes at UTC midnight after its daily budget resets.
      times.push(this.usage() >= DAILY_AUTOMATIC_LIMIT && rows.filter(row => row.status === 'queued').every(row => row.job.automatic) ? midnight.getTime() : now + 30_000);
    }
    if (this.data.list('notify:').length || this.data.list<{completed?: boolean}>('create:').some(({value}) => !value.completed)) times.push(now + 30_000);
    if (!times.length) {await this.ctx.storage.deleteAlarm(); return;}
    await this.ctx.storage.setAlarm(Math.max(now + 1000, Math.min(...times)));
  }

  async alarm() {
    const now = Date.now();
    for (const {key, value} of this.data.list<StoredJob>('job:')) {
      if (value.status === 'running' && (value.startedAt || value.job.createdAt) + JOB_LIFETIME <= now) {
        await this.finish(value, 'failed', 'The AI request timed out or was interrupted. Start a new request to try again.');
      } else if (TERMINAL.has(value.status) && (value.finishedAt || value.job.createdAt) + RETENTION < now) this.data.delete(key);
    }
    for (const {key, value} of this.data.list<{id: string; title: string; actor: Actor; completed?: boolean}>('create:')) {
      if (value.completed) continue;
      try {const result = await this.space(value.id).init(value.actor, {id: value.id, title: value.title}); if (result.status < 400) this.data.set(key, {...value, completed: true});} catch { /* Retry persisted creation on the next alarm. */ }
    }
    const retentionDate = new Date(now - RETENTION).toISOString().slice(0, 10);
    for (const prefix of ['usage:', 'manual-usage:']) for (const {key} of this.data.list<number>(prefix)) if (key.slice(prefix.length) < retentionDate) this.data.delete(key);
    await this.pump();
    await this.schedule();
  }
}
