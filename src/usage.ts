import type { Usage } from './types.ts';
export function validUsage(value: unknown): Usage | undefined {
  if (!value || typeof value !== 'object') return;
  const u = value as Usage;
  if (
    ![u.prompt_tokens, u.completion_tokens, u.total_tokens].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) ||
    u.total_tokens !== u.prompt_tokens + u.completion_tokens
  )
    return;
  return {
    prompt_tokens: u.prompt_tokens,
    completion_tokens: u.completion_tokens,
    total_tokens: u.total_tokens,
  };
}
