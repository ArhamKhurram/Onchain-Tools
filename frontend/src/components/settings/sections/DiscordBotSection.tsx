import { Bot } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { FieldRow, Help, SectionHeader, SectionStack, SettingsCard, Toggle } from '../fields';
import type { SettingsForm } from '../useSettingsForm';

// OCT bot DM alerts. Personal DMs only — the bot messages the Discord
// account linked to this OCT account, so there are no channels to configure.
export default function DiscordBotSection({ form }: { form: SettingsForm }) {
  const { discordBotDm, setDiscordBotDm } = form;

  const setTrigger = (key: keyof typeof discordBotDm.triggers, value: boolean) =>
    setDiscordBotDm({ ...discordBotDm, triggers: { ...discordBotDm.triggers, [key]: value } });

  return (
    <>
      <SectionHeader title="Discord Bot" />

      <SectionStack>
        <SettingsCard
          icon={<Bot size={16} />}
          title="Alert DMs"
          blurb="The OCT bot sends alerts straight to your Discord DMs. It messages the Discord account you signed into OCT with — nothing is posted to any server."
        >
          <Toggle
            value={discordBotDm.enabled}
            onChange={(v) => setDiscordBotDm({ ...discordBotDm, enabled: v })}
            label="Send me alerts on Discord"
          />

          <FieldRow className="mt-comfy space-y-tight">
            <Help>
              <strong className="text-oct-text">Requirements:</strong> sign in to OCT with
              Discord (or link Discord to your account), and share a server with the bot — Discord
              only allows DMs from bots you have a server in common with.
            </Help>
            <Help>Run <code className="type-data text-oct-warn">/ping</code> in Discord to check the bot is online.</Help>
          </FieldRow>
        </SettingsCard>

        <SettingsCard
          title="What to DM me"
          className={cn(!discordBotDm.enabled && 'opacity-50 pointer-events-none')}
        >
          <div className="space-y-cozy">
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

          <div className="mt-comfy pt-comfy border-t border-oct-border">
            <Toggle
              value={discordBotDm.triggers.pumpCallout}
              onChange={(v) => setTrigger('pumpCallout', v)}
              label="pump.fun callouts from callers you follow"
            />
            <Help className="mt-tight pl-11">
              A DM the moment a caller you follow posts a callout — their thesis, the coin, and
              the market cap at the call. Only fires for callers you followed on{' '}
              <span className="text-oct-text font-semibold">Pump.fun → Following</span>, where you
              can also mute any single caller.
            </Help>
          </div>

          <div className="mt-comfy pt-comfy border-t border-oct-border">
            <Toggle
              value={discordBotDm.triggers.releaseNotes}
              onChange={(v) => setTrigger('releaseNotes', v)}
              label="Release notes"
            />
            <Help className="mt-tight pl-11">
              Get a DM when OCT ships an update. This one isn't a market signal, so it's
              separate from the alerts above — leaving it off doesn't affect them.
            </Help>
          </div>

          <div className="mt-comfy pt-comfy border-t border-oct-border">
            <Toggle
              value={discordBotDm.triggers.dailyDigest}
              onChange={(v) => setTrigger('dailyDigest', v)}
              label="Daily digest"
            />
            <Help className="mt-tight pl-11">
              One DM a day summarizing your last 24h: revival alerts and their peak
              multiples, the day's top pump.fun callouts, and the caller-board movers.
              Not a live signal, so it's a separate opt-in like release notes.
            </Help>
          </div>

          <Help className="mt-comfy">
            Signal-convergence alerts aren't available over DM yet — they're raised in the browser
            rather than on the server. Use Pushover for those.
          </Help>
        </SettingsCard>
      </SectionStack>
    </>
  );
}
