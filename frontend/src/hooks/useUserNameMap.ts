import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../stores/appStore';
import { selectAuthorEntries, authorEntriesToMap } from '../utils/authorNameFold';

/**
 * (author id -> display name) lookup for the settings surfaces — the
 * user-name cache from config, overlaid with every author seen in the
 * message buffers.
 *
 * Settings and the room-config modal used to subscribe to the whole
 * `s.messages` map for this, which re-rendered them (and re-folded every
 * stored message) on every incoming message in any room while they were
 * open. The fold's *output* only changes when a new author appears or a
 * display name changes, so the subscription goes through `useShallow` over
 * flat entry strings: message traffic from known authors no longer
 * re-renders the subscriber at all, while a genuinely new author still
 * shows up immediately.
 */
export function useUserNameMap(): Map<string, string> {
  const userNameCache = useAppStore((s) => s.config?.userNameCache);
  const authorEntries = useAppStore(useShallow((s) => selectAuthorEntries(s.messages)));

  return useMemo(
    () => authorEntriesToMap(authorEntries, userNameCache),
    [userNameCache, authorEntries],
  );
}
