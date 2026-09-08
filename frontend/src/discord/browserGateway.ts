import { EventEmitter } from './emitter';
import type {
  GatewayPayload,
  DiscordMessage,
  DiscordUser,
  GuildInfo,
  DMChannel,
  GatewayAuthFailure,
} from './types';
import { GatewayOpcodes } from './types';
import {
  buildGuildPermissionContext,
  filterPickableChannels,
  mergedMembersAt,
  readGuildChannels,
  readGuildPermissionSnapshot,
  type RawGuildChannel,
} from '@oct/shared';

const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const REST_BASE = 'https://discord.com/api/v10';

// Mirrors backend/src/discord/gateway.ts — the same guild record, because the
// picker is fed by the browser gateway in hosted mode and by the server one in
// local mode, and only one of those may be allowed to leak channel names.
// Channels are kept RAW here (every type, overwrites included); getGuilds()
// applies the type + VIEW_CHANNEL filters once the user's roles are known.
interface GuildRecord {
  id: string;
  name: string;
  icon: string | null;
  ownerId: string | null;
  rolePermissions: Map<string, bigint>;
  // null = the frame did not carry the signed-in user's member object; REST
  // fills it in on demand. Never treat null as "holds no roles".
  memberRoleIds: Set<string> | null;
  channels: RawGuildChannel[];
}

const MEMBER_FETCH_CONCURRENCY = 5;
const SELF_ROLES_TTL_MS = 10 * 60 * 1000;

export class BrowserDiscordGateway extends EventEmitter {
  private ws: WebSocket | null = null;
  private token: string;
  private tokenIndex: number;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private lastSequence: number | null = null;
  private sessionId: string | null = null;
  private resumeGatewayUrl: string | null = null;
  private guilds: Map<string, GuildRecord> = new Map();
  private dmChannels: Map<string, DMChannel> = new Map();
  private channelGuildMap: Map<string, string> = new Map();
  private channelNameMap: Map<string, string> = new Map();
  private roleNameMap: Map<string, string> = new Map();
  private roleDataMap: Map<string, { name: string; color: number; position: number }> = new Map();
  private selfUserId: string | null = null;
  // guildId -> { roleIds, fetchedAt }. `roleIds: null` records a FAILED lookup,
  // which is not the same as "no roles" — the visibility filter fails open on it.
  private selfGuildRoles: Map<string, { roleIds: Set<string> | null; fetchedAt: number }> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 30;
  private stopped = false;

  constructor(token: string, tokenIndex = 0) {
    super();
    this.token = token;
    this.tokenIndex = tokenIndex;
  }

  private static readonly NON_RECOVERABLE_CODES = new Set([
    4004,
    4010,
    4011,
    4014,
  ]);

  connect(): void {
    if (this.stopped) return;
    const url = this.resumeGatewayUrl ?? GATEWAY_URL;
    if (this.reconnectAttempts === 0) {
      console.log(`[Gateway] Connecting to ${url}...`);
    }
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      if (this.reconnectAttempts > 0) {
        console.log(`[Gateway] Reconnected (after ${this.reconnectAttempts} attempts)`);
      }
    };

    this.ws.onmessage = (event) => {
      const payload: GatewayPayload = JSON.parse(String(event.data));
      this.handlePayload(payload);
    };

    this.ws.onclose = (event) => {
      this.cleanup();

      if (BrowserDiscordGateway.NON_RECOVERABLE_CODES.has(event.code)) {
        const reasonStr = event.reason || 'Unknown reason';
        console.error(`[Gateway] Fatal close code ${event.code}: ${reasonStr}. Not reconnecting.`);
        this.stopped = true;
        if (event.code === 4004) {
          this.emit('auth_failed', {
            tokenIndex: this.tokenIndex,
            message: 'Authentication failed. This token is invalid or expired — please update it in settings.',
            invalid: true,
          } satisfies GatewayAuthFailure);
        } else {
          this.emit('fatal', new Error(`${reasonStr} (code ${event.code})`));
        }
        return;
      }

      if (this.reconnectAttempts === 0) {
        console.log(`[Gateway] Disconnected: ${event.code} - ${event.reason}`);
      }
      this.attemptReconnect();
    };

