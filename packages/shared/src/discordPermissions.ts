// Effective Discord channel permissions — the filter behind the Room Settings
// channel picker.
//
// Why this exists: Discord's gateway hands a user token EVERY channel in a
// guild, permission overwrites included, and leaves it to the client to decide
// which ones that user may actually see. The official client computes effective
// permissions and hides the rest; OCT rendered the raw list, so the picker
// listed channels the signed-in user has no VIEW_CHANNEL for. Names alone leak:
// `support-<username>-688` says a named person has an open ticket, and
// `new-member-logs` maps a server's moderation plumbing. (Message CONTENT never
// leaked — every read OCT makes carries the user's own token, so Discord itself
// refuses the fetch — but enumeration is still disclosure.)
//
// The algorithm is Discord's documented one, in order:
//   1. base = @everyone role permissions, OR'd with the member's other roles
//   2. ADMINISTRATOR (or guild ownership) short-circuits to "everything"
//   3. apply the channel's @everyone overwrite (deny, then allow)
//   4. apply the UNION of the member's role overwrites (all denies, then all allows)
//   5. apply the member-specific overwrite (deny, then allow)
// Deliberately absent: any walk up to the parent category. Discord does not
// inherit at compute time — when a channel is "synced" to its category the
// category's overwrites are COPIED onto the channel, so they arrive here as the
// channel's own. A channel created with an empty overwrite list inside a locked
// category really is visible, and inheriting would wrongly hide it.
//
// This module is pure and fully specified: callers must supply the member's
// role ids. That is on purpose — a caller that cannot resolve them must fail
// OPEN (show the channel) rather than pass an empty set, which would hide every
// channel the user reaches through a role. Breaking the picker is a worse bug
// than the one this fixes.

/** `1 << 3` — grants every permission, everywhere in the guild. */
export const PERMISSION_ADMINISTRATOR = 1n << 3n;
/** `1 << 10` — the bit that decides whether a channel exists for a user at all. */
export const PERMISSION_VIEW_CHANNEL = 1n << 10n;

/** Overwrite `type` values, as sent by Discord. */
export const OVERWRITE_TYPE_ROLE = 0;
export const OVERWRITE_TYPE_MEMBER = 1;

/**
 * Channel types the picker offers. A room is a text feed, so the list is
 * "things that can carry messages OCT could render":
 *   0  GUILD_TEXT          — the ordinary case
 *   5  GUILD_ANNOUNCEMENT  — news channels; call-heavy servers use these
 *   10 ANNOUNCEMENT_THREAD
 *   11 PUBLIC_THREAD
 *   12 PRIVATE_THREAD      — threads carry messages like any text channel
 *   15 GUILD_FORUM
 *   16 GUILD_MEDIA         — forum/media containers, kept for continuity
 *
 * Excluded on purpose:
 *   4  GUILD_CATEGORY — a grouping header, never a message source (already excluded)
 *   2  GUILD_VOICE / 13 GUILD_STAGE_VOICE — a user reported these cluttering the
 *      picker, and they are noise here. Modern voice channels do have an attached
 *      text chat, so this is a judgement call rather than an impossibility: voice
 *      chat is ephemeral, scoped to whoever is in the call, and nobody posts
 *      contract addresses there. Someone who genuinely wants one back should ask
 *      — a wrong extra row in every server's list is the bigger cost today.
 */
export const FEED_CHANNEL_TYPES: ReadonlySet<number> = new Set([0, 5, 10, 11, 12, 15, 16]);

export function isFeedChannelType(type: number): boolean {
  return FEED_CHANNEL_TYPES.has(type);
}

/** One entry of a channel's `permission_overwrites`. */
export interface PermissionOverwrite {
  /** Role id (type 0) or user id (type 1). */
  id: string;
  type: number;
  /** Bitfields, sent by Discord as decimal strings. */
  allow: string | number | bigint;
  deny: string | number | bigint;
}

/** Everything about a guild + member needed to resolve one channel. */
export interface GuildMemberPermissionContext {
  guildId: string;
  /** The signed-in user's id — matched against member-specific overwrites. */
  userId: string;
  /** Guild owner id, if known. The owner bypasses every overwrite. */
  ownerId?: string | null;
  /**
   * Guild role id → that role's permission bitfield. The `@everyone` role's id
   * is the guild id; a missing entry contributes nothing.
   */
  rolePermissions: ReadonlyMap<string, bigint>;
  /** Role ids the member holds, excluding `@everyone` (added implicitly). */
  memberRoleIds: ReadonlySet<string>;
}

/** The parts of a channel that bear on visibility. */
export interface ChannelPermissionInput {
  id: string;
  type: number;
  overwrites: readonly PermissionOverwrite[];
}

/** Discord sends bitfields as decimal strings; tolerate numbers too. */
export function toBits(value: string | number | bigint | null | undefined): bigint {
  if (value === null || value === undefined) return 0n;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  const trimmed = value.trim();
  if (!trimmed) return 0n;
  try {
    return BigInt(trimmed);
  } catch {
    // A malformed bitfield must not read as "deny everything" — a bad parse
    // would silently hide channels. Contribute nothing instead.
    return 0n;
  }
}

