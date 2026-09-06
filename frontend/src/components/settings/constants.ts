import { Key, Settings2, Zap, Volume2, Bell, Bot, Tag, AtSign, Users, Shield, HelpCircle, Gauge, TrendingUp } from 'lucide-react';
import type { SoundConfig, PushoverTriggers, PushoverFilters, MissedRunnerConfig, DiscordBotDmConfig } from '../../types';

export type Section = 'tokens' | 'general' | 'contracts' | 'callerquality' | 'mcapalerts' | 'sounds' | 'pushover' | 'discordbot' | 'keywords' | 'mentions' | 'users' | 'guilds' | 'help';

export const SECTIONS: { id: Section; label: string; icon: typeof Key }[] = [
  { id: 'tokens', label: 'Tokens', icon: Key },
  { id: 'general', label: 'General', icon: Settings2 },
  { id: 'contracts', label: 'Contracts', icon: Zap },
  { id: 'callerquality', label: 'Caller Quality', icon: Gauge },
  { id: 'mcapalerts', label: 'Market-Cap Alerts', icon: TrendingUp },
  { id: 'sounds', label: 'Sounds & Notifications', icon: Volume2 },
  { id: 'pushover', label: 'Pushover', icon: Bell },
  { id: 'discordbot', label: 'Discord Bot', icon: Bot },
  { id: 'keywords', label: 'Keywords', icon: Tag },
  { id: 'mentions', label: 'Mentions', icon: AtSign },
  { id: 'users', label: 'Highlighted Users', icon: Users },
  { id: 'guilds', label: 'Guilds', icon: Shield },
  { id: 'help', label: 'Help & Features', icon: HelpCircle },
];

export const defaultSoundConfig: SoundConfig = { enabled: true, volume: 80, useCustom: false };
// Revival is the loudest alert class: full volume + repeat-until-dismissed by default.
export const defaultRevivalSoundConfig: SoundConfig = { enabled: true, volume: 100, useCustom: false, repeatUntilDismissed: true };
export const defaultTriggers: PushoverTriggers = { highlightedUser: false, highlightedUserContract: true, contract: false, keyword: false, signalConvergence: false, missedRunner: false };
export const defaultFilters: PushoverFilters = { userIds: [], channelIds: [], guildIds: [] };
export const defaultDiscordBotDm: DiscordBotDmConfig = {
  enabled: false,
  // releaseNotes and dailyDigest default off like every other trigger — enabling
  // bot DMs is not consent to receive changelog posts or a daily summary.
  //
  // pumpCallout defaults ON (like missedRunner) because it cannot fire on
  // ambient volume: it only ever DMs about a caller the user went and followed,
  // and each follow carries its own per-caller mute. The master `enabled` switch
  // above still gates it, and the BACKEND reads a stored config missing this key
  // as false — so this default only ever applies to a fresh/re-saved config.
  triggers: { highlightedUser: false, highlightedUserContract: true, contract: false, keyword: false, missedRunner: true, releaseNotes: false, dailyDigest: false, pumpCallout: true },
};
export const defaultMissedRunner: MissedRunnerConfig = { enabled: false, minMultiplier: 1.5, lookbackHours: 24, cooldownHours: 24, notifyVia: 'toast' };
