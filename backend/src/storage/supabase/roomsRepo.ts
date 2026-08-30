import { v4 as uuidv4 } from 'uuid';
import type { Room, ChannelRef, KeywordPattern } from '../../discord/types.js';
import { BaseRepo, throwIfError } from './client.js';
import {
  type HighlightRow,
  type KeywordRow,
  appHighlightsToRows,
  appKeywordsToRows,
  dbRoomToAppRoom,
} from './mappers.js';
import type { ConfigRepo } from './configRepo.js';

/**
 * One load of the rooms tables, with the global (room_id-null) highlight and
 * keyword rows split out instead of thrown away. `loadHighlightRows` /
 * `loadKeywordRows` already return the global rows alongside the per-room ones
 * (their or-filter includes `room_id.is.null`), so callers that need both —
 * getConfig — read them from here rather than fetching both tables a second
 * time.
 */
export interface RoomsBundle {
  rooms: Room[];
  globalHighlightRows: HighlightRow[];
  globalKeywordRows: KeywordRow[];
}

export class RoomsRepo extends BaseRepo {
  config!: ConfigRepo;

  async loadHighlightRows(userId: string, roomIds?: string[]): Promise<HighlightRow[]> {
    let query = this.supabase
      .from('highlighted_users')
      .select('room_id, match_type, value, color')
      .eq('user_id', userId);

    if (roomIds && roomIds.length > 0) {
      query = query.or(`room_id.is.null,room_id.in.(${roomIds.join(',')})`);
    }

    const { data, error } = await query;
    throwIfError({ error }, 'Failed to fetch highlighted users');
    return data ?? [];
  }

  async loadKeywordRows(userId: string, roomIds?: string[]): Promise<KeywordRow[]> {
    let query = this.supabase
      .from('keywords')
      .select('room_id, pattern, match_mode, label, enabled')
      .eq('user_id', userId);

    if (roomIds && roomIds.length > 0) {
      query = query.or(`room_id.is.null,room_id.in.(${roomIds.join(',')})`);
    }

    const { data, error } = await query;
    throwIfError({ error }, 'Failed to fetch keywords');
    return data ?? [];
  }

  async syncHighlights(
    userId: string,
    roomId: string | null,
    users: string[],
    colors: Record<string, string> = {},
  ): Promise<void> {
    let deleteQuery = this.supabase.from('highlighted_users').delete().eq('user_id', userId);
    deleteQuery = roomId === null
      ? deleteQuery.is('room_id', null)
      : deleteQuery.eq('room_id', roomId);

    const delResult = await deleteQuery;
    throwIfError(delResult, 'Failed to delete highlighted users');

    const rows = appHighlightsToRows(userId, roomId, users, colors);
    if (rows.length === 0) return;

    const insResult = await this.supabase.from('highlighted_users').insert(rows);
    throwIfError(insResult, 'Failed to store highlighted users');
  }

  async syncKeywords(
    userId: string,
    roomId: string | null,
    patterns: KeywordPattern[],
  ): Promise<void> {
    let deleteQuery = this.supabase.from('keywords').delete().eq('user_id', userId);
    deleteQuery = roomId === null
      ? deleteQuery.is('room_id', null)
      : deleteQuery.eq('room_id', roomId);

    const delResult = await deleteQuery;
    throwIfError(delResult, 'Failed to delete keywords');

    const rows = appKeywordsToRows(userId, roomId, patterns);
    if (rows.length === 0) return;

    const insResult = await this.supabase.from('keywords').insert(rows);
    throwIfError(insResult, 'Failed to store keywords');
  }

  async getRooms(userId: string): Promise<Room[]> {
    return (await this.getRoomsBundle(userId)).rooms;
  }

