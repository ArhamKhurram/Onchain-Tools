// WHO IS ALLOWED TO LONG-POLL THE BOT TOKEN.
//
// THE FAILURE THIS PREVENTS. Telegram hands each update to exactly ONE
// getUpdates caller. Two processes polling the same token do not both receive
// the traffic — they SPLIT it, roughly in half, silently. The symptom is a bot
// that ignores about every other command and button press, which reads as a bug
// in the handler rather than as a second process existing.
//
// WHY A GATE AND NOT JUST A BETTER LOG. The second poller was structurally easy
// to start: `backend/.env` is the HOSTED environment file and carries the real
// TELEGRAM_BOT_TOKEN, so `npm run dev -w backend` (and therefore the root
// `npm run dev`) booted a laptop straight into polling production's bot. No
// flag, no prompt, no warning — the laptop just started stealing production's
// updates for as long as it stayed up. Gating on hosted-vs-local mode does not
// help here, because that .env says `OCT_MODE=hosted` too. The only honest
// discriminator between "the deployed instance" and "a laptop holding the
// deployed instance's secrets" is whether we are running INSIDE a deployment.
//
// THE RULE, in order:
//   1. no token                     → the bot is off entirely (handled upstream)
//   2. OCT_TGBOT_POLLING set        → that answer wins, both directions
//   3. a platform marker is present → poll (this is the real deployment)
//   4. otherwise                    → refuse, loudly and with instructions
//
// Rule 3 is what keeps Railway working with no operational step: Railway always
// injects RAILWAY_* into the container and nothing puts them in a `.env`. Rule 2
// is the escape hatch for deliberately running the bot off-platform (a staging
// box, or a developer testing bot changes against a SEPARATE @BotFather token).

/** A minimal view of the environment, so every decision here is unit-testable. */
export type Env = Record<string, string | undefined>;

/**
 * Env vars whose presence means "this process is a deployment, not a checkout".
 *
 * All of them are injected by the platform at run time and none of them can be
 * picked up from a committed or local `.env`, which is the whole point.
 */
const DEPLOYMENT_MARKERS = [
  'RAILWAY_ENVIRONMENT',
  'RAILWAY_ENVIRONMENT_NAME',
  'RAILWAY_SERVICE_ID',
  'RAILWAY_PROJECT_ID',
  'RENDER',
  'FLY_APP_NAME',
  'DYNO',
  'KUBERNETES_SERVICE_HOST',
] as const;

/** The one variable an operator sets to override the automatic decision. */
export const POLLING_OVERRIDE_VAR = 'OCT_TGBOT_POLLING';

export interface PollingDecision {
  poll: boolean;
  /** Machine-readable so tests and callers branch on it rather than on prose. */
  reason: 'override_on' | 'override_off' | 'deployment' | 'not_a_deployment';
  /** One line, safe to log — never contains the token. */
  detail: string;
}

function truthy(value: string): boolean {
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(value.trim().toLowerCase());
}

function falsy(value: string): boolean {
  return ['0', 'false', 'no', 'off', 'disabled'].includes(value.trim().toLowerCase());
}

/** The deployment markers actually present, for the log line. */
export function deploymentMarkers(env: Env): string[] {
  return DEPLOYMENT_MARKERS.filter((key) => !!env[key]?.trim());
}

/**
 * May this process long-poll the bot token?
 *
 * Pure: takes the environment rather than reading `process.env`, so the trap
 * this exists to close can be pinned by a test instead of by a code review.
 */
export function decidePolling(env: Env): PollingDecision {
  const override = env[POLLING_OVERRIDE_VAR]?.trim();
  if (override) {
    if (truthy(override)) {
      return { poll: true, reason: 'override_on', detail: `${POLLING_OVERRIDE_VAR} is set` };
    }
    if (falsy(override)) {
      return { poll: false, reason: 'override_off', detail: `${POLLING_OVERRIDE_VAR}=${override}` };
    }
    // An unrecognised value is not a licence to poll. Fall through to the
    // automatic rule rather than guessing what "maybe" meant.
  }

  const markers = deploymentMarkers(env);
  if (markers.length > 0) {
    return { poll: true, reason: 'deployment', detail: `running on a deployment (${markers[0]} present)` };
  }

  return {
    poll: false,
    reason: 'not_a_deployment',
    detail: 'no deployment marker in the environment (this looks like a local checkout)',
  };
}

