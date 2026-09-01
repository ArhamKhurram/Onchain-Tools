import type { StateCreator } from 'zustand';
import type { FrontendMessage, FrontendReaction, ReactionUser } from '../../types';
import type { AppState } from '../appStore';
import { getClientGatewayManager, isClientGatewayMode } from '../../discord/clientGateway';
import { apiFetch, API_BASE, MAX_MESSAGES_PER_ROOM } from '../appStore.helpers';

export interface MessagesSlice {
  messages: Record<string, FrontendMessage[]>;

  addMessage: (message: FrontendMessage, roomIds: string[], isLive?: boolean) => void;
  updateMessage: (update: { messageId: string; channelId: string; embeds?: FrontendMessage['embeds']; content?: string; attachments?: FrontendMessage['attachments']; editedTimestamp?: string | null }) => void;
  markMessageDeleted: (data: { messageId: string; channelId: string }) => void;
  updateReaction: (channelId: string, messageId: string, emoji: FrontendReaction['emoji'], delta: number) => void;
  fetchHistory: () => Promise<void>;
  fetchReactionUsers: (channelId: string, messageId: string, emoji: FrontendReaction['emoji']) => Promise<ReactionUser[]>;
  sendMessage: (channelId: string, content: string, files?: File[], source?: 'discord' | 'telegram') => Promise<{ success: boolean; error?: string }>;
}

