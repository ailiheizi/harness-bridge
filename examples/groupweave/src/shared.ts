export type Role = 'admin' | 'member';
export interface Persona { id: string; name: string; label: string; platformAdmin: boolean }
export interface GroupConfig {
  responseMode: 'mention' | 'command';
  language: 'zh' | 'en';
  features: string[];
  deduplicate: boolean;
  sort: boolean;
  maxItems: number;
  /** Literal welcome template; {name}/{group} are text substitutions only. */
  welcomeText?: string;
  /** Detection recommendations only; paths and model ownership stay with the platform. */
  antiadPromptThreshold?: number;
  antiadActionThreshold?: number;
  antiadStopwords?: string[];
}
export interface Group {
  id: string; name: string; description: string; initials: string;
  memberCount: number; role: Role; version: number; config: GroupConfig;
  /** Server-owned feature authorization counters; ordinary parameter edits do not change them. */
  featureVersions?: Record<string, number>;
}
export interface Plugin {
  id: string; name: string; description: string; kind: 'code' | 'agent';
  enabled: boolean; available: boolean; scope: string; color: string;
  authorizationVersion?: number;
}
export interface Proposal {
  id: string; groupId: string; creatorId: string; baseVersion: number;
  candidate: GroupConfig; before: GroupConfig; warnings: string[];
  changes: string[]; text: string; status: 'pending' | 'active'; createdAt: string;
}
export interface Task {
  id: string; groupId: string; creatorId: string; featureId: string;
  status: 'succeeded' | 'failed' | 'blocked'; audience: 'private' | 'group';
  configVersion: number; createdAt: string; durationMs: number; modelCalls: number | null;
  /** Application authorization snapshot, never accepted from clients or model arguments. */
  authorization?: { platformVersion: number; groupVersion: number; codePlatformVersion?: number; codeGroupVersion?: number };
  /** Actual native tool dispatch attempts when evidenced; success also requires a completed task. */
  toolCalls?: number;
  usage?: { inputTokens: number; outputTokens: number; totalTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number } | null;
  input: string; inputHidden?: boolean; output: string; error?: string;
}
export interface Me {
  persona: Persona; personas: Persona[]; preview: boolean; telegramConnected: boolean;
  harness: string;
}
export interface Overview {
  groups: Group[]; plugins: Plugin[]; tasks: Task[];
}
