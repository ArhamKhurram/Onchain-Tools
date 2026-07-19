const STORAGE_KEY = 'oct_discord_tokens_v1';

export function getLocalDiscordTokens(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is string => typeof t === 'string' && t.length > 0);
  } catch {
    return [];
  }
}

export function setLocalDiscordTokens(tokens: string[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
}

export function clearLocalDiscordTokens(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function hasLocalDiscordTokens(): boolean {
  return getLocalDiscordTokens().length > 0;
}

export function maskDiscordToken(token: string): string {
  const len = token.length;
  const visible = Math.min(4, Math.floor(len / 4));
  return len <= 8
    ? '*'.repeat(len)
    : token.slice(0, visible) + '*'.repeat(Math.max(4, len - visible * 2)) + token.slice(-visible);
}