  async getRoomsBundle(userId: string): Promise<RoomsBundle> {
    const cacheKey = `${userId}:rooms`;
    const cached = this.getCached<RoomsBundle>(cacheKey);
    if (cached) return cached;

    const { data: roomRows } = await this.supabase
      .from('rooms')
      .select('*')
      .eq('user_id', userId)
      .order('created_at');

    // Zero-room users still have global highlight/keyword rows to serve (the
    // roomIds-less load returns every row; only the null-room ones matter).
    if (!roomRows || roomRows.length === 0) {
      const [highlightRows, keywordRows] = await Promise.all([
        this.loadHighlightRows(userId),
        this.loadKeywordRows(userId),
      ]);
      const bundle: RoomsBundle = {
        rooms: [],
        globalHighlightRows: highlightRows.filter((row) => row.room_id === null),
        globalKeywordRows: keywordRows.filter((row) => row.room_id === null),
      };
      this.setCache(cacheKey, bundle);
      return bundle;
    }

    const roomIds = roomRows.map((r) => r.id);
    const [channelResult, highlightRows, keywordRows] = await Promise.all([
      this.supabase.from('room_channels').select('*').in('room_id', roomIds),
      this.loadHighlightRows(userId, roomIds),
      this.loadKeywordRows(userId, roomIds),
    ]);
    const channelRows = channelResult.data;

    const channelsByRoom = new Map<string, ChannelRef[]>();
    for (const ch of channelRows ?? []) {
      const list = channelsByRoom.get(ch.room_id) ?? [];
      list.push({
        source: ch.source ?? 'discord',
        guildId: ch.guild_id,
        channelId: ch.channel_id,
        guildName: ch.guild_name,
        channelName: ch.channel_name,
        disableEmbeds: ch.disable_embeds,
      });
      channelsByRoom.set(ch.room_id, list);
    }

    const highlightsByRoom = new Map<string, HighlightRow[]>();
    for (const row of highlightRows) {
      if (!row.room_id) continue;
      const list = highlightsByRoom.get(row.room_id) ?? [];
      list.push(row);
      highlightsByRoom.set(row.room_id, list);
    }

    const keywordsByRoom = new Map<string, KeywordRow[]>();
    for (const row of keywordRows) {
      if (!row.room_id) continue;
      const list = keywordsByRoom.get(row.room_id) ?? [];
      list.push(row);
      keywordsByRoom.set(row.room_id, list);
    }

    const rooms = roomRows.map((r) =>
      dbRoomToAppRoom(
        r,
        channelsByRoom.get(r.id) ?? [],
        highlightsByRoom.get(r.id) ?? [],
        keywordsByRoom.get(r.id) ?? [],
      ),
    );
    const bundle: RoomsBundle = {
      rooms,
      globalHighlightRows: highlightRows.filter((row) => row.room_id === null),
      globalKeywordRows: keywordRows.filter((row) => row.room_id === null),
    };
    this.setCache(cacheKey, bundle);
    return bundle;
  }

  async getRoom(userId: string, roomId: string): Promise<Room | null> {
    const { data: row } = await this.supabase
      .from('rooms')
      .select('*')
      .eq('id', roomId)
      .eq('user_id', userId)
      .single();

    if (!row) return null;

    const { data: channelRows } = await this.supabase
      .from('room_channels')
      .select('*')
      .eq('room_id', roomId);

    const channels: ChannelRef[] = (channelRows ?? []).map((ch) => ({
      source: ch.source ?? 'discord',
      guildId: ch.guild_id,
      channelId: ch.channel_id,
      guildName: ch.guild_name,
      channelName: ch.channel_name,
      disableEmbeds: ch.disable_embeds,
    }));

    const [highlightRows, keywordRows] = await Promise.all([
      this.loadHighlightRows(userId, [roomId]).then((rows) => rows.filter((r) => r.room_id === roomId)),
      this.loadKeywordRows(userId, [roomId]).then((rows) => rows.filter((r) => r.room_id === roomId)),
    ]);

    return dbRoomToAppRoom(row, channels, highlightRows, keywordRows);
  }

