import { extname } from 'path';
import type { SoundType } from '../discord/types.js';

// Every filename that a sound upload writes to disk is derived here.
//
// Why this module exists at all: the sound routes name their files after a
// route param (`:soundType`, `:channelId`), and route params are fully
// attacker-controlled. Express decodes percent-escapes *after* matching, so a
// single path segment `..%2F..%2Fevil` arrives in `req.params` as `../../evil`.
// multer's diskStorage then does `path.join(destination, filename)`, which
// normalises the `..` away and escapes SOUNDS_DIR entirely. A `ch_` prefix does
// not save you either — `path.join(dir, 'ch_../../../evil.mp3')` resolves two
// levels above `dir`, because the prefix only absorbs the first `..` segment.
//
// So: never concatenate a raw param into a path. These helpers take the
// untrusted value, check it against an allow-list, and build the name from the
// *matched constant* — the request string itself never reaches the filesystem.
// They are pure and side-effect free so they can be unit tested directly.

export const SOUND_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.webm', '.m4a'] as const;

export const validSoundTypes: SoundType[] = [
  'highlight',
  'contractAlert',
  'keywordAlert',
  'fomoTrade',
  'pumpCallout',
  'revival',
  'breakout',
];

/** Discord snowflakes are digits only; the length bound keeps names sane. */
export function isValidChannelId(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,32}$/.test(value);
}

export function isValidSoundType(value: unknown): value is SoundType {
  return typeof value === 'string' && (validSoundTypes as string[]).includes(value);
}

/**
 * Normalised extension for an uploaded file, or null if it is not an audio type
 * we accept. Lower-cased so `.MP3` and `.mp3` cannot produce two stored files.
 */
export function soundExtension(originalName: string): string | null {
  const ext = extname(originalName).toLowerCase();
  return (SOUND_EXTENSIONS as readonly string[]).includes(ext) ? ext : null;
}

/** Destination filename for a per-type sound, or null if the type is not allow-listed. */
export function soundFileName(soundType: unknown, originalName: string): string | null {
  const ext = soundExtension(originalName);
  // `find` returns the constant from the allow-list, not the caller's string.
  const safeType = validSoundTypes.find((t) => t === soundType);
  if (!ext || !safeType) return null;
  return `${safeType}${ext}`;
}

/** Destination filename for a per-channel sound, or null if the id is not digits-only. */
export function channelSoundFileName(channelId: unknown, originalName: string): string | null {
  const ext = soundExtension(originalName);
  if (!ext || !isValidChannelId(channelId)) return null;
  return `ch_${channelId}${ext}`;
}

/** Every filename a per-type sound could have been stored under (used by delete). */
export function soundFileCandidates(soundType: unknown): string[] {
  const safeType = validSoundTypes.find((t) => t === soundType);
  if (!safeType) return [];
  return SOUND_EXTENSIONS.map((ext) => `${safeType}${ext}`);
}

/** Every filename a per-channel sound could have been stored under (used by delete). */
export function channelSoundFileCandidates(channelId: unknown): string[] {
  if (!isValidChannelId(channelId)) return [];
  return SOUND_EXTENSIONS.map((ext) => `ch_${channelId}${ext}`);
}
