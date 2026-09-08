// Reading permission-relevant fields out of a Discord gateway guild payload.
//
// Shared because BOTH gateways build the channel picker's list from the same
// frames — `backend/src/discord/gateway.ts` in local mode, and
// `frontend/src/discord/browserGateway.ts` in hosted mode, where the token
// never reaches the server. They were already near-copies of each other; the
// visibility filter is the last thing that should be allowed to drift between
// them, so the parsing lives here and both call it.
//
// User tokens are the awkward part. Their READY frame does not match the
// documented bot shape:
//  - guild fields hide under `properties` (name, icon, owner_id)
//  - a channel can arrive as an object OR as a positional array, in which case
//    permission overwrites are simply absent
//  - the member object for the signed-in user shows up in `guild.members`, or
//    in a top-level `merged_members` array indexed alongside `guilds`, or not
//    at all (Discord's client-capability flags decide which)
// Every one of those is handled by "read what's there, return null when it
// isn't" — a null propagates to the filter as fail-open, never as a guess.

import { toBits, type PermissionOverwrite } from './discordPermissions.js';

/** A guild channel as far as the picker cares. `overwrites: null` = not in the payload. */
export interface RawGuildChannel {
  id: string;
  name: string;
  type: number;
  overwrites: PermissionOverwrite[] | null;
}

export interface GuildPermissionSnapshot {
  ownerId: string | null;
  /** Role id → permission bitfield. `@everyone`'s id is the guild id. */
  rolePermissions: Map<string, bigint>;
  /**
   * Role ids held by the signed-in user, or null when the payload did not carry
   * their member object. Null means "unresolved", never "no roles".
   */
  memberRoleIds: Set<string> | null;
  channels: RawGuildChannel[];
}

function readOverwrites(raw: unknown): PermissionOverwrite[] | null {
  if (!Array.isArray(raw)) return null;
  const out: PermissionOverwrite[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const o = entry as Record<string, unknown>;
    if (typeof o.id !== 'string') continue;
    out.push({
      id: o.id,
      // Discord has sent `type` as a number for years, but user-token payloads
      // have historically also used the strings "role"/"member".
      type: typeof o.type === 'number' ? o.type : o.type === 'member' ? 1 : 0,
      allow: (o.allow as string | number | undefined) ?? 0,
      deny: (o.deny as string | number | undefined) ?? 0,
    });
  }
  return out;
}

/** Channels arrive as objects, or as positional arrays with no overwrite data. */
export function readGuildChannels(rawChannels: unknown): RawGuildChannel[] {
  if (!Array.isArray(rawChannels)) return [];
  const out: RawGuildChannel[] = [];
  for (const raw of rawChannels) {
    if (Array.isArray(raw)) {
      out.push({
        id: String(raw[0]),
        name: String(raw[1] ?? ''),
        type: Number(raw[3] ?? 0),
        overwrites: null,
      });
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    const c = raw as Record<string, unknown>;
    if (typeof c.id !== 'string') continue;
    out.push({
      id: c.id,
      name: typeof c.name === 'string' ? c.name : '',
      type: typeof c.type === 'number' ? c.type : 0,
      overwrites: readOverwrites(c.permission_overwrites),
    });
  }
  return out;
}

function readRolePermissions(rawRoles: unknown): Map<string, bigint> {
  const map = new Map<string, bigint>();
  if (!Array.isArray(rawRoles)) return map;
  for (const raw of rawRoles) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== 'string') continue;
    // A role whose payload carries no `permissions` field is LEFT OUT rather
    // than recorded as zero. Recording it as zero would be indistinguishable
    // from a genuinely permission-less role, and if that happened to @everyone
    // the base permissions would come out empty and the filter would hide every
    // channel in the guild. Absence is what buildGuildPermissionContext checks.
    if (r.permissions === undefined || r.permissions === null) continue;
    map.set(r.id, toBits(r.permissions as string | number));
  }
  return map;
}

function roleIdsFromMember(raw: unknown, selfUserId: string): Set<string> | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const user = m.user as Record<string, unknown> | undefined;
  const memberUserId = typeof m.user_id === 'string' ? m.user_id : typeof user?.id === 'string' ? user.id : null;
  if (memberUserId !== selfUserId) return null;
  if (!Array.isArray(m.roles)) return null;
  return new Set(m.roles.filter((r): r is string => typeof r === 'string'));
}

/**
 * The signed-in user's role ids for one guild, from whichever shape the frame
 * used. `mergedMembersForGuild` is `merged_members[i]` — the slice of READY's
 * top-level array that lines up with `guilds[i]`.
 */
export function readSelfMemberRoleIds(
  guild: Record<string, unknown>,
  selfUserId: string | null,
  mergedMembersForGuild?: unknown,
): Set<string> | null {
  if (!selfUserId) return null;

  for (const source of [guild.members, mergedMembersForGuild]) {
    if (!Array.isArray(source)) continue;
    for (const entry of source) {
      const roles = roleIdsFromMember(entry, selfUserId);
      if (roles) return roles;
    }
  }

  // GUILD_CREATE for a user token puts the joining member here.
  return roleIdsFromMember(guild.member, selfUserId);
}

/** Everything the visibility filter needs from one guild frame. */
export function readGuildPermissionSnapshot(
  guild: Record<string, unknown>,
  selfUserId: string | null,
  mergedMembersForGuild?: unknown,
): GuildPermissionSnapshot {
  const properties = (guild.properties as Record<string, unknown> | undefined) ?? {};
  const ownerId =
    (typeof properties.owner_id === 'string' ? properties.owner_id : null) ??
    (typeof guild.owner_id === 'string' ? guild.owner_id : null);

  return {
    ownerId,
    rolePermissions: readRolePermissions(guild.roles),
    memberRoleIds: readSelfMemberRoleIds(guild, selfUserId, mergedMembersForGuild),
    channels: readGuildChannels(guild.channels),
  };
}

/** READY's `merged_members[i]`, aligned with `guilds[i]`. Absent → undefined. */
export function mergedMembersAt(readyData: Record<string, unknown>, index: number): unknown {
  const merged = readyData.merged_members;
  if (!Array.isArray(merged)) return undefined;
  return merged[index];
}