  async createRoom(userId: string, data: Omit<Room, 'id'>): Promise<Room> {
    const roomId = uuidv4();

    const roomResult = await this.supabase.from('rooms').insert({
      id: roomId,
      user_id: userId,
      name: data.name,
      color: data.color ?? null,
      filtered_users: data.filteredUsers ?? [],
      filter_enabled: data.filterEnabled ?? false,
      highlight_mode: data.highlightMode ?? 'background',
    });
    throwIfError(roomResult, 'Failed to create room');

    await this.syncHighlights(
      userId,
      roomId,
      data.highlightedUsers ?? [],
      data.highlightedUserColors ?? {},
    );
    await this.syncKeywords(userId, roomId, data.keywordPatterns ?? []);

    if (data.channels && data.channels.length > 0) {
      const channelRows = data.channels.map((ch) => ({
        room_id: roomId,
        user_id: userId,
        source: ch.source ?? 'discord',
        guild_id: ch.guildId,
        channel_id: ch.channelId,
        guild_name: ch.guildName,
        channel_name: ch.channelName,
        disable_embeds: ch.disableEmbeds ?? false,
      }));
      const chResult = await this.supabase.from('room_channels').insert(channelRows);
      throwIfError(chResult, 'Failed to create room channels');
    }

    this.invalidateUser(userId);
    return { id: roomId, ...data };
  }

  async updateRoom(userId: string, roomId: string, data: Partial<Room>): Promise<Room | null> {
    const existing = await this.getRoom(userId, roomId);
    if (!existing) return null;

    const updateFields: any = {};
    if (data.name !== undefined) updateFields.name = data.name;
    if (data.color !== undefined) updateFields.color = data.color;
    if (data.filteredUsers !== undefined) updateFields.filtered_users = data.filteredUsers;
    if (data.filterEnabled !== undefined) updateFields.filter_enabled = data.filterEnabled;
    if (data.highlightMode !== undefined) updateFields.highlight_mode = data.highlightMode;

    if (Object.keys(updateFields).length > 0) {
      await this.supabase.from('rooms').update(updateFields).eq('id', roomId).eq('user_id', userId);
    }

    if (data.highlightedUsers !== undefined || data.highlightedUserColors !== undefined) {
      await this.syncHighlights(
        userId,
        roomId,
        data.highlightedUsers ?? existing.highlightedUsers,
        data.highlightedUserColors ?? existing.highlightedUserColors ?? {},
      );
    }

    if (data.keywordPatterns !== undefined) {
      await this.syncKeywords(userId, roomId, data.keywordPatterns);
    }

    if (data.channels !== undefined) {
      await this.supabase.from('room_channels').delete().eq('room_id', roomId);
      if (data.channels.length > 0) {
        const channelRows = data.channels.map((ch) => ({
          room_id: roomId,
          user_id: userId,
          source: ch.source ?? 'discord',
          guild_id: ch.guildId,
          channel_id: ch.channelId,
          guild_name: ch.guildName,
          channel_name: ch.channelName,
          disable_embeds: ch.disableEmbeds ?? false,
        }));
        await this.supabase.from('room_channels').insert(channelRows);
      }
    }

    this.invalidateUser(userId);
    return this.getRoom(userId, roomId);
  }

  async deleteRoom(userId: string, roomId: string): Promise<boolean> {
    const { count } = await this.supabase
      .from('rooms')
      .delete({ count: 'exact' })
      .eq('id', roomId)
      .eq('user_id', userId);

    this.invalidateUser(userId);
    return (count ?? 0) > 0;
  }

  // ---- Room queries ----

  async getRoomsForChannel(userId: string, channelId: string): Promise<Room[]> {
    const rooms = await this.getRooms(userId);
    return rooms.filter((r) => r.channels.some((ch) => ch.channelId === channelId));
  }

  async isChannelSubscribed(userId: string, channelId: string): Promise<boolean> {
    const rooms = await this.getRooms(userId);
    return rooms.some((r) => r.channels.some((ch) => ch.channelId === channelId));
  }

  async isUserHighlighted(userId: string, discordUserId: string, roomId?: string, username?: string | null): Promise<boolean> {
    const matchesList = (list: string[]) =>
      list.includes(discordUserId) ||
      (username ? list.some((e) => e.startsWith('@') && e.slice(1).toLowerCase() === username.toLowerCase()) : false);

    const config = await this.config.getConfig(userId);
    if (matchesList(config.globalHighlightedUsers)) return true;

    if (roomId) {
      const room = await this.getRoom(userId, roomId);
      return room ? matchesList(room.highlightedUsers) : false;
    }

    const rooms = await this.getRooms(userId);
    return rooms.some((r) => matchesList(r.highlightedUsers));
  }
}
