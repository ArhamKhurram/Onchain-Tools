import type { FrontendMessage } from '../types';

/**
 * Delimiter for the folded switcher entries. U+0000 cannot appear in room keys
 * or display names, so splitting on it is unambiguous.
 */
const SEP = String.fromCharCode(0);

/**
 * DM rooms that should appear in a pane's room-switcher dropdown, folded into
 * flat strings so a `useShallow` subscription stays referentially quiet while
 * unrelated message traffic churns the store.
 *
 * Each entry is `key<SEP>channelName<SEP>authorDisplayName`, taken from the
 * room's first message — the only bits of the messages map the switcher label
 * actually needs. New messages in existing rooms don't change these strings,
 * so a pane subscribed via `useShallow` only re-renders when a DM room
 * appears, empties, or its label seed changes.
 */
export function selectDmSwitcherEntries(messages: Record<string, FrontendMessage[]>): string[] {
  const out: string[] = [];
  for (const key of Object.keys(messages)) {
    if (!key.startsWith('dm:') && !key.startsWith('tg-dm:')) continue;
    const first = messages[key]?.[0];
    if (!first) continue;
    out.push(`${key}${SEP}${first.channelName ?? ''}${SEP}${first.author.displayName ?? ''}`);
  }
  return out;
}

/** Split one entry back into its parts. */
export function parseDmSwitcherEntry(entry: string): { key: string; channelName: string; authorName: string } {
  const [key, channelName, authorName] = entry.split(SEP);
  return { key, channelName, authorName };
}
