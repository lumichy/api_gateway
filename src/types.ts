export type Message = { role: 'system' | 'developer' | 'user' | 'assistant'; content: string };
export type ChatRequest = { model: string; messages: Message[]; stream: boolean };
export type Usage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };
export type ProviderEvent =
  | { type: 'text'; text: string }
  | { type: 'done'; usage?: Usage; finishReason?: 'stop' | 'length' };
export type QuotaWindow = {
  unit: 'requests' | 'tokens' | 'credits' | 'percent';
  remaining: number | null;
  limit?: number | null;
  usedPercent?: number | null;
  resetAt: number | null;
};
export type QuotaSnapshot = {
  source: 'official' | 'manual' | 'estimated' | 'unknown';
  observedAt: number;
  pool?: string;
  windows: QuotaWindow[];
  reported?: QuotaSnapshot;
};
export interface Provider {
  id: string;
  models: string[];
  enabled: boolean;
  priority: number;
  maxConcurrency: number;
  capabilities: { system: boolean; history: boolean };
  reservationCosts?: { requests: number; outputTokens: number; credits?: number };
  validate?(request: ChatRequest): void;
  health(signal?: AbortSignal): Promise<{ available: boolean; detail?: string }>;
  quota(model: string, signal: AbortSignal): Promise<QuotaSnapshot>;
  invoke(request: ChatRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
}
export type RoutedEvent = ProviderEvent & { providerId: string; model: string };
export type ErrorKind =
  | 'quota_exhausted'
  | 'rate_limited'
  | 'auth_required'
  | 'transient'
  | 'invalid_request'
  | 'unsupported'
  | 'cancelled';
