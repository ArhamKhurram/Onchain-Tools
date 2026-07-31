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

export interface FomoTokenMetadata {
  ticker?: string | null;
  name?: string | null;
  iconLink?: string | null;
  marketCap?: number | null;
  price?: number | null;
  description?: string | null;
  twitter?: string | null;
  telegram?: string | null;
  website?: string | null;
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
}