/**
 * Step 1–2: guild-wide permissions for the member, before any channel overwrite.
 * Returns all bits set when the member is the owner or holds ADMINISTRATOR.
 */
export function computeBasePermissions(ctx: GuildMemberPermissionContext): bigint {
  if (ctx.ownerId && ctx.ownerId === ctx.userId) return ~0n;

  // The @everyone role is keyed by the guild id — every member has it.
  let permissions = ctx.rolePermissions.get(ctx.guildId) ?? 0n;
  for (const roleId of ctx.memberRoleIds) {
    permissions |= ctx.rolePermissions.get(roleId) ?? 0n;
  }

  if ((permissions & PERMISSION_ADMINISTRATOR) === PERMISSION_ADMINISTRATOR) return ~0n;
  return permissions;
}

/**
 * Steps 3–5: fold a channel's overwrites into already-computed base permissions.
 *
 * Note the ordering inside the role pass: EVERY deny is collected, then EVERY
 * allow, and the allows are applied last. That is why one role granting view
 * beats another role denying it.
 */
export function computeChannelPermissions(
  basePermissions: bigint,
  channel: ChannelPermissionInput,
  ctx: GuildMemberPermissionContext,
): bigint {
  // Administrator grants everything and no channel overwrite can claw it back.
  // The reporter's own caveat — "if they have admin perms, they can see what is
  // in the channel" — is this rule, and it is correct behaviour, not the bug.
  if ((basePermissions & PERMISSION_ADMINISTRATOR) === PERMISSION_ADMINISTRATOR) return ~0n;

  let permissions = basePermissions;

  const everyone = channel.overwrites.find(
    (o) => o.type === OVERWRITE_TYPE_ROLE && o.id === ctx.guildId,
  );
  if (everyone) {
    permissions &= ~toBits(everyone.deny);
    permissions |= toBits(everyone.allow);
  }

  let roleAllow = 0n;
  let roleDeny = 0n;
  for (const overwrite of channel.overwrites) {
    if (overwrite.type !== OVERWRITE_TYPE_ROLE) continue;
    if (overwrite.id === ctx.guildId) continue;
    if (!ctx.memberRoleIds.has(overwrite.id)) continue;
    roleAllow |= toBits(overwrite.allow);
    roleDeny |= toBits(overwrite.deny);
  }
  permissions &= ~roleDeny;
  permissions |= roleAllow;

  const member = channel.overwrites.find(
    (o) => o.type === OVERWRITE_TYPE_MEMBER && o.id === ctx.userId,
  );
  if (member) {
    permissions &= ~toBits(member.deny);
    permissions |= toBits(member.allow);
  }

  return permissions;
}

/** Can this member see the channel exists? */
export function canViewChannel(
  channel: ChannelPermissionInput,
  ctx: GuildMemberPermissionContext,
): boolean {
  const base = computeBasePermissions(ctx);
  const effective = computeChannelPermissions(base, channel, ctx);
  return (effective & PERMISSION_VIEW_CHANNEL) === PERMISSION_VIEW_CHANNEL;
}

/**
 * Assemble a context only when every input the computation depends on is
 * genuinely present, and return null otherwise so the caller fails open.
 *
 * The `@everyone` check is the important one. Its permissions are the entire
 * base of the calculation, and Discord keys it by the guild id; if the gateway
 * frame delivered roles in a shape the parser could not read, the map comes
 * back without that entry and a naive computation would resolve every channel
 * in the guild to "no VIEW_CHANNEL" and empty the picker. Missing @everyone
 * means "cannot decide", never "denied".
 */
export function buildGuildPermissionContext(input: {
  guildId: string;
  userId: string | null;
  ownerId: string | null;
  rolePermissions: ReadonlyMap<string, bigint>;
  memberRoleIds: ReadonlySet<string> | null;
}): GuildMemberPermissionContext | null {
  if (!input.userId) return null;
  if (!input.memberRoleIds) return null;
  if (!input.rolePermissions.has(input.guildId)) return null;
  return {
    guildId: input.guildId,
    userId: input.userId,
    ownerId: input.ownerId,
    rolePermissions: input.rolePermissions,
    memberRoleIds: input.memberRoleIds,
  };
}

/**
 * Filter a guild's channels down to what the picker may offer: a text-capable
 * type the member can actually view.
 *
 * Two nullable inputs, both meaning "we don't know" and both failing OPEN:
 *  - `ctx === null` — the member's roles could not be resolved for this guild.
 *  - `channel.overwrites === null` — the payload gave no overwrite list (the
 *    gateway's compact array channel form omits it), so nothing can be decided
 *    about that one channel.
 * Hiding on missing data would empty the picker for anyone whose access is
 * granted by a role, which is a worse failure than the leak this closes.
 */
export function filterPickableChannels<
  T extends { id: string; type: number; overwrites: readonly PermissionOverwrite[] | null },
>(channels: readonly T[], ctx: GuildMemberPermissionContext | null): T[] {
  const typed = channels.filter((c) => isFeedChannelType(c.type));
  if (!ctx) return typed;
  return typed.filter((c) => c.overwrites === null || canViewChannel({ ...c, overwrites: c.overwrites }, ctx));
}
