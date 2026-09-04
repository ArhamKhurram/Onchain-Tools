import type { AppConfig, FrontendMessage, Room } from '../../types';
import type { HiddenUserEntry } from '../HiddenUsersPanel';

/** A pane-local "only this channel" lens, toggled from a row's eye icon. */
export type FocusFilter = { guildId: string | null; channelId: string; guildName: string | null; channelName: string } | null;

type HiddenUsers = NonNullable<AppConfig['hiddenUsers']>;

/**
 * The pane's visible-message pipeline: room user-filter → hidden users →
 * focus lens. Runs on every pane render (it is not memoised, matching the
 * pre-split behaviour — the room cap keeps it at ≤1000 rows). Always returns a
 * fresh array; downstream memos key off the result's identity accordingly.
 */
export function filterRoomMessages(
  allRoomMessages: FrontendMessage[],
  activeRoom: Room | undefined,
  hiddenUsers: HiddenUsers,
  focusFilter: FocusFilter,
): FrontendMessage[] {
  const isFilterActive = activeRoom?.filterEnabled && (activeRoom?.filteredUsers?.length ?? 0) > 0;
  const filterSet = new Set(activeRoom?.filteredUsers?.map((u) => u.toLowerCase()) ?? []);

  const isUserHidden = (msg: FrontendMessage) => {
    const key = `${msg.guildId ?? 'null'}:${msg.channelId}`;
    return hiddenUsers[key]?.some((e) => e.userId === msg.author.id) ?? false;
  };

  const afterFilter = isFilterActive
    ? allRoomMessages.filter((msg) =>
        filterSet.has(msg.author.id) ||
        filterSet.has(msg.author.username.toLowerCase()) ||
        filterSet.has(msg.author.displayName.toLowerCase())
      )
    : allRoomMessages;

  const afterHidden = afterFilter.filter((msg) => !isUserHidden(msg));

  return focusFilter
    ? afterHidden.filter((msg) => msg.guildId === focusFilter.guildId && msg.channelId === focusFilter.channelId)
    : afterHidden;
}

/** Hidden-user entries across every channel of the room, for the header
 *  badge and the unhide panel. */
export function collectChannelHiddenUsers(activeRoom: Room | undefined, hiddenUsers: HiddenUsers): HiddenUserEntry[] {
  if (!activeRoom) return [];
  return activeRoom.channels.flatMap((ch) => {
    const key = `${ch.guildId ?? 'null'}:${ch.channelId}`;
    return (hiddenUsers[key] ?? []).map((entry) => ({
      userId: entry.userId,
      displayName: entry.displayName,
      guildId: ch.guildId,
      channelId: ch.channelId,
      channelName: ch.channelName ?? ch.channelId,
      guildName: ch.guildName ?? null,
    }));
  });
}
