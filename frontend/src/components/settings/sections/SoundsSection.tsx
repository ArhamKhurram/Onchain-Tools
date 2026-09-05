import type { ReactNode } from 'react';
import { Trash2, Volume2, Upload, Play, Send } from 'lucide-react';
import type { SoundConfig, SoundType } from '../../../types';
import { TOAST_POSITIONS } from '../../../types';
import { requestNotificationPermission } from '../../../utils/desktopNotification';
import { previewSound, previewPreset, PRESET_SOUNDS } from '../../../utils/notificationSound';
import {
  Chip,
  ChipRow,
  FieldLabel,
  FieldRow,
  Help,
  Kicker,
  MiniSwitch,
  RemoveButton,
  SectionHeader,
  SectionStack,
  SegmentedControl,
  SettingsCard,
  Toggle,
} from '../fields';
import type { SettingsForm } from '../useSettingsForm';

const SOUND_TYPES: readonly [SoundType, string][] = [
  ['highlight', 'Highlighted User'],
  ['contractAlert', 'Contract Alert'],
  ['keywordAlert', 'Keyword Match'],
  ['fomoTrade', 'FOMO Trade'],
  ['pumpCallout', 'Pump Callout'],
  ['revival', 'Revival'],
  ['breakout', 'Breakout'],
];

type SoundSource = 'default' | 'preset' | 'custom';

const sourceOf = (sc: SoundConfig): SoundSource =>
  sc.useCustom ? 'custom' : sc.presetSound ? 'preset' : 'default';

const SOURCE_OPTIONS: readonly { value: SoundSource; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'preset', label: 'Preset' },
  { value: 'custom', label: 'Custom' },
];

/**
 * One configurable sound: enable switch, volume, source picker, preset grid or
 * custom-file controls. The per-alert-type and per-channel lists used to carry
 * two verbatim copies of this block; the only differences are the upload
 * endpoint and the state setter, which the caller keeps.
 */
