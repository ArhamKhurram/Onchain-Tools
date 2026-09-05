import type { ReactNode } from 'react';
import { Plus, Minus } from 'lucide-react';
import type { PushoverPriority, PushoverSound } from '../../../types';
import { PUSHOVER_SOUNDS, MISSED_RUNNER_NOTIFY_OPTIONS } from '../../../types';
import { cn } from '../../../lib/utils';
import {
  Chip,
  ChipRow,
  ClearButton,
  ExtLink,
  Field,
  FieldLabel,
  FieldRow,
  Help,
  INPUT_CLASS,
  INPUT_MONO_CLASS,
  Kicker,
  SectionHeader,
  SettingsCard,
  StatusBox,
  StatusText,
  Toggle,
} from '../fields';
import type { SettingsForm } from '../useSettingsForm';

/** Numbered step in the setup guide. */
function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <div className="flex items-start gap-cozy">
      <span className="shrink-0 w-5 h-5 rounded-oct-sm bg-oct-accent text-white type-data text-2xs font-bold flex items-center justify-center mt-hair">
        {n}
      </span>
      <div className="type-body text-oct-text">{children}</div>
    </div>
  );
}

/** Credential inputs: password-masked, mono, with autofill managers waved off. */
const SECRET_INPUT_PROPS = {
  type: 'password',
  className: INPUT_MONO_CLASS,
  autoComplete: 'off',
  'data-1p-ignore': true,
  'data-lpignore': 'true',
  'data-form-type': 'other',
} as const;

