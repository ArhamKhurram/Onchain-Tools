import { describe, it, expect } from 'vitest';
import {
  ConflictReporter,
  decidePolling,
  deploymentMarkers,
  instanceLabel,
  POLLING_OVERRIDE_VAR,
  refusalBanner,
} from '../src/tgbot/polling';

/**
 * These pin the trap that took production's bot down: `backend/.env` is the
 * HOSTED environment file and carries the real TELEGRAM_BOT_TOKEN, so a plain
 * `npm run dev -w backend` on a laptop started a SECOND getUpdates poller
 * against production's token and silently took about half of its updates.
 *
 * The rule therefore cannot be "poll in hosted mode" — that .env says hosted.
 * It has to be "poll only inside a real deployment, unless told otherwise".
 */
describe('Telegram bot polling gate', () => {
  it('refuses on a laptop holding the production env file', () => {
    // Exactly what `npm run dev -w backend` sees: hosted mode, real token, no
    // platform-injected variables.
    const decision = decidePolling({ OCT_MODE: 'hosted', TELEGRAM_BOT_TOKEN: 'x' });
    expect(decision.poll).toBe(false);
    expect(decision.reason).toBe('not_a_deployment');
  });

  it('polls on Railway with no extra configuration', () => {
    const decision = decidePolling({ OCT_MODE: 'hosted', RAILWAY_ENVIRONMENT: 'production' });
    expect(decision.poll).toBe(true);
    expect(decision.reason).toBe('deployment');
  });

  it.each(['RAILWAY_SERVICE_ID', 'RAILWAY_PROJECT_ID', 'RENDER', 'FLY_APP_NAME', 'DYNO', 'KUBERNETES_SERVICE_HOST'])(
    'treats %s as a deployment marker',
    (marker) => {
      expect(decidePolling({ [marker]: 'set' }).poll).toBe(true);
    },
  );

  it('lets an operator opt in off-platform', () => {
    for (const value of ['1', 'true', 'YES', 'on']) {
      const decision = decidePolling({ [POLLING_OVERRIDE_VAR]: value });
      expect(decision.poll).toBe(true);
      expect(decision.reason).toBe('override_on');
    }
  });

  it('lets an operator opt a deployment OUT, which is how a duplicate deploy is silenced', () => {
    const decision = decidePolling({ RAILWAY_ENVIRONMENT: 'production', [POLLING_OVERRIDE_VAR]: '0' });
    expect(decision.poll).toBe(false);
    expect(decision.reason).toBe('override_off');
  });

  it('does not read an unrecognised override as permission to poll', () => {
    expect(decidePolling({ [POLLING_OVERRIDE_VAR]: 'maybe' }).poll).toBe(false);
    // …but it still defers to a real deployment.
    expect(decidePolling({ [POLLING_OVERRIDE_VAR]: 'maybe', RAILWAY_ENVIRONMENT: 'p' }).poll).toBe(true);
  });

  it('ignores blank marker values so an empty .env line is not a deployment', () => {
    expect(deploymentMarkers({ RAILWAY_ENVIRONMENT: '   ' })).toEqual([]);
    expect(decidePolling({ RAILWAY_ENVIRONMENT: '' }).poll).toBe(false);
  });

  it('names the instance without leaking anything secret', () => {
    const label = instanceLabel({ OCT_MODE: 'hosted', RAILWAY_ENVIRONMENT_NAME: 'production' }, 'box-1');
    expect(label).toContain('mode=hosted');
    expect(label).toContain('host=box-1');
    expect(label).toContain('production');
  });

  it('tells the reader what to do instead of just refusing', () => {
    const decision = decidePolling({});
    const text = refusalBanner(decision, 'mode=hosted host=laptop where=local checkout').join('\n');
    expect(text).toContain('TELEGRAM_BOT_TOKEN');
    expect(text).toContain(POLLING_OVERRIDE_VAR);
    expect(text).toContain('mode=hosted host=laptop');
  });
});

describe('ConflictReporter', () => {
  function reporter() {
    let now = 0;
    const r = new ConflictReporter(5 * 60_000, () => now);
    return { r, advance: (ms: number) => (now += ms) };
  }

  it('reports the first conflict as a banner, then goes quiet', () => {
    const { r } = reporter();
    expect(r.record('inst')).not.toBeNull();
    for (let i = 0; i < 50; i++) expect(r.record('inst')).toBeNull();
    expect(r.conflicts).toBe(51);
  });

  it('re-reports with a running count once the quiet window passes', () => {
    const { r, advance } = reporter();
    r.record('inst');
    r.record('inst');
    advance(5 * 60_000);
    const lines = r.record('inst');
    expect(lines).not.toBeNull();
    expect(lines!.join(' ')).toContain('3 rejected polls');
    expect(lines!.join(' ')).toContain('inst');
  });

  it('resets after a successful poll so a later conflict is loud again', () => {
    const { r } = reporter();
    r.record('inst');
    expect(r.active).toBe(true);
    r.clear();
    expect(r.active).toBe(false);
    expect(r.record('inst')).not.toBeNull();
  });
});