function SoundRow({
  label,
  leading,
  trailing,
  sc,
  patch,
  onPreview,
  onUpload,
  onRemoveCustom,
  children,
}: {
  label: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  sc: SoundConfig;
  /** Merge a partial config into this sound's entry. */
  patch: (next: Partial<SoundConfig>) => void;
  onPreview: () => void;
  onUpload: () => void;
  onRemoveCustom: () => Promise<void>;
  /** Extra rows rendered under the volume slider while enabled (revival repeat). */
  children?: ReactNode;
}) {
  const selectSource = (source: SoundSource) => {
    if (source === 'default') patch({ useCustom: false, presetSound: undefined });
    else if (source === 'preset') patch({ useCustom: false, presetSound: sc.presetSound || 'ping' });
    else if (sc.customSoundUrl) patch({ useCustom: true, presetSound: undefined });
    else onUpload();
  };

  return (
    <FieldRow className="space-y-cozy">
      <div className="flex items-center justify-between gap-cozy">
        <div className="flex items-center gap-cozy min-w-0">
          <Volume2 size={14} className="text-oct-muted shrink-0" />
          {leading}
          <span className="type-body font-medium text-oct-text truncate">{label}</span>
          {trailing}
        </div>
        <div className="flex items-center gap-cozy">
          <button
            type="button"
            onClick={onPreview}
            className="p-tight rounded-oct-sm text-oct-muted hover:text-oct-accent hover:bg-oct-surface transition-colors duration-100"
            title="Preview sound"
          >
            <Play size={14} />
          </button>
          <MiniSwitch value={sc.enabled} onChange={(v) => patch({ enabled: v })} label={`${label} sound`} />
        </div>
      </div>

      {sc.enabled && (
        <>
          <div className="flex items-center gap-comfy">
            <Kicker className="w-14 shrink-0">Volume</Kicker>
            <input
              type="range"
              min={0}
              max={100}
              value={sc.volume}
              onChange={(e) => patch({ volume: Number(e.target.value) })}
              className="flex-1 h-1.5 accent-oct-accent cursor-pointer"
            />
            <span className="type-data text-oct-muted w-10 text-right">{sc.volume}%</span>
          </div>

          {children}

          <div className="space-y-cozy">
            <div className="flex flex-wrap items-center gap-cozy">
              <Kicker>Sound:</Kicker>
              <SegmentedControl value={sourceOf(sc)} onChange={selectSource} options={SOURCE_OPTIONS} size="sm" />
            </div>
            {!sc.useCustom && sc.presetSound && (
              <ChipRow>
                {PRESET_SOUNDS.map((preset) => (
                  <Chip
                    key={preset.id}
                    size="sm"
                    active={sc.presetSound === preset.id}
                    onClick={() => {
                      patch({ presetSound: preset.id });
                      previewPreset(preset.id, sc.volume);
                    }}
                  >
                    {preset.label}
                  </Chip>
                ))}
              </ChipRow>
            )}
            {sc.useCustom && (
              <div className="flex items-center gap-cozy">
                {sc.customSoundUrl && (
                  <span className="type-data text-oct-muted truncate">{sc.customSoundUrl.split('/').pop()}</span>
                )}
                <button
                  type="button"
                  onClick={onUpload}
                  className="p-tight rounded-oct-sm text-oct-muted hover:text-oct-accent hover:bg-oct-surface transition-colors duration-100"
                  title="Upload sound"
                >
                  <Upload size={12} />
                </button>
                {sc.customSoundUrl && (
                  <RemoveButton onClick={() => { void onRemoveCustom(); }} title="Remove custom sound">
                    <Trash2 size={12} />
                  </RemoveButton>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </FieldRow>
  );
}

export default function SoundsSection({ form }: { form: SettingsForm }) {
  const { config, messageSounds, setMessageSounds, soundSettings, setSoundSettings, channelSounds, setChannelSounds, uploadingSoundType, setUploadingSoundType, uploadingChannelId, setUploadingChannelId, fileInputRef, channelFileInputRef, desktopNotifications, setDesktopNotifications, toastAlertsEnabled, setToastAlertsEnabled, toastPosition, setToastPosition } = form;

  const patchSound = (type: SoundType, next: Partial<SoundConfig>) =>
    setSoundSettings((prev) => ({ ...prev, [type]: { ...prev[type], ...next } }));
  const patchChannel = (chId: string, next: Partial<SoundConfig>) =>
    setChannelSounds((prev) => ({ ...prev, [chId]: { ...prev[chId], ...next } }));

  return (
    <>
      <SectionHeader title="Sounds & Notifications" />

      <SectionStack>
        <SettingsCard title="On-site toast alerts">
          <Toggle
            value={toastAlertsEnabled}
            onChange={setToastAlertsEnabled}
            label="Show in-app toast popups for highlighted users, contracts, keywords, convergence, FOMO trades, and pump callouts"
          />
          {toastAlertsEnabled && (
            <div className="mt-comfy">
              <FieldLabel>Toast position</FieldLabel>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-snug">
                {TOAST_POSITIONS.map(({ value, label }) => (
                  <Chip key={value} size="sm" active={toastPosition === value} onClick={() => setToastPosition(value)} className="text-center">
                    {label}
                  </Chip>
                ))}
              </div>
            </div>
          )}
        </SettingsCard>

        <SettingsCard title="Desktop Notifications">
          <Toggle
            value={desktopNotifications}
            onChange={async (v) => {
              if (v) {
                const perm = await requestNotificationPermission();
                if (perm === 'denied') {
                  alert('Notification permission was denied. Please allow notifications for this site in your browser settings, then try again.');
                  return;
                }
              }
              setDesktopNotifications(v);
            }}
            label="Show browser notifications for highlighted users and keyword matches (when tab is not focused)"
          />
        </SettingsCard>

        <SettingsCard title="Sound Settings">
          <Toggle
            value={messageSounds}
            onChange={setMessageSounds}
            label="Enable notification sounds (master toggle)"
          />

          {messageSounds && (
            <div className="space-y-cozy mt-comfy">
              <input
                type="file"
                ref={fileInputRef}
                accept=".mp3,.wav,.ogg,.webm,.m4a"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file || !uploadingSoundType) return;
                  const formData = new FormData();
                  formData.append('file', file);
                  try {
                    const res = await fetch(`/api/sounds/${uploadingSoundType}`, { method: 'POST', body: formData });
                    const data = await res.json();
                    if (res.ok && data.url) {
                      patchSound(uploadingSoundType, { useCustom: true, customSoundUrl: data.url });
                    }
                  } catch { /* ignore */ }
                  setUploadingSoundType(null);
                  e.target.value = '';
                }}
              />
              {SOUND_TYPES.map(([type, label]) => {
                const sc = soundSettings[type];
                return (
                  <SoundRow
                    key={type}
                    label={label}
                    sc={sc}
                    patch={(next) => patchSound(type, next)}
                    onPreview={() => previewSound(type, sc)}
                    onUpload={() => { setUploadingSoundType(type); fileInputRef.current?.click(); }}
                    onRemoveCustom={async () => {
                      await fetch(`/api/sounds/${type}`, { method: 'DELETE' });
                      patchSound(type, { useCustom: false, customSoundUrl: undefined });
                    }}
                  >
                    {type === 'revival' && (
                      <div className="flex items-center justify-between gap-comfy">
                        <Help>Repeat every ~5s until the revival banner is dismissed</Help>
                        <MiniSwitch
                          value={sc.repeatUntilDismissed !== false}
                          onChange={() => setSoundSettings((prev) => ({
                            ...prev,
                            revival: { ...prev.revival, repeatUntilDismissed: !(prev.revival.repeatUntilDismissed !== false) },
                          }))}
                          label="Repeat revival sound until dismissed"
                        />
                      </div>
                    )}
                  </SoundRow>
                );
              })}
            </div>
          )}
        </SettingsCard>

        <SettingsCard
          title="Channel Sounds"
          blurb="Play a notification sound for every message in specific channels, even when no highlight or keyword matches."
        >
          <input
            type="file"
            ref={channelFileInputRef}
            accept=".mp3,.wav,.ogg,.webm,.m4a"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file || !uploadingChannelId) return;
              const formData = new FormData();
              formData.append('file', file);
              try {
                const res = await fetch(`/api/channel-sounds/${uploadingChannelId}`, { method: 'POST', body: formData });
                const data = await res.json();
                if (res.ok && data.url) {
                  setChannelSounds((prev) => ({
                    ...prev,
                    [uploadingChannelId]: { ...(prev[uploadingChannelId] ?? { enabled: true, volume: 80, useCustom: false }), useCustom: true, customSoundUrl: data.url },
                  }));
                }
              } catch { /* ignore */ }
              setUploadingChannelId(null);
              e.target.value = '';
            }}
          />
          {(() => {
            const rooms = config?.rooms ?? [];
            const seen = new Set<string>();
            const channels: { id: string; name: string; guildName: string | null; source: 'discord' | 'telegram' }[] = [];
            for (const room of rooms) {
              for (const ch of room.channels) {
                if (!seen.has(ch.channelId)) {
                  seen.add(ch.channelId);
                  channels.push({ id: ch.channelId, name: ch.channelName ?? ch.channelId, guildName: ch.guildName ?? null, source: (ch.source ?? 'discord') as 'discord' | 'telegram' });
                }
              }
            }
            if (channels.length === 0) return <Help className="italic">No channels in rooms yet</Help>;

            const discordChannels = channels.filter((c) => c.source !== 'telegram');
            const telegramChannels = channels.filter((c) => c.source === 'telegram');

            const discordGrouped = new Map<string, typeof channels>();
            for (const ch of discordChannels) {
              const key = ch.guildName ?? 'DMs';
              if (!discordGrouped.has(key)) discordGrouped.set(key, []);
              discordGrouped.get(key)!.push(ch);
            }

            const enabledIds = Object.keys(channelSounds);

            const toggleChannel = (id: string) => {
              if (id in channelSounds) {
                setChannelSounds((prev) => {
                  const next = { ...prev };
                  delete next[id];
                  return next;
                });
              } else {
                setChannelSounds((prev) => ({
                  ...prev,
                  [id]: { enabled: true, volume: 80, useCustom: false },
                }));
              }
            };

            return (
              <div className="space-y-comfy">
                {/* Channel picker */}
                <div className="space-y-cozy">
                  {Array.from(discordGrouped.entries()).map(([guildName, guildChannels]) => (
                    <div key={guildName}>
                      <Kicker className="mb-tight">{guildName}</Kicker>
                      <ChipRow>
                        {guildChannels.map((ch) => (
                          <Chip key={ch.id} size="sm" active={ch.id in channelSounds} onClick={() => toggleChannel(ch.id)}>
                            #{ch.name}
                          </Chip>
                        ))}
                      </ChipRow>
                    </div>
                  ))}

                  {telegramChannels.length > 0 && (
                    <div>
                      <Kicker className="mb-tight flex items-center gap-tight text-oct-accent">
                        <Send size={10} />
                        Telegram
                      </Kicker>
                      <ChipRow>
                        {telegramChannels.map((ch) => (
                          <Chip key={ch.id} size="sm" active={ch.id in channelSounds} onClick={() => toggleChannel(ch.id)}>
                            {ch.name}
                          </Chip>
                        ))}
                      </ChipRow>
                    </div>
                  )}
                </div>

                {/* Per-channel sound configs */}
                {enabledIds.length > 0 && (
                  <div className="space-y-cozy">
                    {enabledIds.map((chId) => {
                      const sc = channelSounds[chId];
                      const chInfo = channels.find((c) => c.id === chId);
                      const isTg = chInfo?.source === 'telegram';
                      const label = chInfo ? (isTg ? chInfo.name : `#${chInfo.name}`) : `#${chId}`;
                      return (
                        <SoundRow
                          key={chId}
                          label={label}
                          leading={isTg ? <Send size={12} className="text-oct-accent shrink-0" /> : undefined}
                          trailing={
                            isTg
                              ? <span className="type-caption font-mono text-oct-accent hidden sm:inline">Telegram</span>
                              : chInfo?.guildName && <span className="type-caption font-mono text-oct-muted hidden sm:inline">{chInfo.guildName}</span>
                          }
                          sc={sc}
                          patch={(next) => patchChannel(chId, next)}
                          onPreview={() => previewSound('highlight', sc)}
                          onUpload={() => { setUploadingChannelId(chId); channelFileInputRef.current?.click(); }}
                          onRemoveCustom={async () => {
                            await fetch(`/api/channel-sounds/${chId}`, { method: 'DELETE' });
                            patchChannel(chId, { useCustom: false, customSoundUrl: undefined });
                          }}
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })()}
        </SettingsCard>
      </SectionStack>
    </>
  );
}
