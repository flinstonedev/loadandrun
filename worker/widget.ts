import {DurableObject} from 'cloudflare:workers';
import {normalizeWidget} from '../src/widget-schema.js';
import {SqlState, ok, fail, errorResult} from './spaces-common';
import type {ApiResult} from './spaces-types';

export interface WidgetMetadata {
  id: string | number; url: string; kind?: string; title?: string; fullName?: string;
  description?: string; language?: string; archived?: boolean; stars?: number;
  channel?: string; thumbnail?: string; verifiedAt?: string; fetchedAt?: string;
  license?: {name: string; spdxId: string; url: string} | null;
}
export interface WidgetItem {
  id: string; url?: string; label?: string; description?: string; tags?: string[];
  text?: string; done?: boolean; address?: string; annotation?: string; notes?: string;
  metadata?: WidgetMetadata; kind?: string; title?: string; reason?: string;
  sourceWidgetIds?: string[]; widgetId?: string; verifiedAt?: string;
  channel?: string; thumbnail?: string; fullName?: string;
}
export interface WidgetContent {markdown?: string; items?: WidgetItem[]; dismissedUrls?: string[]}
export interface WidgetConfig {preview?: boolean; showCompleted?: boolean; topic?: string; sources?: string[]; perSource?: number}
export interface WidgetRecord {
  id: string; spaceId: string; type: string; title: string; width: number;
  collapsed: boolean; includeInAI: boolean; revision: number;
  content: WidgetContent; config: WidgetConfig; updatedAt: number;
  recommendationJobId?: string;
}

// These RPC methods are called only by a parent Space, never by the HTTP router.
export class Widget extends DurableObject<Env> {
  private state: SqlState;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.state = new SqlState(ctx.storage);
  }

  private stored(spaceId: string): WidgetRecord | null {
    const record = this.state.get<WidgetRecord>('widget');
    return record?.spaceId === spaceId && !this.state.get('deleted') ? record : null;
  }
  async read(spaceId: string): Promise<WidgetRecord | null> {return this.stored(spaceId);}

  async write(spaceId: string, input: WidgetRecord, operationId: string): Promise<ApiResult> {
    try {
      if (this.state.get('deleted')) fail('This widget was deleted.', 404);
      const old = this.state.get<WidgetRecord>('widget');
      if (old && old.spaceId !== spaceId) fail('Widget not found.', 404);
      const done = this.state.get<WidgetRecord>(`operation:${operationId}`);
      if (done) return ok({widget: done});
      if (input.spaceId !== spaceId || (old && input.id !== old.id)) fail('Widget not found.', 404);
      if (old && old.revision !== input.revision) return {status: 409, body: {error: 'This widget changed. Review the latest version before saving.', widget: old}};
      const normalized = normalizeWidget(input, old);
      // Only the parent supplies metadata after resolving a provider URL.
      if (['repositories', 'videos'].includes(input.type)) {
        normalized.content.items = normalized.content.items.map((item: any) => {
          const verified = input.content.items?.find((entry: any) => entry.id === item.id && entry.url === item.url)?.metadata;
          return {...item, ...(verified ? {metadata: verified} : {})};
        });
      }
      const widget: WidgetRecord = {...normalized, id: input.id, spaceId, revision: (old?.revision || 0) + 1, updatedAt: Date.now()};
      this.state.transaction(() => {
        this.state.set('widget', widget);
        this.state.set(`operation:${operationId}`, widget);
        // Keep enough operation receipts for retries without unbounded history.
        const receipts = this.state.list<WidgetRecord>('operation:');
        receipts.sort((a, b) => a.value.updatedAt - b.value.updatedAt).slice(0, Math.max(0, receipts.length - 200)).forEach(row => this.state.delete(row.key));
      });
      return ok({widget}, old ? 200 : 201);
    } catch (error) {return errorResult(error);}
  }

  async replaceRecommendations(spaceId: string, jobId: string, items: WidgetItem[]): Promise<WidgetRecord | null> {
    const widget = this.stored(spaceId);
    if (!widget || widget.type !== 'recommendations' || this.state.get(`result:${jobId}`)) return widget;
    const excluded = new Set(widget.content.dismissedUrls || []);
    widget.content.items = items.filter(item => item.url && !excluded.has(item.url));
    widget.recommendationJobId = jobId;
    widget.revision++;
    widget.updatedAt = Date.now();
    this.state.transaction(() => {this.state.set('widget', widget); this.state.set(`result:${jobId}`, true);});
    return widget;
  }

  async dismiss(spaceId: string, recommendationId: string): Promise<WidgetRecord | null> {
    const widget = this.stored(spaceId);
    if (!widget || widget.type !== 'recommendations') return null;
    const item = widget.content.items?.find(entry => entry.id === recommendationId);
    if (!item) return widget;
    widget.content.items = widget.content.items?.filter(entry => entry.id !== recommendationId);
    widget.content.dismissedUrls = [...new Set([...(widget.content.dismissedUrls || []), ...(item.url ? [item.url] : [])])].slice(-1000);
    widget.revision++;
    widget.updatedAt = Date.now();
    this.state.set('widget', widget);
    return widget;
  }

  async discard(spaceId: string): Promise<void> {
    const widget = this.state.get<WidgetRecord>('widget');
    if (widget && widget.spaceId !== spaceId) return;
    this.state.transaction(() => {
      for (const row of this.state.list()) this.state.delete(row.key);
      // A tombstone prevents delayed initialization or retries from resurrection.
      this.state.set('deleted', {spaceId, at: Date.now()});
    });
  }
}
