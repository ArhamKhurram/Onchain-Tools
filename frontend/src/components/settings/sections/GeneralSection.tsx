import type { BadgeClickAction, MessageDisplay, FeedChromePreset, SplitLayout } from '../../../types';
import { Help, SectionHeader, SectionStack, SegmentedControl, SettingsCard, StatusBox, Toggle } from '../fields';
import type { SettingsForm } from '../useSettingsForm';

const MESSAGE_DISPLAY_OPTIONS: readonly { value: MessageDisplay; label: string }[] = [
  { value: 'default', label: 'Cozy' },
  { value: 'compact', label: 'Compact' },
];

const FEED_CHROME_OPTIONS: readonly { value: FeedChromePreset; label: string }[] = [
  { value: 'terminal', label: 'Terminal' },
  { value: 'masthead', label: 'Masthead' },
  { value: 'rail', label: 'Rail' },
];

const SPLIT_LAYOUT_OPTIONS: readonly { value: SplitLayout; label: string }[] = [
  { value: 'row', label: 'Single row' },
  { value: 'grid', label: 'Two rows' },
];

const BADGE_CLICK_OPTIONS: readonly { value: BadgeClickAction; label: string }[] = [
  { value: 'discord', label: 'Discord' },
  { value: 'platform', label: 'Platform' },
  { value: 'both', label: 'Both' },
];

export default function GeneralSection({ form }: { form: SettingsForm }) {
  const { contractDetection, setContractDetection, openInDiscordApp, setOpenInDiscordApp, openInTelegramApp, setOpenInTelegramApp, badgeClickAction, setBadgeClickAction, chattingEnabled, setChattingEnabled, messageDisplay, setMessageDisplay, feedChromePreset, setFeedChromePreset, compactModeAvatars, setCompactModeAvatars, roleColors, setRoleColors, mobileZoomScale, setMobileZoomScale, splitLayout, setSplitLayout } = form;
  return (
    <>
      <SectionHeader title="General" />

      <SectionStack>
        <SettingsCard title="Message Display" blurb="Choose how messages are displayed in chat.">
          <SegmentedControl value={messageDisplay} onChange={setMessageDisplay} options={MESSAGE_DISPLAY_OPTIONS} />
          <Help className="mt-cozy">
            {messageDisplay === 'default' && 'Cozy mode shows avatars and full message headers.'}
            {messageDisplay === 'compact' && 'Compact mode shows timestamps on the left with inline usernames for a denser chat view.'}
          </Help>
          {messageDisplay === 'compact' && (
            <div className="mt-comfy pt-comfy border-t border-oct-border">
              <Toggle
                value={compactModeAvatars}
                onChange={setCompactModeAvatars}
                label="Show avatars in compact mode"
              />
            </div>
          )}
        </SettingsCard>

        <SettingsCard title="Feed Layout" blurb="Choose the chrome around the feed — how rooms are picked and where status lives.">
          <SegmentedControl value={feedChromePreset} onChange={setFeedChromePreset} options={FEED_CHROME_OPTIONS} />
          <Help className="mt-cozy">
            {feedChromePreset === 'terminal' && 'One dense status line. Rooms via ⌘K. Maximum feed space. (Default)'}
            {feedChromePreset === 'masthead' && 'Vertical room rail with a large editorial room header.'}
            {feedChromePreset === 'rail' && 'Icon rail, inline room dividers, bottom status bar. Densest.'}
          </Help>
        </SettingsCard>

        <SettingsCard
          title="Split Screen Layout"
          blurb={
            <>
              Use the <strong className="text-oct-text">+</strong> button in a chat header to add up to 4 panes, and the layout button next to Help in the sidebar to resize and drag them. Choose how panes are arranged:
            </>
          }
        >
          <SegmentedControl value={splitLayout} onChange={setSplitLayout} options={SPLIT_LAYOUT_OPTIONS} />
        </SettingsCard>

        <SettingsCard title="Role Colors">
          <Toggle
            value={roleColors}
            onChange={setRoleColors}
            label="Show Discord role colors on usernames"
          />
        </SettingsCard>

        <SettingsCard title="Mobile Zoom Scale" blurb="Adjust the zoom level on mobile devices to make everything larger or smaller.">
          <div className="flex items-center gap-comfy">
            <input
              type="range"
              min={0.5}
              max={1.5}
              step={0.05}
              value={mobileZoomScale}
              onChange={(e) => setMobileZoomScale(parseFloat(e.target.value))}
              className="flex-1 h-1.5 bg-oct-bg rounded-full appearance-none cursor-pointer accent-oct-accent [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-oct-accent"
            />
            <span className="type-data text-oct-text w-10 text-right">{Math.round(mobileZoomScale * 100)}%</span>
          </div>
          <div className="flex justify-between mt-snug">
            <span className="type-data text-oct-muted">50%</span>
            <button
              onClick={() => setMobileZoomScale(1)}
              className="type-caption font-mono uppercase tracking-wide text-oct-accent hover:text-oct-accent-hover transition-colors duration-100"
            >
              Reset
            </button>
            <span className="type-data text-oct-muted">150%</span>
          </div>
        </SettingsCard>

        <SettingsCard title="Contract Detection">
          <Toggle
            value={contractDetection}
            onChange={setContractDetection}
            label="Detect SOL/EVM contract addresses in messages"
          />
        </SettingsCard>

        <SettingsCard title="Open in Discord App">
          <Toggle
            value={openInDiscordApp}
            onChange={setOpenInDiscordApp}
            label="Clicking a channel badge opens the message directly in the Discord app"
          />
        </SettingsCard>

        <SettingsCard title="Open in Telegram App">
          <Toggle
            value={openInTelegramApp}
            onChange={setOpenInTelegramApp}
            label="Clicking a TG channel badge opens the message directly in the Telegram app"
          />
        </SettingsCard>

        <SettingsCard title="Badge Click Action" blurb="What happens when you click a keyword match or contract badge on a message.">
          <SegmentedControl value={badgeClickAction} onChange={setBadgeClickAction} options={BADGE_CLICK_OPTIONS} />
          <Help className="mt-cozy">
            {badgeClickAction === 'discord' && 'Always opens the original message in Discord.'}
            {badgeClickAction === 'platform' && 'Opens the contract in your configured trading platform if one is detected, otherwise falls back to Discord.'}
            {badgeClickAction === 'both' && 'Opens the message in Discord and also opens the contract in your trading platform (if detected).'}
          </Help>
        </SettingsCard>

        <SettingsCard title="Chat / Send Messages">
          <Toggle
            value={chattingEnabled}
            onChange={setChattingEnabled}
            label="Enable sending messages through OCT"
          />
          <StatusBox tone="critical" className="mt-comfy">
            <p className="type-caption font-mono font-bold uppercase tracking-wide mb-tight">Warning: Detection Risk</p>
            <p className="type-caption text-oct-muted leading-relaxed">
              Sending messages through this app increases the chance of your Discord account being detected and flagged.
              Reading messages is passive and harder to detect, but sending messages leaves a direct API footprint
              that Discord can associate with automated or third-party usage. Use at your own risk.
            </p>
          </StatusBox>
        </SettingsCard>
      </SectionStack>
    </>
  );
}
