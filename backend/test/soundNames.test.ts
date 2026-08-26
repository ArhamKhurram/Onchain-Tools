import { describe, it, expect } from 'vitest';
import { join, resolve, sep } from 'path';
import {
  SOUND_EXTENSIONS,
  validSoundTypes,
  isValidSoundType,
  isValidChannelId,
  soundExtension,
  soundFileName,
  channelSoundFileName,
  soundFileCandidates,
  channelSoundFileCandidates,
} from '../src/api/soundNames.js';

const SOUNDS_DIR = resolve('/srv/oct/backend/data/sounds');

/** The property that actually matters: a name we accept cannot escape SOUNDS_DIR. */
function staysInsideSoundsDir(filename: string): boolean {
  const resolved = resolve(join(SOUNDS_DIR, filename));
  return resolved.startsWith(SOUNDS_DIR + sep);
}

// Values an attacker can put in `:soundType` / `:channelId`. Express decodes
// percent-escapes after routing, so `..%2F..%2Fevil` arrives as `../../evil`
// inside a single path segment.
const TRAVERSAL_PARAMS = [
  '../../evil',
  '../../../etc/cron.d/x',
  '..\\..\\evil',
  '/etc/passwd',
  'highlight/../../evil',
  '..',
  '.',
  './evil',
  'sub/dir/evil',
];

describe('soundExtension', () => {
  it('accepts every allow-listed audio extension', () => {
    for (const ext of SOUND_EXTENSIONS) {
      expect(soundExtension(`clip${ext}`)).toBe(ext);
    }
  });

  it('normalises case so .MP3 and .mp3 cannot become two stored files', () => {
    expect(soundExtension('clip.MP3')).toBe('.mp3');
    expect(soundExtension('clip.WeBm')).toBe('.webm');
  });

  it('rejects non-audio and extensionless names', () => {
    for (const name of ['payload.sh', 'payload.js', 'payload.mp3.exe', 'noextension', '']) {
      expect(soundExtension(name)).toBeNull();
    }
  });
});

describe('soundFileName', () => {
  it('builds the expected name for a valid type (happy path)', () => {
    expect(soundFileName('highlight', 'my clip.mp3')).toBe('highlight.mp3');
    expect(soundFileName('pumpCallout', 'a.WAV')).toBe('pumpCallout.wav');
    for (const type of validSoundTypes) {
      expect(soundFileName(type, 'x.ogg')).toBe(`${type}.ogg`);
    }
  });

  it('returns the allow-listed constant, never the caller-supplied string', () => {
    // A String object that is `===`-unequal to the literal must not slip through.
    expect(soundFileName(new String('highlight'), 'x.mp3')).toBeNull();
  });

  it('rejects an invalid sound type', () => {
    for (const bad of ['nope', 'HIGHLIGHT', '', 'highlight ', null, undefined, 42, {}]) {
      expect(soundFileName(bad, 'x.mp3')).toBeNull();
    }
  });

  it('rejects every path traversal attempt', () => {
    for (const bad of TRAVERSAL_PARAMS) {
      expect(soundFileName(bad, 'x.mp3')).toBeNull();
    }
  });

  it('rejects a valid type carrying a disallowed extension', () => {
    expect(soundFileName('highlight', 'payload.sh')).toBeNull();
  });

  it('never yields a name that escapes SOUNDS_DIR', () => {
    for (const type of [...validSoundTypes, ...TRAVERSAL_PARAMS, 'bogus']) {
      const name = soundFileName(type, 'x.mp3');
      if (name !== null) expect(staysInsideSoundsDir(name)).toBe(true);
    }
  });
});

describe('channelSoundFileName', () => {
  it('builds the expected name for a digits-only channel id (happy path)', () => {
    expect(channelSoundFileName('123456789012345678', 'clip.mp3')).toBe('ch_123456789012345678.mp3');
  });

  it('rejects a non-numeric channel id', () => {
    for (const bad of ['abc', '123abc', '', ' 123', '12.3', '-1', null, undefined, 123]) {
      expect(channelSoundFileName(bad, 'x.mp3')).toBeNull();
    }
  });

  // Regression: the `ch_` prefix was assumed to neutralise traversal. It does
  // not — `path.join(dir, 'ch_../../../evil.mp3')` resolves two levels ABOVE
  // `dir`, because the prefix only absorbs the first `..` segment.
  it('rejects traversal that the ch_ prefix does not neutralise', () => {
    for (const bad of [...TRAVERSAL_PARAMS, '../../../evil', 'x../../../evil']) {
      expect(channelSoundFileName(bad, 'x.mp3')).toBeNull();
    }
  });

  it('demonstrates the ch_ prefix alone would not have contained traversal', () => {
    // Documents the bug this fix closes: naive `ch_${param}` escapes SOUNDS_DIR.
    expect(staysInsideSoundsDir('ch_../../../evil.mp3')).toBe(false);
    // ...whereas every name the helper actually returns is contained.
    const name = channelSoundFileName('123', 'x.mp3');
    expect(name).not.toBeNull();
    expect(staysInsideSoundsDir(name as string)).toBe(true);
  });

  it('rejects an over-long channel id', () => {
    expect(channelSoundFileName('1'.repeat(33), 'x.mp3')).toBeNull();
    expect(channelSoundFileName('1'.repeat(32), 'x.mp3')).toBe(`ch_${'1'.repeat(32)}.mp3`);
  });
});

describe('delete candidates', () => {
  it('lists one contained filename per extension for a valid type', () => {
    const candidates = soundFileCandidates('revival');
    expect(candidates).toEqual(SOUND_EXTENSIONS.map((e) => `revival${e}`));
    for (const name of candidates) expect(staysInsideSoundsDir(name)).toBe(true);
  });

  it('lists one contained filename per extension for a valid channel id', () => {
    const candidates = channelSoundFileCandidates('42');
    expect(candidates).toEqual(SOUND_EXTENSIONS.map((e) => `ch_42${e}`));
    for (const name of candidates) expect(staysInsideSoundsDir(name)).toBe(true);
  });

  it('returns nothing for invalid or traversing params, so no unlink is attempted', () => {
    for (const bad of [...TRAVERSAL_PARAMS, 'bogus', null, undefined]) {
      expect(soundFileCandidates(bad)).toEqual([]);
      expect(channelSoundFileCandidates(bad)).toEqual([]);
    }
  });
});

describe('type guards', () => {
  it('isValidSoundType matches exactly the allow-list', () => {
    for (const t of validSoundTypes) expect(isValidSoundType(t)).toBe(true);
    for (const bad of ['nope', ...TRAVERSAL_PARAMS]) expect(isValidSoundType(bad)).toBe(false);
  });

  it('isValidChannelId accepts digits only', () => {
    expect(isValidChannelId('0')).toBe(true);
    expect(isValidChannelId('123456789012345678')).toBe(true);
    for (const bad of ['', 'a', '1a', ...TRAVERSAL_PARAMS]) expect(isValidChannelId(bad)).toBe(false);
  });
});
