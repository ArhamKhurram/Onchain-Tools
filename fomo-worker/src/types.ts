export interface FomoCredentials {
  refreshToken: string;
  privyAppId?: string;
  privyClient?: string;
  privyClientId?: string;
  privyCaId?: string;
  privyToken?: string;
  privySession?: string;
  cfClearance?: string;
  cfBm?: string;
  cfUvid?: string;
}

export interface FomoCallResult<T = any> {
  status: number;
  text: string;
  json: T | null;
  errorName?: string;
  errorMessage?: string;
  errorStack?: string;
}

export interface WorkerStatus {
  ok: boolean;
  browserReady: boolean;
  jwtReady: boolean;
  profileDir: string;
  lastCallAt: string | null;
  lastCallPath: string | null;
  lastError: string | null;
  refreshTokenSource: 'supabase' | 'env' | 'none';
  uptimeSec: number;
  /** Age of the current browser tab; stays bounded while recycling works. */
  pageAgeSec: number | null;
  callsSincePageOpen: number;
  rssMb: number;
  /** 403 circuit breaker: open means calls are being refused locally, not sent. */
  breaker?: { open: boolean; deniedStreak: number; retryInMs: number; backoffMs: number };
}
