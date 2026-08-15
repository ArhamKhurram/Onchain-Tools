import { Bot } from 'lucide-react';
import { Toggle } from '../fields';
import type { SettingsForm } from '../useSettingsForm';

// OCT bot DM alerts. Personal DMs only — the bot messages the Discord
// account linked to this OCT account, so there are no channels to configure.
export default function DiscordBotSection({ form }: { form: SettingsForm }) {
  const { discordBotDm, setDiscordBotDm } = form;

  const setTrigger = (key: keyof typeof discordBotDm.triggers, value: boolean) =>
    setDiscordBotDm({ ...discordBotDm, triggers: { ...discordBotDm.triggers, [key]: value } });

  return (
    <div>
      <h3 className="font-display text-2xl sm:text-3xl tracking-tight text-oct-text mb-4">Discord Bot</h3>

      <div className="space-y-5">
        <div className="oct-card p-3 sm:p-4">
          <div className="flex items-start gap-2 mb-2">
            <Bot size={16} className="text-oct-accent mt-0.5 shrink-0" />
            <div>
              <h4 className="oct-eyebrow">Alert DMs</h4>
              <p className="text-sm text-oct-muted mt-1">
                The OCT bot sends alerts straight to your Discord DMs. It messages the Discord
                account you signed into OCT with — nothing is posted to any server.
              </p>
            </div>
          </div>

          <Toggle
            value={discordBotDm.enabled}
            onChange={(v) => setDiscordBotDm({ ...discordBotDm, enabled: v })}
            label="Send me alerts on Discord"
          />

          <div className="mt-3 text-xs text-oct-muted rounded-oct border border-oct-border bg-oct-surface-raised px-3 py-2 space-y-1">
            <p>
              <strong className="text-oct-text">Requirements:</strong> sign in to OCT with
              Discord (or link Discord to your account), and share a server with the bot — Discord
              only allows DMs from bots you have a server in common with.
            </p>
            <p>Run <code className="text-oct-yellow font-mono">/ping</code> in Discord to check the bot is online.</p>
          </div>
        </div>

        <div className={`oct-card p-3 sm:p-4 ${discordBotDm.enabled ? '' : 'opacity-50 pointer-events-none'}`}>
          <h4 className="oct-eyebrow mb-2">What to DM me</h4>
          <div className="space-y-2">
            <Toggle
              value={discordBotDm.triggers.highlightedUserContract}
              onChange={(v) => setTrigger('highlightedUserContract', v)}
              label="Highlighted user posts a contract"
            />
            <Toggle
              value={discordBotDm.triggers.highlightedUser}
              onChange={(v) => setTrigger('highlightedUser', v)}
              label="Any message from a highlighted user"
            />
            <Toggle
              value={discordBotDm.triggers.contract}
              onChange={(v) => setTrigger('contract', v)}
              label="Any contract detected"
            />
            <Toggle
              value={discordBotDm.triggers.keyword}
              onChange={(v) => setTrigger('keyword', v)}
              label="Keyword match"
            />
            <Toggle
              value={discordBotDm.triggers.missedRunner}
              onChange={(v) => setTrigger('missedRunner', v)}
              label="Missed runner"
            />
          </div>

          <div className="mt-4 pt-4 border-t border-oct-border">
            <Toggle
              value={discordBotDm.triggers.pumpCallout}
              onChange={(v) => setTrigger('pumpCallout', v)}
              label="pump.fun callouts from callers you follow"
            />
            <p className="text-xs text-oct-muted mt-1.5">
              A DM the moment a caller you follow posts a callout — their thesis, the coin, and
              the market cap at the call. Only fires for callers you followed on{' '}
              <span className="text-oct-text font-semibold">Pump.fun → Following</span>, where you
              can also mute any single caller.
            </p>
          </div>

          <div className="mt-4 pt-4 border-t border-oct-border">
            <Toggle
              value={discordBotDm.triggers.releaseNotes}
              onChange={(v) => setTrigger('releaseNotes', v)}
              label="Release notes"
            />
            <p className="text-xs text-oct-muted mt-1.5">
              Get a DM when OCT ships an update. This one isn't a market signal, so it's
              separate from the alerts above — leaving it off doesn't affect them.
            </p>
          </div>

          <div className="mt-4 pt-4 border-t border-oct-border">
            <Toggle
              value={discordBotDm.triggers.dailyDigest}
              onChange={(v) => setTrigger('dailyDigest', v)}
              label="Daily digest"
            />
            <p className="text-xs text-oct-muted mt-1.5">
              One DM a day summarizing your last 24h: revival alerts and their peak
              multiples, the day's top pump.fun callouts, and the caller-board movers.
              Not a live signal, so it's a separate opt-in like release notes.
            </p>
          </div>

          <p className="text-xs text-oct-muted mt-3">
            Signal-convergence alerts aren't available over DM yet — they're raised in the browser
            rather than on the server. Use Pushover for those.
          </p>
        </div>
      </div>
    </div>
  );
}