export const createMessagesSlice: StateCreator<AppState, [], [], MessagesSlice> = (set) => {
  return {
    messages: {},

    addMessage: (message, roomIds, isLive = false) => {
      set((state) => {
        const newMessages = { ...state.messages };
        const newUnread = { ...state.unreadCounts };
        let unreadChanged = false;
        const visible = state.activeView === 'chat' ? new Set(state.paneRoomIds) : new Set<string>();
        for (const roomId of roomIds) {
          const existing = newMessages[roomId] ?? [];
          if (existing.some((m) => m.id === message.id)) continue;
          const updated = [...existing, message];
          if (updated.length > MAX_MESSAGES_PER_ROOM) {
            updated.splice(0, updated.length - MAX_MESSAGES_PER_ROOM);
          }
          newMessages[roomId] = updated;
          if (isLive && !visible.has(roomId)) {
            newUnread[roomId] = (newUnread[roomId] ?? 0) + 1;
            unreadChanged = true;
          }
        }
        return unreadChanged ? { messages: newMessages, unreadCounts: newUnread } : { messages: newMessages };
      });
    },

    updateMessage: (update) => {
      set((state) => {
        const newMessages = { ...state.messages };
        let changed = false;
        for (const roomId of Object.keys(newMessages)) {
          const msgs = newMessages[roomId];
          const idx = msgs.findIndex((m) => m.id === update.messageId && m.channelId === update.channelId);
          if (idx === -1) continue;
          changed = true;
          const msg = { ...msgs[idx] };
          const isGenuineEdit = !!update.editedTimestamp;
          const contentChanged = update.content !== undefined && update.content !== msg.content;
          if (isGenuineEdit && contentChanged) {
            if (msg.originalContent === undefined) msg.originalContent = msg.content;
            msg.isEdited = true;
            msg.editedTimestamp = update.editedTimestamp;
          }
          if (update.embeds !== undefined) msg.embeds = update.embeds;
          if (update.content !== undefined) msg.content = update.content;
          if (update.attachments !== undefined) msg.attachments = update.attachments;
          const updated = [...msgs];
          updated[idx] = msg;
          newMessages[roomId] = updated;
        }
        return changed ? { messages: newMessages } : state;
      });
    },

    markMessageDeleted: (data) => {
      set((state) => {
        const newMessages = { ...state.messages };
        let changed = false;
        for (const roomId of Object.keys(newMessages)) {
          const msgs = newMessages[roomId];
          const idx = msgs.findIndex((m) => m.id === data.messageId && m.channelId === data.channelId);
          if (idx === -1) continue;
          if (msgs[idx].isDeleted) continue;
          changed = true;
          const updated = [...msgs];
          updated[idx] = { ...msgs[idx], isDeleted: true };
          newMessages[roomId] = updated;
        }
        return changed ? { messages: newMessages } : state;
      });
    },

    updateReaction: (channelId, messageId, emoji, delta) => {
      set((state) => {
        const newMessages = { ...state.messages };
        let changed = false;
        for (const roomId of Object.keys(newMessages)) {
          const msgs = newMessages[roomId];
          const idx = msgs.findIndex((m) => m.id === messageId && m.channelId === channelId);
          if (idx === -1) continue;
          changed = true;
          const msg = { ...msgs[idx] };
          const reactions = [...(msg.reactions ?? [])];
          const emojiKey = emoji.id ?? emoji.name;
          const rIdx = reactions.findIndex((r) => (r.emoji.id ?? r.emoji.name) === emojiKey);
          if (rIdx >= 0) {
            const newCount = reactions[rIdx].count + delta;
            if (newCount <= 0) {
              reactions.splice(rIdx, 1);
            } else {
              reactions[rIdx] = { ...reactions[rIdx], count: newCount };
            }
          } else if (delta > 0) {
            reactions.push({ emoji, count: delta });
          }
          msg.reactions = reactions;
          const updated = [...msgs];
          updated[idx] = msg;
          newMessages[roomId] = updated;
        }
        return changed ? { messages: newMessages } : state;
      });
    },

    fetchHistory: async () => {
      try {
        const res = await apiFetch(`${API_BASE}/history`);
        if (!res.ok) return;
        const history: Record<string, FrontendMessage[]> = await res.json();
        set((state) => {
          const newMessages = { ...state.messages };
          for (const [roomId, msgs] of Object.entries(history)) {
            const existing = newMessages[roomId] ?? [];
            const existingIds = new Set(existing.map((m) => m.id));
            const fresh = msgs.filter((m) => !existingIds.has(m.id));
            if (fresh.length > 0) {
              const merged = [...fresh, ...existing];
              merged.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
              if (merged.length > MAX_MESSAGES_PER_ROOM) {
                merged.splice(0, merged.length - MAX_MESSAGES_PER_ROOM);
              }
              newMessages[roomId] = merged;
            }
          }
          return { messages: newMessages };
        });
      } catch (err) {
        console.error('[Store] Failed to fetch history:', err);
      }
    },

    fetchReactionUsers: async (channelId, messageId, emoji) => {
      if (isClientGatewayMode()) {
        const gw = getClientGatewayManager();
        if (!gw) throw new Error('Discord is not connected.');
        const emojiKey = emoji.id ? `${emoji.name}:${emoji.id}` : emoji.name;
        const users = await gw.fetchReactionUsers(channelId, messageId, emojiKey);
        return users.map((u) => ({
          id: u.id,
          username: u.username,
          displayName: u.global_name ?? u.username,
          avatar: u.avatar,
          discriminator: u.discriminator,
        }));
      }
      const params = new URLSearchParams({ name: emoji.name });
      if (emoji.id) params.set('id', emoji.id);
      const res = await apiFetch(`${API_BASE}/reactions/${channelId}/${messageId}?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to fetch reaction users');
      return res.json();
    },

    sendMessage: async (channelId, content, files, source) => {
      if (isClientGatewayMode() && source !== 'telegram') {
        try {
          const gw = getClientGatewayManager();
          if (!gw) return { success: false, error: 'Discord is not connected.' };
          const attachments = files?.map((file) => ({
            filename: file.name,
            data: file,
            contentType: file.type || 'application/octet-stream',
          }));
          await gw.sendChannelMessage(channelId, content, attachments);
          return { success: true };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      }
      try {
        const formData = new FormData();
        formData.append('channelId', channelId);
        formData.append('content', content);
        if (source) {
          formData.append('source', source);
        }
        if (files) {
          for (const file of files) {
            formData.append('files', file);
          }
        }
        const res = await apiFetch(`${API_BASE}/send-message`, {
          method: 'POST',
          body: formData,
        });
        const data = await res.json();
        if (!res.ok) return { success: false, error: data.error };
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
  };
};
