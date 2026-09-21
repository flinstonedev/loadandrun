export interface Actor {
  id: string;
  name: string;
  sessionExpiresAt?: number;
  sessionId?: string;
}

export interface ApiResult {
  status: number;
  body: any;
}

export type SpaceRole = 'owner' | 'editor' | 'viewer';
export interface SpaceSummary {
  id: string;
  title: string;
  ownerId: string;
  role?: SpaceRole;
  updatedAt: number;
}

export interface SpaceInvitation {
  id: string;
  spaceId: string;
  spaceTitle: string;
  from: Actor;
  toUserId: string;
  toName?: string;
  role: 'viewer' | 'editor';
  createdAt: number;
}

export interface AgentJob {
  id: string;
  spaceId: string;
  userId: string;
  kind: 'recommendations' | 'chat';
  automatic: boolean;
  provider?: 'cloudflare';
  consentVersion?: number;
  contextVersion: string;
  context: any;
  message?: string;
  history?: {role: 'user' | 'assistant'; content: string}[];
  model?: string;
  createdAt: number;
}