    this.ws.onerror = () => {
      console.error('[Gateway] WebSocket error');
    };
  }

  private handlePayload(payload: GatewayPayload): void {
    if (payload.s !== null) {
      this.lastSequence = payload.s;
    }

    switch (payload.op) {
      case GatewayOpcodes.HELLO:
        this.startHeartbeat(payload.d.heartbeat_interval);
        this.identify();
        break;

      case GatewayOpcodes.HEARTBEAT_ACK:
        break;

      case GatewayOpcodes.HEARTBEAT:
        this.sendHeartbeat();
        break;

      case GatewayOpcodes.RECONNECT:
        console.log('[Gateway] Server requested reconnect');
        this.ws?.close();
        break;

      case GatewayOpcodes.INVALID_SESSION:
        console.log('[Gateway] Invalid session, re-identifying...');
        this.sessionId = null;
        setTimeout(() => this.identify(), 1000 + Math.random() * 4000);
        break;

      case GatewayOpcodes.DISPATCH:
        this.handleDispatch(payload.t!, payload.d);
        break;
    }
  }

  private handleDispatch(event: string, data: any): void {
    switch (event) {
      case 'READY':
        this.sessionId = data.session_id;
        this.resumeGatewayUrl = data.resume_gateway_url;
        this.reconnectAttempts = 0;
        this.selfUserId = data.user?.id ?? null;
        console.log(`[Gateway] Ready as ${data.user.username}#${data.user.discriminator}`);

        const readyGuilds: any[] = data.guilds ?? [];
        for (let gi = 0; gi < readyGuilds.length; gi++) {
          const guild = readyGuilds[gi];
          const guildName = guild.properties?.name ?? guild.name ?? 'Unknown';
          const guildIcon = guild.properties?.icon ?? guild.icon ?? null;
          const guildId = guild.id;

          const snapshot = readGuildPermissionSnapshot(guild, this.selfUserId, mergedMembersAt(data, gi));
          this.guilds.set(guildId, {
            id: guildId,
            name: guildName,
            icon: guildIcon,
            ownerId: snapshot.ownerId,
            rolePermissions: snapshot.rolePermissions,
            memberRoleIds: snapshot.memberRoleIds,
            channels: snapshot.channels,
          });

          for (const ch of snapshot.channels) {
            this.channelGuildMap.set(ch.id, guildId);
            if (ch.name) this.channelNameMap.set(ch.id, ch.name);
          }

          for (const role of guild.roles ?? []) {
            const roleId = role.id ?? (Array.isArray(role) ? String(role[0]) : null);
            const roleName = role.name ?? (Array.isArray(role) ? String(role[1] ?? '') : '');
            if (roleId && roleName) this.roleNameMap.set(roleId, roleName);
            if (roleId) {
              this.roleDataMap.set(roleId, {
                name: roleName || '',
                color: role.color ?? 0,
                position: role.position ?? 0,
              });
            }
          }

          console.log(`[Gateway] Guild "${guildName}" - ${snapshot.channels.length} channels`);
        }

        const userLookup = new Map<string, any>();
        for (const u of data.users ?? []) {
          userLookup.set(u.id, u);
        }

        for (const channel of data.private_channels ?? []) {
          let recipients: { id: string; username: string; global_name: string | null; avatar: string | null }[];

          if (Array.isArray(channel.recipients) && channel.recipients.length > 0) {
            recipients = channel.recipients.map((r: any) => ({
              id: r.id ?? '',
              username: r.username ?? r.name ?? '',
              global_name: r.global_name ?? r.display_name ?? null,
              avatar: r.avatar ?? null,
            }));
          } else {
            const ids: string[] = channel.recipient_ids ?? [];
            recipients = ids.map((uid: string) => {
              const u = userLookup.get(uid);
              return {
                id: uid,
                username: u?.username ?? u?.name ?? '',
                global_name: u?.global_name ?? u?.display_name ?? null,
                avatar: u?.avatar ?? null,
              };
            });
          }

          this.dmChannels.set(channel.id, { id: channel.id, recipients });
          const name = recipients
            .map((r) => r.global_name || r.username || 'Unknown')
            .join(', ') || 'DM';
          this.channelNameMap.set(channel.id, name);
        }

        console.log(`[Gateway] Loaded ${this.guilds.size} guilds, ${this.dmChannels.size} DMs`);
        this.emit('ready', data.user);
        break;

      case 'GUILD_CREATE': {
        const snapshot = readGuildPermissionSnapshot(data, this.selfUserId);
        const guildName = data.properties?.name ?? data.name ?? 'Unknown';
        const existing = this.guilds.get(data.id);

        this.guilds.set(data.id, {
          id: data.id,
          name: guildName,
          icon: data.properties?.icon ?? data.icon ?? null,
          ownerId: snapshot.ownerId ?? existing?.ownerId ?? null,
          rolePermissions: snapshot.rolePermissions.size > 0
            ? snapshot.rolePermissions
            : (existing?.rolePermissions ?? new Map()),
          memberRoleIds: snapshot.memberRoleIds ?? existing?.memberRoleIds ?? null,
          channels: snapshot.channels.length > 0 ? snapshot.channels : (existing?.channels ?? []),
        });

        for (const ch of snapshot.channels) {
          this.channelGuildMap.set(ch.id, data.id);
          if (ch.name) this.channelNameMap.set(ch.id, ch.name);
        }

        for (const role of data.roles ?? []) {
          if (role.id && role.name) this.roleNameMap.set(role.id, role.name);
          if (role.id) {
            this.roleDataMap.set(role.id, {
              name: role.name ?? '',
              color: role.color ?? 0,
              position: role.position ?? 0,
            });
          }
        }

        console.log(`[Gateway] GUILD_CREATE "${guildName}" - ${snapshot.channels.length} channels`);
        break;
      }

      case 'MESSAGE_CREATE': {
        const msg = data as DiscordMessage;
        const guildId = msg.guild_id ?? this.channelGuildMap.get(msg.channel_id) ?? null;
        const channelName = this.channelNameMap.get(msg.channel_id) ?? 'unknown';
        const guildName = guildId ? this.guilds.get(guildId)?.name ?? null : null;

        this.emit('message', {
          ...msg,
          guild_id: guildId,
          _channelName: channelName,
          _guildName: guildName,
        });
        break;
      }

      case 'MESSAGE_UPDATE': {
        const msg = data as Partial<DiscordMessage> & { id: string; channel_id: string };
        const guildId = msg.guild_id ?? this.channelGuildMap.get(msg.channel_id) ?? null;
        const channelName = this.channelNameMap.get(msg.channel_id) ?? 'unknown';
        const guildName = guildId ? this.guilds.get(guildId)?.name ?? null : null;

        this.emit('messageUpdate', {
          ...msg,
          guild_id: guildId,
          _channelName: channelName,
          _guildName: guildName,
        });
        break;
      }

      case 'MESSAGE_DELETE': {
        const guildId = data.guild_id ?? this.channelGuildMap.get(data.channel_id) ?? null;
        this.emit('messageDelete', {
          id: data.id,
          channel_id: data.channel_id,
          guild_id: guildId,
        });
        break;
      }

      case 'MESSAGE_DELETE_BULK': {
        const guildId = data.guild_id ?? this.channelGuildMap.get(data.channel_id) ?? null;
        for (const id of (data.ids ?? []) as string[]) {
          this.emit('messageDelete', {
            id,
            channel_id: data.channel_id,
            guild_id: guildId,
          });
        }
        break;
      }

      case 'MESSAGE_REACTION_ADD': {
        this.emit('reactionUpdate', {
          channelId: data.channel_id,
          messageId: data.message_id,
          guildId: data.guild_id ?? null,
          emoji: data.emoji,
          delta: 1,
        });
        break;
      }

      case 'MESSAGE_REACTION_REMOVE': {
        this.emit('reactionUpdate', {
          channelId: data.channel_id,
          messageId: data.message_id,
          guildId: data.guild_id ?? null,
          emoji: data.emoji,
          delta: -1,
        });
        break;
      }

      case 'CHANNEL_CREATE':
      case 'CHANNEL_UPDATE': {
        if (data.guild_id) {
          this.channelGuildMap.set(data.id, data.guild_id);
          if (data.name) this.channelNameMap.set(data.id, data.name);
          const guild = this.guilds.get(data.guild_id);
          if (guild) {
            // Store the raw channel whatever its type — getGuilds() applies the
            // type and visibility filters. CHANNEL_UPDATE is how a channel's
            // overwrites change, so this keeps the picker honest when access is
            // granted or revoked mid-session.
            const idx = guild.channels.findIndex((c) => c.id === data.id);
            const entry = readGuildChannels([data])[0];
            if (entry) {
              if (idx >= 0) guild.channels[idx] = entry;
              else guild.channels.push(entry);
            }
          }
        } else if (data.type === 1 || data.type === 3) {
          const recipients = (data.recipients ?? []).map((r: any) => ({
            id: r.id ?? '',
            username: r.username ?? r.name ?? '',
            global_name: r.global_name ?? r.display_name ?? null,
            avatar: r.avatar ?? null,
          }));
          this.dmChannels.set(data.id, { id: data.id, recipients });
          const name = recipients
            .map((r: any) => r.global_name || r.username || 'Unknown')
            .join(', ') || 'DM';
          this.channelNameMap.set(data.id, name);
        }
        break;
      }
    }
  }

  private identify(): void {
    if (this.sessionId) {
      this.send({
        op: GatewayOpcodes.RESUME,
        d: {
          token: this.token,
          session_id: this.sessionId,
          seq: this.lastSequence,
        },
        s: null,
        t: null,
      });
    } else {
      this.send({
        op: GatewayOpcodes.IDENTIFY,
        d: {
          token: this.token,
          capabilities: 1734653,
          properties: {
            os: 'Windows',
            browser: 'Chrome',
            device: '',
            system_locale: 'en-US',
            browser_user_agent:
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
            browser_version: '133.0.0.0',
            os_version: '10',
            referrer: '',
            referring_domain: '',
            referrer_current: '',
            referring_domain_current: '',
            release_channel: 'stable',
            client_build_number: 366089,
            client_event_source: null,
          },
          presence: {
            status: 'online',
            since: 0,
            activities: [],
            afk: false,
          },
          compress: false,
          client_state: {
            guild_versions: {},
            highest_last_message_id: '0',
            read_state_version: 0,
            user_guild_settings_version: -1,
            user_settings_version: -1,
            private_channels_version: '0',
            api_code_version: 0,
          },
        },
        s: null,
        t: null,
      });
    }
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    this.sendHeartbeat();
    this.heartbeatInterval = setInterval(() => this.sendHeartbeat(), intervalMs);
  }

  private sendHeartbeat(): void {
    this.send({ op: GatewayOpcodes.HEARTBEAT, d: this.lastSequence, s: null, t: null });
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private send(payload: GatewayPayload): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private cleanup(): void {
    this.stopHeartbeat();
  }

  private attemptReconnect(): void {
    if (this.stopped) return;

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.stopped = true;
      console.error(`[Gateway] Max reconnect attempts (${this.maxReconnectAttempts}) reached. Giving up.`);
      this.emit('auth_failed', {
        tokenIndex: this.tokenIndex,
        message: `Could not connect after ${this.maxReconnectAttempts} attempts. The token may be invalid, or Discord may be unreachable — please check it in settings.`,
        invalid: false,
      } satisfies GatewayAuthFailure);
      return;
    }
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30000);
    this.reconnectAttempts++;
    if (this.reconnectAttempts <= 3 || this.reconnectAttempts % 5 === 0) {
      console.log(`[Gateway] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
    }
    setTimeout(() => this.connect(), delay);
  }

  /**
   * Guilds with their channel lists narrowed to what this account may actually
   * pick: a text-capable type, and VIEW_CHANNEL granted.
   *
   * Async because resolving "what roles does this user hold here" can need a
   * REST call — the gateway frames carry the member object only under some
   * client-capability flags. When it cannot be resolved the guild's channels
   * come back type-filtered but unfiltered by permission: an empty picker is a
   * worse outcome than an over-full one.
   */
  async getGuilds(): Promise<GuildInfo[]> {
    const records = Array.from(this.guilds.values());
    const roleSets = await this.resolveMemberRoleIds(records);

    return records.map((guild, i) => {
      const ctx = buildGuildPermissionContext({
        guildId: guild.id,
        userId: this.selfUserId,
        ownerId: guild.ownerId,
        rolePermissions: guild.rolePermissions,
        memberRoleIds: roleSets[i],
      });
      return {
        id: guild.id,
        name: guild.name,
        icon: guild.icon,
        channels: filterPickableChannels(guild.channels, ctx).map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type,
        })),
      };
    });
  }

  // Role ids per guild, from the gateway frame where it had them and REST where
  // it did not. Batched so a large account does not open one request per guild
  // simultaneously.
  private async resolveMemberRoleIds(records: GuildRecord[]): Promise<(Set<string> | null)[]> {
    const out: (Set<string> | null)[] = new Array(records.length).fill(null);
    const pending: number[] = [];

    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (record.memberRoleIds) {
        out[i] = record.memberRoleIds;
        continue;
      }
      // The owner sees everything, so their role list is irrelevant.
      if (record.ownerId && record.ownerId === this.selfUserId) {
        out[i] = new Set();
        continue;
      }
      pending.push(i);
    }

    for (let i = 0; i < pending.length; i += MEMBER_FETCH_CONCURRENCY) {
      const batch = pending.slice(i, i + MEMBER_FETCH_CONCURRENCY);
      await Promise.all(
        batch.map(async (idx) => {
          out[idx] = await this.fetchSelfRoleIds(records[idx].id);
        }),
      );
    }

    return out;
  }

  // `null` means the lookup failed, which callers must not confuse with "holds
  // no roles". Cached (including the failure) so reopening Room Settings does
  // not re-ask Discord.
  private async fetchSelfRoleIds(guildId: string): Promise<Set<string> | null> {
    const cached = this.selfGuildRoles.get(guildId);
    if (cached && Date.now() - cached.fetchedAt < SELF_ROLES_TTL_MS) {
      return cached.roleIds;
    }
    try {
      const res = await fetch(`${REST_BASE}/users/@me/guilds/${guildId}/member`, {
        headers: { Authorization: this.token },
      });
      if (!res.ok) {
        const fallback = cached?.roleIds ?? null;
        this.selfGuildRoles.set(guildId, { roleIds: fallback, fetchedAt: Date.now() });
        return fallback;
      }
      const member = await res.json();
      const roleIds = new Set<string>(Array.isArray(member.roles) ? member.roles : []);
      this.selfGuildRoles.set(guildId, { roleIds, fetchedAt: Date.now() });
      return roleIds;
    } catch {
      const fallback = cached?.roleIds ?? null;
      this.selfGuildRoles.set(guildId, { roleIds: fallback, fetchedAt: Date.now() });
      return fallback;
    }
  }

  getDMChannels(): DMChannel[] {
    return Array.from(this.dmChannels.values());
  }

  getChannelName(channelId: string): string {
    return this.channelNameMap.get(channelId) ?? 'unknown';
  }

  getGuildForChannel(channelId: string): string | null {
    return this.channelGuildMap.get(channelId) ?? null;
  }

  getGuildName(guildId: string): string | null {
    return this.guilds.get(guildId)?.name ?? null;
  }

  getRoleName(roleId: string): string | null {
    return this.roleNameMap.get(roleId) ?? null;
  }

  getMemberRoleColor(roleIds: string[] | undefined): string | null {
    if (!roleIds || roleIds.length === 0) return null;
    let best: { color: number; position: number } | null = null;
    for (const id of roleIds) {
      const rd = this.roleDataMap.get(id);
      if (!rd || rd.color === 0) continue;
      if (!best || rd.position > best.position) {
        best = { color: rd.color, position: rd.position };
      }
    }
    if (!best) return null;
    return `#${best.color.toString(16).padStart(6, '0')}`;
  }

  async sendChannelMessage(
    channelId: string,
    content: string,
    attachments?: { filename: string; data: Blob; contentType: string }[],
  ): Promise<any> {
    if (attachments && attachments.length > 0) {
      const form = new FormData();
      form.append('payload_json', JSON.stringify({ content }));
      for (let i = 0; i < attachments.length; i++) {
        const att = attachments[i];
        form.append(`files[${i}]`, att.data, att.filename);
      }

      const res = await fetch(`${REST_BASE}/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { Authorization: this.token },
        body: form,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Discord API error ${res.status}: ${text}`);
      }
      return res.json();
    }

    const res = await fetch(`${REST_BASE}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: this.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Discord API error ${res.status}: ${text}`);
    }
    return res.json();
  }

  async fetchChannelMessages(channelId: string, limit = 30): Promise<DiscordMessage[]> {
    const url = `${REST_BASE}/channels/${channelId}/messages?limit=${limit}`;
    const res = await fetch(url, {
      headers: { Authorization: this.token },
    });
    if (!res.ok) {
      console.error(`[Gateway] Failed to fetch messages for ${channelId}: ${res.status}`);
      return [];
    }
    const messages: DiscordMessage[] = await res.json();
    return messages.reverse().map((msg) => {
      const guildId = msg.guild_id ?? this.channelGuildMap.get(msg.channel_id) ?? undefined;
      return {
        ...msg,
        guild_id: guildId,
      };
    });
  }

  async fetchReactionUsers(
    channelId: string,
    messageId: string,
    emoji: string,
    limit = 100,
  ): Promise<DiscordUser[]> {
    const url = `${REST_BASE}/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}?limit=${limit}`;
    const res = await fetch(url, {
      headers: { Authorization: this.token },
    });
    if (!res.ok) {
      console.error(`[Gateway] Failed to fetch reaction users for ${messageId}: ${res.status}`);
      return [];
    }
    return res.json();
  }

  disconnect(): void {
    this.stopped = true;
    this.cleanup();
    this.ws?.close();
  }
}