/**
 * A short, secret-free description of THIS process, for the conflict banner.
 *
 * The whole difficulty of a 409 is not knowing which instance to go and stop,
 * so the line that reports one has to say who is reporting it.
 */
export function instanceLabel(env: Env, hostname: string): string {
  const mode = (env.OCT_MODE ?? env.TRENCHCORD_MODE ?? 'local').trim() || 'local';
  const markers = deploymentMarkers(env);
  const platform = markers.length > 0 ? (env.RAILWAY_ENVIRONMENT_NAME ?? env.RAILWAY_ENVIRONMENT ?? markers[0]) : 'local checkout';
  return `mode=${mode} host=${hostname} where=${platform}`;
}

/** The refusal banner, as lines. Split out so the wording is testable. */
export function refusalBanner(decision: PollingDecision, label: string): string[] {
  return [
    '',
    '─'.repeat(72),
    '  [TgBot] NOT polling: a second poller would split production\'s updates.',
    '─'.repeat(72),
    `  TELEGRAM_BOT_TOKEN is set, but ${decision.detail}.`,
    '',
    '  Telegram delivers each update to only ONE getUpdates caller. If the',
    '  deployed bot is also polling this token, starting here would silently',
    '  take about half of its commands and button presses.',
    '',
    `  This process: ${label}`,
    '',
    '  If you meant to run the bot here, either unset TELEGRAM_BOT_TOKEN (the',
    '  rest of the backend runs fine without it), or — with a SEPARATE',
    `  @BotFather token, not production's — set ${POLLING_OVERRIDE_VAR}=1.`,
    '─'.repeat(72),
    '',
  ];
}

/**
 * Rate-limited reporting of getUpdates 409s.
 *
 * A 409 repeats on every poll for as long as the other process lives, so the
 * naive `console.error` per occurrence buries itself: one line, indistinguishable
 * from transient noise, in a log that is already busy. This reports the FIRST
 * one as a banner and then re-reports at a fixed interval with a running count,
 * which is what makes "this has happened 412 times over 34 minutes" visible.
 *
 * It deliberately does NOT stop the poll loop. Both pollers see 409s, so a
 * self-shutdown rule would let a laptop knock production offline; the correct
 * action is always human, and this exists to make it obvious which action.
 */
export class ConflictReporter {
  private count = 0;
  private firstAt = 0;
  private lastReportAt = 0;

  constructor(
    private readonly intervalMs: number = 5 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** True while at least one 409 has been seen and none has been cleared. */
  get active(): boolean {
    return this.count > 0;
  }

  get conflicts(): number {
    return this.count;
  }

  /** A successful poll means the conflict is over; the next one reports afresh. */
  clear(): void {
    this.count = 0;
    this.firstAt = 0;
    this.lastReportAt = 0;
  }

  /**
   * Record one 409. Returns the lines to log, or `null` when this one falls
   * inside the quiet window.
   */
  record(label: string): string[] | null {
    const t = this.now();
    this.count++;
    if (this.count === 1) {
      this.firstAt = t;
      this.lastReportAt = t;
      return [
        '',
        '─'.repeat(72),
        '  [TgBot] CONFLICT (409): another process is polling this bot token.',
        '─'.repeat(72),
        '  Telegram splits updates between pollers, so BOTH instances are now',
        '  missing roughly half of every command and button press.',
        '',
        `  This process: ${label}`,
        '',
        '  Usual causes, in order of likelihood:',
        '    1. a backend running on a laptop from the production .env',
        '    2. two deploys of the same service still overlapping',
        '    3. a webhook left set on this token (deleted automatically at boot)',
        '',
        `  Stop the other poller, or give it its own token. Set ${POLLING_OVERRIDE_VAR}=0`,
        '  on whichever instance should not be polling.',
        '─'.repeat(72),
        '',
      ];
    }
    if (t - this.lastReportAt < this.intervalMs) return null;
    this.lastReportAt = t;
    const minutes = Math.max(1, Math.round((t - this.firstAt) / 60_000));
    return [
      `[TgBot] Still conflicting (409): ${this.count} rejected polls over ~${minutes} min. ` +
        `Updates are still being split. This process: ${label}`,
    ];
  }
}
