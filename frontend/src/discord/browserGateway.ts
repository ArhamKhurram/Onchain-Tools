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

const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const REST_BASE = 'https://discord.com/api/v10';

const TEXT_CHANNEL_TYPES = new Set([0, 2, 5, 10, 11, 12, 13, 15, 16]);

function isTextChannel(type: number): boolean {
  return TEXT_CHANNEL_TYPES.has(type);
}

export type { GatewayAuthFailure };

export class BrowserDiscordGateway extends EventEmitter {
  private ws: WebSocket | null = null;
  private token: string;
  private tokenIndex: number;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private lastSequence: number | null = null;
  private sessionId: string | null = null;
  private resumeGatewayUrl: string | null = null;
  private guilds: Map<string, GuildInfo> = new Map();
  private dmChannels: Map<string, DMChannel> = new Map();
  private channelGuildMap: Map<string, string> = new Map();
  private channelNameMap: Map<string, string> = new Map();
  private roleNameMap: Map<string, string> = new Map();
  private roleDataMap: Map<string, { name: string; color: number; position: number }> = new Map();
  private selfUserId: string | null = null;
  private selfGuildRoles: Map<string, { roleIds: Set<string>; fetchedAt: number }> = new Map();
  private static readonly SELF_ROLES_TTL_MS = 10 * 60 * 1000;
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

        for (const guild of data.guilds ?? []) {
          const guildName = guild.properties?.name ?? guild.name ?? 'Unknown';
          const guildIcon = guild.properties?.icon ?? guild.icon ?? null;
          const guildId = guild.id;

          const rawChannels: any[] = guild.channels ?? [];
          const channels = rawChannels
            .filter((c: any) => isTextChannel(c.type ?? c[3]))
            .map((c: any) => {
              if (Array.isArray(c)) {
                return { id: String(c[0]), name: String(c[1] ?? ''), type: Number(c[3] ?? 0) };
              }
              return { id: c.id, name: c.name ?? '', type: c.type ?? 0 };
            });

          this.guilds.set(guildId, { id: guildId, name: guildName, icon: guildIcon, channels });

          for (const ch of rawChannels) {
            const chId = Array.isArray(ch) ? String(ch[0]) : ch.id;
            const chName = Array.isArray(ch) ? String(ch[1] ?? '') : (ch.name ?? '');
            this.channelGuildMap.set(chId, guildId);
            if (chName) this.channelNameMap.set(chId, chName);
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

          console.log(`[Gateway] Guild "${guildName}" - ${channels.length} text channels`);
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
        const rawChannels: any[] = data.channels ?? [];
        const channels = rawChannels
          .filter((c: any) => isTextChannel(c.type))
          .map((c: any) => ({ id: c.id, name: c.name ?? '', type: c.type }));

        const guildName = data.properties?.name ?? data.name ?? 'Unknown';
        const existing = this.guilds.get(data.id);

        this.guilds.set(data.id, {
          id: data.id,
          name: guildName,
          icon: data.properties?.icon ?? data.icon ?? null,
          channels: channels.length > 0 ? channels : (existing?.channels ?? []),
        });

        for (const ch of rawChannels) {
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

        console.log(`[Gateway] GUILD_CREATE "${guildName}" - ${channels.length} text channels`);
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
          if (guild && isTextChannel(data.type)) {
            const idx = guild.channels.findIndex((c) => c.id === data.id);
            const entry = { id: data.id, name: data.name ?? '', type: data.type };
            if (idx >= 0) guild.channels[idx] = entry;
            else guild.channels.push(entry);
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

  getGuilds(): GuildInfo[] {
    return Array.from(this.guilds.values());
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

  getSelfUserId(): string | null {
    return this.selfUserId;
  }

  async getSelfRoleIds(guildId: string): Promise<Set<string>> {
    const cached = this.selfGuildRoles.get(guildId);
    if (cached && Date.now() - cached.fetchedAt < BrowserDiscordGateway.SELF_ROLES_TTL_MS) {
      return cached.roleIds;
    }
    try {
      const res = await fetch(`${REST_BASE}/users/@me/guilds/${guildId}/member`, {
        headers: { Authorization: this.token },
      });
      if (!res.ok) {
        const empty = cached?.roleIds ?? new Set<string>();
        this.selfGuildRoles.set(guildId, { roleIds: empty, fetchedAt: Date.now() });
        return empty;
      }
      const member = await res.json();
      const roleIds = new Set<string>(Array.isArray(member.roles) ? member.roles : []);
      this.selfGuildRoles.set(guildId, { roleIds, fetchedAt: Date.now() });
      return roleIds;
    } catch {
      const empty = cached?.roleIds ?? new Set<string>();
      this.selfGuildRoles.set(guildId, { roleIds: empty, fetchedAt: Date.now() });
      return empty;
    }
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
