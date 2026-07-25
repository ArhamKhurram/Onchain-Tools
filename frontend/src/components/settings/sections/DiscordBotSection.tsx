import { Bot } from 'lucide-react';
import { Toggle } from '../fields';
import type { SettingsForm } from '../useSettingsForm';

// Outpost bot DM alerts. Personal DMs only — the bot messages the Discord
// account linked to this OCT account, so there are no channels to configure.
export default function DiscordBotSection({ form }: { form: SettingsForm }) {
  const { discordBotDm, setDiscordBotDm } = form;

  const setTrigger = (key: keyof typeof discordBotDm.triggers, value: boolean) =>
    setDiscordBotDm({ ...discordBotDm, triggers: { ...discordBotDm.triggers, [key]: value } });

  return (
    <div>
      <h3 className="text-base sm:text-lg font-semibold text-white mb-4">Discord Bot</h3>

      <div className="space-y-5">
        <div className="p-3 sm:p-4 bg-discord-sidebar rounded-lg">
          <div className="flex items-start gap-2 mb-2">
            <Bot size={16} className="text-discord-blurple mt-0.5 shrink-0" />
            <div>
              <h4 className="text-xs sm:text-sm font-semibold text-white">Alert DMs</h4>
              <p className="text-sm text-discord-text-muted mt-1">
                The Outpost bot sends alerts straight to your Discord DMs. It messages the Discord
                account you signed into OCT with — nothing is posted to any server.
              </p>
            </div>
          </div>

          <Toggle
            value={discordBotDm.enabled}
            onChange={(v) => setDiscordBotDm({ ...discordBotDm, enabled: v })}
            label="Send me alerts on Discord"
          />

          <div className="mt-3 text-xs text-discord-text-muted bg-discord-dark rounded px-3 py-2 space-y-1">
            <p>
              <strong className="text-discord-text">Requirements:</strong> sign in to OCT with
              Discord (or link Discord to your account), and share a server with the bot — Discord
              only allows DMs from bots you have a server in common with.
            </p>
            <p>Run <code className="text-orange-400/80 font-mono">/ping</code> in Discord to check the bot is online.</p>
          </div>
        </div>

        <div className={`p-3 sm:p-4 bg-discord-sidebar rounded-lg ${discordBotDm.enabled ? '' : 'opacity-50 pointer-events-none'}`}>
          <h4 className="text-xs sm:text-sm font-semibold text-white mb-2">What to DM me</h4>
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
          <p className="text-xs text-discord-text-muted mt-3">
            Signal-convergence alerts aren't available over DM yet — they're raised in the browser
            rather than on the server. Use Pushover for those.
          </p>
        </div>
      </div>
    </div>
  );
}
