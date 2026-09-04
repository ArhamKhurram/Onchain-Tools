import { useCallback, useState } from 'react';
import { useAppStore } from '../../stores/appStore';
import { isHostedMode } from '../../lib/supabase';
import { getSeenIds, markSeen } from '../../utils/announcements';
import { ACTIVATION_CHECKLIST_DISMISS_ID } from '../../lib/activation';

// Dismissal persistence for the activation checklist. No new backend surface:
// it rides the same slot the announcement/updates modals already use.
//
//   local  → `oct_seen_announcements` in localStorage (the desktop app is one
//            user on one machine; the JSON config would work too but the spec
//            for this feature says localStorage, and it needs no round trip).
//   hosted → localStorage as well, PLUS `user_configs.seenAnnouncements` via
//            the config slice so the dismissal follows the account to another
//            browser. AppShell/UpdatesModal already union the two lists.
//
// The id is a string in a list of strings, so the UpdatesModal ignores it (it
// only counts ids that match a slide) and nothing else reads the list by
// position.
export function useChecklistDismissal(): { dismissed: boolean; dismiss: () => void } {
  const seenInConfig = useAppStore((s) => s.config?.seenAnnouncements);
  const updateConfig = useAppStore((s) => s.updateConfig);
  // Read localStorage once per mount; the local write below flips this state so
  // the UI hides immediately without waiting for the config PUT.
  const [seenLocally, setSeenLocally] = useState(() =>
    getSeenIds().includes(ACTIVATION_CHECKLIST_DISMISS_ID),
  );

  const dismissed = seenLocally || (seenInConfig?.includes(ACTIVATION_CHECKLIST_DISMISS_ID) ?? false);

  const dismiss = useCallback(() => {
    markSeen(ACTIVATION_CHECKLIST_DISMISS_ID);
    setSeenLocally(true);
    if (isHostedMode) {
      const current = useAppStore.getState().config?.seenAnnouncements;
      // `config` is null until fetchConfig resolves; a dismissal before then is
      // still honoured locally and simply does not sync — acceptable, rare.
      if (!current) return;
      if (current.includes(ACTIVATION_CHECKLIST_DISMISS_ID)) return;
      void updateConfig({ seenAnnouncements: [...current, ACTIVATION_CHECKLIST_DISMISS_ID] }).catch(() => {
        /* localStorage already has it; the next session syncs nothing but hides fine */
      });
    }
  }, [updateConfig]);

  return { dismissed, dismiss };
}