export default function PushoverSection({ form }: { form: SettingsForm }) {
  const { config, guilds, userNameMap, enabledGuilds, pushoverEnabled, setPushoverEnabled, pushoverAppToken, setPushoverAppToken, pushoverUserKey, setPushoverUserKey, pushoverPriority, setPushoverPriority, pushoverSound, setPushoverSound, pushoverTriggers, setPushoverTriggers, pushoverFilters, setPushoverFilters, missedRunnerEnabled, setMissedRunnerEnabled, missedRunnerMultiplier, setMissedRunnerMultiplier, missedRunnerLookbackHours, setMissedRunnerLookbackHours, missedRunnerCooldownHours, setMissedRunnerCooldownHours, missedRunnerMinMcAtCall, setMissedRunnerMinMcAtCall, missedRunnerNotifyVia, setMissedRunnerNotifyVia, missedRunnerTestAddress, setMissedRunnerTestAddress, missedRunnerTestForce, setMissedRunnerTestForce, missedRunnerTestLoading, missedRunnerTestResult, setMissedRunnerTestResult, handleMissedRunnerTest } = form;

  const testTone = missedRunnerTestResult?.sent ? 'good' : missedRunnerTestResult?.ok ? 'warn' : 'critical';

  return (
    <>
      <SectionHeader
        title="Pushover"
        blurb={
          <>
            Send push notifications to your phone via <ExtLink href="https://pushover.net">pushover.net</ExtLink>.
            Configure which events trigger notifications and filter by user, guild, or channel.
          </>
        }
      />

      <div className="space-y-comfy">
        <details className="group oct-card">
          <summary className="flex items-center gap-cozy px-comfy sm:px-roomy py-cozy cursor-pointer select-none type-title text-oct-text hover:text-oct-accent transition-colors duration-100">
            <Plus size={14} className="shrink-0 group-open:hidden" />
            <Minus size={14} className="shrink-0 hidden group-open:block" />
            <span>Setup Guide</span>
          </summary>
          <div className="px-comfy sm:px-roomy pt-comfy pb-comfy space-y-comfy border-t border-oct-border">
            <div className="space-y-cozy">
              <Step n={1}>
                Create a Pushover account at <ExtLink href="https://pushover.net">pushover.net</ExtLink> and install the
                app on your <ExtLink href="https://pushover.net/clients">phone</ExtLink>.
              </Step>
              <Step n={2}>
                Copy your <span className="font-semibold">User Key</span> from the{' '}
                <ExtLink href="https://pushover.net">Pushover dashboard</ExtLink> (shown at the top of the page after logging in).
              </Step>
              <Step n={3}>
                <p>
                  Create a new application at <ExtLink href="https://pushover.net/apps/build">pushover.net/apps/build</ExtLink>:
                </p>
                <ul className="mt-tight ml-tight space-y-hair type-caption text-oct-muted">
                  <li className="flex items-start gap-snug"><span className="text-oct-accent font-bold">·</span> Name it anything (e.g. "OCT")</li>
                  <li className="flex items-start gap-snug"><span className="text-oct-accent font-bold">·</span> Type: Application</li>
                  <li className="flex items-start gap-snug"><span className="text-oct-accent font-bold">·</span> Description and URL are optional</li>
                </ul>
              </Step>
              <Step n={4}>
                Copy the <span className="font-semibold">API Token/Key</span> from your newly created application page and paste it below.
              </Step>
            </div>
            <Help>Pushover offers a 30-day free trial, then a one-time $5 purchase per platform.</Help>
          </div>
        </details>

        <Toggle
          value={pushoverEnabled}
          onChange={setPushoverEnabled}
          label="Enable Pushover notifications"
        />

        {pushoverEnabled && (
          <div className="space-y-comfy">
            <SettingsCard title="Credentials">
              <div className="space-y-cozy">
                <Field label="Application API Token">
                  <input
                    {...SECRET_INPUT_PROPS}
                    value={pushoverAppToken}
                    onChange={(e) => setPushoverAppToken(e.target.value)}
                    placeholder="azGDORePK8gMaC0QOYAMyEEuzJnyUi"
                  />
                </Field>
                <Field label="User Key">
                  <input
                    {...SECRET_INPUT_PROPS}
                    value={pushoverUserKey}
                    onChange={(e) => setPushoverUserKey(e.target.value)}
                    placeholder="uQiRzpo4DXghDmr9QzzfQu27cmVRsG"
                  />
                </Field>
              </div>
            </SettingsCard>

            <SettingsCard title="Triggers" blurb="Choose which events send a push notification.">
              <div className="space-y-cozy">
                <Toggle
                  value={pushoverTriggers.highlightedUserContract}
                  onChange={(v) => setPushoverTriggers((p) => ({ ...p, highlightedUserContract: v }))}
                  label="Highlighted user posts a contract"
                />
                <Toggle
                  value={pushoverTriggers.highlightedUser}
                  onChange={(v) => setPushoverTriggers((p) => ({ ...p, highlightedUser: v }))}
                  label="Highlighted user sends any message"
                />
                <Toggle
                  value={pushoverTriggers.contract}
                  onChange={(v) => setPushoverTriggers((p) => ({ ...p, contract: v }))}
                  label="Any contract address detected"
                />
                <Toggle
                  value={pushoverTriggers.keyword}
                  onChange={(v) => setPushoverTriggers((p) => ({ ...p, keyword: v }))}
                  label="Keyword pattern matched"
                />
                <Toggle
                  value={pushoverTriggers.signalConvergence ?? false}
                  onChange={(v) => setPushoverTriggers((p) => ({ ...p, signalConvergence: v }))}
                  label="Signal convergence (contract call + FOMO buy overlap)"
                />
              </div>
            </SettingsCard>

            <SettingsCard title="Filters" blurb="Narrow down which messages trigger notifications. Empty = no filter (all match).">
              <div className="space-y-cozy">
                {/* User filter */}
                <Field label="Only from these highlighted users">
                  {(() => {
                    const allHighlighted = Array.from(new Set([
                      ...(config?.globalHighlightedUsers ?? []),
                      ...(config?.rooms ?? []).flatMap((r) => r.highlightedUsers),
                    ]));
                    if (allHighlighted.length === 0) return <Help className="italic">No highlighted users configured</Help>;
                    return (
                      <ChipRow>
                        {allHighlighted.map((uid) => {
                          const active = pushoverFilters.userIds.includes(uid);
                          return (
                            <Chip
                              key={uid}
                              size="sm"
                              active={active}
                              onClick={() => setPushoverFilters((f) => ({
                                ...f,
                                userIds: active ? f.userIds.filter((id) => id !== uid) : [...f.userIds, uid],
                              }))}
                            >
                              {userNameMap.get(uid) || uid}
                            </Chip>
                          );
                        })}
                        {pushoverFilters.userIds.length > 0 && (
                          <ClearButton onClick={() => setPushoverFilters((f) => ({ ...f, userIds: [] }))} />
                        )}
                      </ChipRow>
                    );
                  })()}
                </Field>

                {/* Guild filter */}
                <Field label="Only from these guilds">
                  {(() => {
                    const filtered = guilds.filter((g) => enabledGuilds.includes(g.id));
                    if (filtered.length === 0) return <Help className="italic">No enabled guilds</Help>;
                    return (
                      <ChipRow>
                        {filtered.map((g) => {
                          const active = pushoverFilters.guildIds.includes(g.id);
                          return (
                            <Chip
                              key={g.id}
                              size="sm"
                              active={active}
                              onClick={() => setPushoverFilters((f) => ({
                                ...f,
                                guildIds: active ? f.guildIds.filter((id) => id !== g.id) : [...f.guildIds, g.id],
                              }))}
                            >
                              {g.name}
                            </Chip>
                          );
                        })}
                        {pushoverFilters.guildIds.length > 0 && (
                          <ClearButton onClick={() => setPushoverFilters((f) => ({ ...f, guildIds: [] }))} />
                        )}
                      </ChipRow>
                    );
                  })()}
                </Field>

                {/* Channel filter */}
                <Field label="Only from these channels">
                  {(() => {
                    const rooms = config?.rooms ?? [];
                    const seen = new Set<string>();
                    const channels: { id: string; name: string; guildName: string | null }[] = [];
                    for (const room of rooms) {
                      for (const ch of room.channels) {
                        if (!seen.has(ch.channelId)) {
                          seen.add(ch.channelId);
                          channels.push({ id: ch.channelId, name: ch.channelName ?? ch.channelId, guildName: ch.guildName ?? null });
                        }
                      }
                    }
                    if (channels.length === 0) return <Help className="italic">No channels in rooms</Help>;
                    const grouped = new Map<string, typeof channels>();
                    for (const ch of channels) {
                      const key = ch.guildName ?? 'DMs';
                      if (!grouped.has(key)) grouped.set(key, []);
                      grouped.get(key)!.push(ch);
                    }
                    return (
                      <div className="space-y-cozy">
                        {Array.from(grouped.entries()).map(([guildName, guildChannels]) => (
                          <div key={guildName}>
                            <Kicker className="mb-tight">{guildName}</Kicker>
                            <ChipRow>
                              {guildChannels.map((ch) => {
                                const active = pushoverFilters.channelIds.includes(ch.id);
                                return (
                                  <Chip
                                    key={ch.id}
                                    size="sm"
                                    active={active}
                                    onClick={() => setPushoverFilters((f) => ({
                                      ...f,
                                      channelIds: active ? f.channelIds.filter((id) => id !== ch.id) : [...f.channelIds, ch.id],
                                    }))}
                                  >
                                    #{ch.name}
                                  </Chip>
                                );
                              })}
                            </ChipRow>
                          </div>
                        ))}
                        {pushoverFilters.channelIds.length > 0 && (
                          <ClearButton onClick={() => setPushoverFilters((f) => ({ ...f, channelIds: [] }))} />
                        )}
                      </div>
                    );
                  })()}
                </Field>
              </div>
            </SettingsCard>

            <SettingsCard title="Notification Settings">
              <div className="space-y-cozy">
                <Field label="Priority">
                  <select
                    value={pushoverPriority}
                    onChange={(e) => setPushoverPriority(Number(e.target.value) as PushoverPriority)}
                    className={INPUT_CLASS}
                  >
                    <option value={-2}>Lowest (no alert)</option>
                    <option value={-1}>Low (no sound)</option>
                    <option value={0}>Normal</option>
                    <option value={1}>High (bypass quiet hours)</option>
                    <option value={2}>Emergency (repeats until acknowledged)</option>
                  </select>
                </Field>
                <Field label="Sound">
                  <select
                    value={pushoverSound}
                    onChange={(e) => setPushoverSound(e.target.value as PushoverSound)}
                    className={cn(INPUT_CLASS, 'capitalize')}
                  >
                    {PUSHOVER_SOUNDS.map((s) => (
                      <option key={s} value={s}>{s === 'none' ? 'None (silent)' : s}</option>
                    ))}
                  </select>
                </Field>
              </div>
            </SettingsCard>
          </div>
        )}

        <SettingsCard
          title="Missed runner alerts"
          blurb="Notify when a scanned token hits your multiplier vs MC@call and none of your My Wallets hold it."
          className="border-oct-accent"
        >
          <Toggle
            value={missedRunnerEnabled}
            onChange={setMissedRunnerEnabled}
            label="Enable missed-runner monitoring"
          />
          {missedRunnerEnabled && (
            <div className="space-y-cozy mt-comfy">
              <div>
                <FieldLabel>Deliver via</FieldLabel>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-cozy">
                  {MISSED_RUNNER_NOTIFY_OPTIONS.map(({ value, label, hint }) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setMissedRunnerNotifyVia(value)}
                      className={cn(
                        'px-cozy py-cozy rounded-oct text-left border transition-colors duration-150',
                        missedRunnerNotifyVia === value
                          ? 'bg-oct-accent-dim border-oct-accent/60 text-oct-text shadow-oct-glow-accent'
                          : 'bg-oct-surface-raised/40 border-oct-border text-oct-muted hover:text-oct-text hover:border-oct-border-bright',
                      )}
                    >
                      <span className="block type-label font-mono uppercase tracking-wide">{label}</span>
                      <span className="block type-caption opacity-80 mt-hair">{hint}</span>
                    </button>
                  ))}
                </div>
                {(missedRunnerNotifyVia === 'pushover' || missedRunnerNotifyVia === 'both') && !pushoverEnabled && (
                  <StatusText tone="warn" className="mt-cozy">
                    Enable Pushover above and add credentials for phone pushes.
                  </StatusText>
                )}
                {(missedRunnerNotifyVia === 'toast' || missedRunnerNotifyVia === 'both') && (
                  <Help className="mt-cozy">
                    Toast position: Settings → Sounds &amp; Notifications → On-site toast alerts.
                  </Help>
                )}
              </div>
              <Field
                label={
                  <>
                    Multiplier threshold: <span className="type-data">{missedRunnerMultiplier.toFixed(2)}×</span> vs MC@call
                  </>
                }
              >
                <input
                  type="range"
                  min={1.25}
                  max={5}
                  step={0.05}
                  value={missedRunnerMultiplier}
                  onChange={(e) => setMissedRunnerMultiplier(Number(e.target.value))}
                  className="w-full accent-oct-accent"
                />
              </Field>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-cozy">
                <Field label="Lookback (hours)">
                  <input
                    type="number"
                    min={1}
                    max={168}
                    value={missedRunnerLookbackHours}
                    onChange={(e) => setMissedRunnerLookbackHours(Math.max(1, Number(e.target.value) || 24))}
                    className={INPUT_MONO_CLASS}
                  />
                </Field>
                <Field label="Cooldown per token (hours)">
                  <input
                    type="number"
                    min={1}
                    max={168}
                    value={missedRunnerCooldownHours}
                    onChange={(e) => setMissedRunnerCooldownHours(Math.max(1, Number(e.target.value) || 24))}
                    className={INPUT_MONO_CLASS}
                  />
                </Field>
              </div>
              <Field label="Min MC@call (optional, USD)">
                <input
                  type="number"
                  min={0}
                  placeholder="e.g. 50000 — skip lower MC scans"
                  value={missedRunnerMinMcAtCall}
                  onChange={(e) => setMissedRunnerMinMcAtCall(e.target.value)}
                  className={INPUT_MONO_CLASS}
                />
              </Field>
              <Help>Balance checks use Wallets → My Wallets. Keep the site open for toast delivery.</Help>

              <FieldRow className="space-y-cozy">
                <div>
                  <FieldLabel className="mb-hair">Test on a token</FieldLabel>
                  <Help>Paste a contract from your feed to preview the alert. Does not write cooldown rows.</Help>
                </div>
                <input
                  type="text"
                  value={missedRunnerTestAddress}
                  onChange={(e) => {
                    setMissedRunnerTestAddress(e.target.value);
                    setMissedRunnerTestResult(null);
                  }}
                  placeholder="0x647dd517c8820fc9874e1a3f58e6e0b9a43395c0"
                  className={INPUT_MONO_CLASS}
                />
                <Toggle
                  value={missedRunnerTestForce}
                  onChange={(v) => {
                    setMissedRunnerTestForce(v);
                    setMissedRunnerTestResult(null);
                  }}
                  label="Force send (ignore multiplier & cooldown)"
                />
                <button
                  type="button"
                  onClick={() => void handleMissedRunnerTest()}
                  disabled={missedRunnerTestLoading || !missedRunnerTestAddress.trim()}
                  className="oct-btn-primary px-comfy py-snug text-xs"
                >
                  {missedRunnerTestLoading ? 'Running…' : 'Run test alert'}
                </button>
                {missedRunnerTestResult && (
                  <StatusBox tone={testTone}>
                    <p>{missedRunnerTestResult.message}</p>
                    {missedRunnerTestResult.diagnostics && (
                      <p className="mt-tight opacity-90 type-data text-2xs">
                        {missedRunnerTestResult.diagnostics.mcAtCallDisplay != null && (
                          <>MC@call {missedRunnerTestResult.diagnostics.mcAtCallDisplay}</>
                        )}
                        {missedRunnerTestResult.diagnostics.mcNowDisplay != null && (
                          <> → {missedRunnerTestResult.diagnostics.mcNowDisplay}</>
                        )}
                        {missedRunnerTestResult.diagnostics.multiplier != null && (
                          <> · {missedRunnerTestResult.diagnostics.multiplier.toFixed(2)}×</>
                        )}
                        {missedRunnerTestResult.diagnostics.minMultiplier != null && (
                          <> (need {missedRunnerTestResult.diagnostics.minMultiplier.toFixed(2)}×)</>
                        )}
                      </p>
                    )}
                  </StatusBox>
                )}
              </FieldRow>
            </div>
          )}
        </SettingsCard>
      </div>
    </>
  );
}
