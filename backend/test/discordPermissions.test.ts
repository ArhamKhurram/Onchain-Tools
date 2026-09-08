import { describe, it, expect } from 'vitest';
import {
  PERMISSION_ADMINISTRATOR,
  PERMISSION_VIEW_CHANNEL,
  buildGuildPermissionContext,
  canViewChannel,
  computeBasePermissions,
  filterPickableChannels,
  isFeedChannelType,
  readGuildChannels,
  readGuildPermissionSnapshot,
  readSelfMemberRoleIds,
  toBits,
  type GuildMemberPermissionContext,
  type PermissionOverwrite,
} from '@oct/shared';

// A user reported that OCT's Room Settings picker listed channels their Discord
// client hides — including a per-user support ticket channel and a moderation
// log — and proved it with an alt account: a channel only the alt could see was
// still offered to the main account's picker. Discord hands a user token every
// channel in a guild and expects the client to compute visibility; these tests
// pin that computation, in both directions. Over-filtering (a user who can't
// find a channel they legitimately have) would be a worse bug than the leak, so
// the allow cases below are as load-bearing as the deny ones.

const GUILD = '100';
const SELF = '999';
const STAFF_ROLE = '200';
const MEMBER_ROLE = '201';

/** Baseline: @everyone can view, nobody has anything special. */
function ctx(overrides: Partial<GuildMemberPermissionContext> = {}): GuildMemberPermissionContext {
  return {
    guildId: GUILD,
    userId: SELF,
    ownerId: null,
    rolePermissions: new Map([[GUILD, PERMISSION_VIEW_CHANNEL]]),
    memberRoleIds: new Set<string>(),
    ...overrides,
  };
}

function roleOverwrite(id: string, allow: bigint, deny: bigint): PermissionOverwrite {
  return { id, type: 0, allow: allow.toString(), deny: deny.toString() };
}

function memberOverwrite(id: string, allow: bigint, deny: bigint): PermissionOverwrite {
  return { id, type: 1, allow: allow.toString(), deny: deny.toString() };
}

function channel(overwrites: PermissionOverwrite[] | null, type = 0) {
  return { id: 'c1', name: 'support-gravityswimmer-688', type, overwrites };
}

describe('canViewChannel — allow cases (must not over-filter)', () => {
  it('shows a channel with no overwrites at all', () => {
    expect(canViewChannel({ ...channel([]), overwrites: [] }, ctx())).toBe(true);
  });

  it('shows a channel whose overwrites do not touch VIEW_CHANNEL', () => {
    const SEND_MESSAGES = 1n << 11n;
    const ch = { ...channel([roleOverwrite(GUILD, 0n, SEND_MESSAGES)]), overwrites: [roleOverwrite(GUILD, 0n, SEND_MESSAGES)] };
    expect(canViewChannel(ch, ctx())).toBe(true);
  });

  it('shows a channel the @everyone role denies but one of the member roles allows', () => {
    const overwrites = [
      roleOverwrite(GUILD, 0n, PERMISSION_VIEW_CHANNEL),
      roleOverwrite(STAFF_ROLE, PERMISSION_VIEW_CHANNEL, 0n),
    ];
    const staff = ctx({ memberRoleIds: new Set([STAFF_ROLE]) });
    expect(canViewChannel({ ...channel(overwrites), overwrites }, staff)).toBe(true);
  });

  it('lets one role allow beat another role deny — allows are applied after every deny', () => {
    const overwrites = [
      roleOverwrite(MEMBER_ROLE, 0n, PERMISSION_VIEW_CHANNEL),
      roleOverwrite(STAFF_ROLE, PERMISSION_VIEW_CHANNEL, 0n),
    ];
    const both = ctx({ memberRoleIds: new Set([MEMBER_ROLE, STAFF_ROLE]) });
    expect(canViewChannel({ ...channel(overwrites), overwrites }, both)).toBe(true);
  });

  it('shows a channel a role denies when a member-specific overwrite allows it', () => {
    const overwrites = [
      roleOverwrite(GUILD, 0n, PERMISSION_VIEW_CHANNEL),
      roleOverwrite(STAFF_ROLE, 0n, PERMISSION_VIEW_CHANNEL),
      memberOverwrite(SELF, PERMISSION_VIEW_CHANNEL, 0n),
    ];
    const staff = ctx({ memberRoleIds: new Set([STAFF_ROLE]) });
    expect(canViewChannel({ ...channel(overwrites), overwrites }, staff)).toBe(true);
  });

  it('grants everything to a member holding ADMINISTRATOR, whatever the overwrites say', () => {
    const overwrites = [
      roleOverwrite(GUILD, 0n, PERMISSION_VIEW_CHANNEL),
      roleOverwrite(STAFF_ROLE, 0n, PERMISSION_VIEW_CHANNEL),
      memberOverwrite(SELF, 0n, PERMISSION_VIEW_CHANNEL),
    ];
    const admin = ctx({
      rolePermissions: new Map([
        [GUILD, 0n],
        [STAFF_ROLE, PERMISSION_ADMINISTRATOR],
      ]),
      memberRoleIds: new Set([STAFF_ROLE]),
    });
    expect(canViewChannel({ ...channel(overwrites), overwrites }, admin)).toBe(true);
  });

  it('grants everything to the guild owner even with no roles and no base permissions', () => {
    const overwrites = [roleOverwrite(GUILD, 0n, PERMISSION_VIEW_CHANNEL)];
    const owner = ctx({ ownerId: SELF, rolePermissions: new Map([[GUILD, 0n]]) });
    expect(canViewChannel({ ...channel(overwrites), overwrites }, owner)).toBe(true);
  });
});

describe('canViewChannel — deny cases (the reported leak)', () => {
  it('hides a channel @everyone is denied and the member has no granting role', () => {
    const overwrites = [
      roleOverwrite(GUILD, 0n, PERMISSION_VIEW_CHANNEL),
      roleOverwrite(STAFF_ROLE, PERMISSION_VIEW_CHANNEL, 0n),
    ];
    expect(canViewChannel({ ...channel(overwrites), overwrites }, ctx())).toBe(false);
  });

  it('hides a channel denied to a role the member holds, with nothing granting it back', () => {
    const overwrites = [roleOverwrite(MEMBER_ROLE, 0n, PERMISSION_VIEW_CHANNEL)];
    const member = ctx({ memberRoleIds: new Set([MEMBER_ROLE]) });
    expect(canViewChannel({ ...channel(overwrites), overwrites }, member)).toBe(false);
  });

  it('lets a member-specific deny override a role allow', () => {
    const overwrites = [
      roleOverwrite(GUILD, 0n, PERMISSION_VIEW_CHANNEL),
      roleOverwrite(STAFF_ROLE, PERMISSION_VIEW_CHANNEL, 0n),
      memberOverwrite(SELF, 0n, PERMISSION_VIEW_CHANNEL),
    ];
    const staff = ctx({ memberRoleIds: new Set([STAFF_ROLE]) });
    expect(canViewChannel({ ...channel(overwrites), overwrites }, staff)).toBe(false);
  });

  it('ignores a role overwrite for a role the member does not hold', () => {
    const overwrites = [
      roleOverwrite(GUILD, 0n, PERMISSION_VIEW_CHANNEL),
      roleOverwrite(STAFF_ROLE, PERMISSION_VIEW_CHANNEL, 0n),
    ];
    const other = ctx({ memberRoleIds: new Set([MEMBER_ROLE]) });
    expect(canViewChannel({ ...channel(overwrites), overwrites }, other)).toBe(false);
  });
});

describe('canViewChannel — category-derived overwrites', () => {
  // Discord does NOT consult the parent category when computing permissions.
  // A channel "synced" to its category carries a COPY of the category's
  // overwrites, so a locked category reaches this function as the channel's own
  // deny; a channel that overrides the sync carries its own allow alongside it.
  // Implementing real inheritance would wrongly hide unsynced channels created
  // inside a locked category with an empty overwrite list.
  const categoryDeny = roleOverwrite(GUILD, 0n, PERMISSION_VIEW_CHANNEL);

  it('hides a channel that inherited a locked category by sync', () => {
    const overwrites = [categoryDeny];
    expect(canViewChannel({ ...channel(overwrites), overwrites }, ctx())).toBe(false);
  });

  it('shows a synced-then-overridden channel that adds its own role allow', () => {
    const overwrites = [categoryDeny, roleOverwrite(STAFF_ROLE, PERMISSION_VIEW_CHANNEL, 0n)];
    const staff = ctx({ memberRoleIds: new Set([STAFF_ROLE]) });
    expect(canViewChannel({ ...channel(overwrites), overwrites }, staff)).toBe(true);
  });

  it('shows an unsynced channel inside a locked category — empty overwrites means unrestricted', () => {
    expect(canViewChannel({ ...channel([]), overwrites: [] }, ctx())).toBe(true);
  });
});

describe('computeBasePermissions', () => {
  it('ORs @everyone with the member roles', () => {
    const SEND = 1n << 11n;
    const base = computeBasePermissions(
      ctx({
        rolePermissions: new Map([
          [GUILD, PERMISSION_VIEW_CHANNEL],
          [STAFF_ROLE, SEND],
        ]),
        memberRoleIds: new Set([STAFF_ROLE]),
      }),
    );
    expect(base & PERMISSION_VIEW_CHANNEL).toBe(PERMISSION_VIEW_CHANNEL);
    expect(base & SEND).toBe(SEND);
  });

  it('ignores role ids with no known permission bitfield', () => {
    const base = computeBasePermissions(ctx({ memberRoleIds: new Set(['role-we-never-saw']) }));
    expect(base).toBe(PERMISSION_VIEW_CHANNEL);
  });
});

describe('toBits', () => {
  it('reads Discord decimal strings, numbers and bigints', () => {
    expect(toBits('1024')).toBe(1024n);
    expect(toBits(1024)).toBe(1024n);
    expect(toBits(1024n)).toBe(1024n);
  });

  it('reads a bitfield too large for a JS number', () => {
    expect(toBits('562949953421311')).toBe(562949953421311n);
  });

  it('contributes nothing for missing or malformed values — a bad parse must not read as a deny', () => {
    expect(toBits(undefined)).toBe(0n);
    expect(toBits(null)).toBe(0n);
    expect(toBits('')).toBe(0n);
    expect(toBits('not-a-number')).toBe(0n);
  });
});

describe('isFeedChannelType', () => {
  it('offers text, announcement, thread, forum and media channels', () => {
    for (const type of [0, 5, 10, 11, 12, 15, 16]) {
      expect(isFeedChannelType(type)).toBe(true);
    }
  });

  it('drops categories, voice and stage channels', () => {
    // 4 = category (a header, never a message source); 2/13 = voice and stage,
    // reported as picker clutter and not somewhere calls get posted.
    for (const type of [2, 4, 13]) {
      expect(isFeedChannelType(type)).toBe(false);
    }
  });
});

describe('buildGuildPermissionContext — refuses to decide on incomplete data', () => {
  const complete = {
    guildId: GUILD,
    userId: SELF as string | null,
    ownerId: null,
    rolePermissions: new Map([[GUILD, PERMISSION_VIEW_CHANNEL]]),
    memberRoleIds: new Set<string>() as ReadonlySet<string> | null,
  };

  it('builds a context when everything is present', () => {
    expect(buildGuildPermissionContext(complete)).not.toBeNull();
  });

  it('returns null when the signed-in user is unknown', () => {
    expect(buildGuildPermissionContext({ ...complete, userId: null })).toBeNull();
  });

  it('returns null when the member roles are unresolved', () => {
    expect(buildGuildPermissionContext({ ...complete, memberRoleIds: null })).toBeNull();
  });

  it('returns null when @everyone is missing — the base of the whole calculation', () => {
    // Without it every channel would resolve to "denied" and the picker would
    // come back empty, which is a worse failure than showing too much.
    expect(buildGuildPermissionContext({ ...complete, rolePermissions: new Map() })).toBeNull();
    expect(
      buildGuildPermissionContext({ ...complete, rolePermissions: new Map([[STAFF_ROLE, 0n]]) }),
    ).toBeNull();
  });
});

describe('filterPickableChannels', () => {
  const hidden = { id: 'hidden', name: 'new-member-logs', type: 0, overwrites: [roleOverwrite(GUILD, 0n, PERMISSION_VIEW_CHANNEL)] };
  const visible = { id: 'visible', name: 'alpha-calls', type: 0, overwrites: [] as PermissionOverwrite[] };
  const voice = { id: 'voice', name: 'General VC', type: 2, overwrites: [] as PermissionOverwrite[] };
  const unknown = { id: 'unknown', name: 'compact-form', type: 0, overwrites: null };

  it('keeps only viewable, feed-capable channels', () => {
    const picked = filterPickableChannels([hidden, visible, voice], ctx());
    expect(picked.map((c) => c.id)).toEqual(['visible']);
  });

  it('fails open when the member roles could not be resolved — type filter only', () => {
    const picked = filterPickableChannels([hidden, visible, voice], null);
    expect(picked.map((c) => c.id)).toEqual(['hidden', 'visible']);
  });

  it('fails open for a single channel whose payload carried no overwrite list', () => {
    const picked = filterPickableChannels([hidden, unknown], ctx());
    expect(picked.map((c) => c.id)).toEqual(['unknown']);
  });
});

describe('readGuildChannels', () => {
  it('reads object-form channels with their overwrites', () => {
    const [ch] = readGuildChannels([
      {
        id: '1',
        name: 'alpha',
        type: 0,
        permission_overwrites: [{ id: GUILD, type: 0, allow: '0', deny: '1024' }],
      },
    ]);
    expect(ch).toEqual({
      id: '1',
      name: 'alpha',
      type: 0,
      overwrites: [{ id: GUILD, type: 0, allow: '0', deny: '1024' }],
    });
  });

  it('reads the positional array form with overwrites unknown, not empty', () => {
    // An empty list would read as "unrestricted" and silently defeat the filter;
    // null routes the channel to the fail-open branch instead.
    const [ch] = readGuildChannels([['1', 'alpha', 0, 5]]);
    expect(ch.id).toBe('1');
    expect(ch.type).toBe(5);
    expect(ch.overwrites).toBeNull();
  });

  it('accepts the legacy string overwrite types', () => {
    const [ch] = readGuildChannels([
      { id: '1', type: 0, permission_overwrites: [{ id: SELF, type: 'member', allow: '1024', deny: '0' }] },
    ]);
    expect(ch.overwrites?.[0].type).toBe(1);
  });
});

describe('readGuildPermissionSnapshot — unreadable role data', () => {
  it('omits a role that carried no permissions field rather than recording it as zero', () => {
    // A zero would be indistinguishable from a permission-less role; on
    // @everyone that difference decides whether the picker filters or fails open.
    const snapshot = readGuildPermissionSnapshot(
      { id: GUILD, roles: [{ id: GUILD, name: '@everyone' }], channels: [] },
      SELF,
      [{ user_id: SELF, roles: [] }],
    );
    expect(snapshot.rolePermissions.has(GUILD)).toBe(false);
    expect(
      buildGuildPermissionContext({
        guildId: GUILD,
        userId: SELF,
        ownerId: snapshot.ownerId,
        rolePermissions: snapshot.rolePermissions,
        memberRoleIds: snapshot.memberRoleIds,
      }),
    ).toBeNull();
  });
});

describe('readSelfMemberRoleIds', () => {
  it('finds the member object embedded in the guild', () => {
    const roles = readSelfMemberRoleIds({ members: [{ user_id: SELF, roles: [STAFF_ROLE] }] }, SELF);
    expect(roles).toEqual(new Set([STAFF_ROLE]));
  });

  it('finds it in READY merged_members, where user tokens usually put it', () => {
    const roles = readSelfMemberRoleIds({}, SELF, [{ user_id: SELF, roles: [MEMBER_ROLE] }]);
    expect(roles).toEqual(new Set([MEMBER_ROLE]));
  });

  it('matches on a nested user object too', () => {
    const roles = readSelfMemberRoleIds({ members: [{ user: { id: SELF }, roles: [] }] }, SELF);
    expect(roles).toEqual(new Set());
  });

  it('returns null — not an empty set — when the member object is absent', () => {
    expect(readSelfMemberRoleIds({ members: [{ user_id: 'someone-else', roles: ['x'] }] }, SELF)).toBeNull();
    expect(readSelfMemberRoleIds({}, SELF)).toBeNull();
    expect(readSelfMemberRoleIds({ members: [{ user_id: SELF, roles: [MEMBER_ROLE] }] }, null)).toBeNull();
  });
});

describe('readGuildPermissionSnapshot — end to end on a user-token READY guild', () => {
  const guild = {
    id: GUILD,
    properties: { name: 'Some Server', icon: null, owner_id: '1' },
    roles: [
      { id: GUILD, name: '@everyone', permissions: PERMISSION_VIEW_CHANNEL.toString() },
      { id: STAFF_ROLE, name: 'staff', permissions: '0' },
    ],
    channels: [
      { id: 'public', name: 'alpha-calls', type: 0, permission_overwrites: [] },
      {
        id: 'ticket',
        name: 'support-gravityswimmer-688',
        type: 0,
        permission_overwrites: [
          { id: GUILD, type: 0, allow: '0', deny: PERMISSION_VIEW_CHANNEL.toString() },
          { id: STAFF_ROLE, type: 0, allow: PERMISSION_VIEW_CHANNEL.toString(), deny: '0' },
        ],
      },
      { id: 'vc', name: 'General VC', type: 2, permission_overwrites: [] },
      { id: 'cat', name: 'TICKETS', type: 4, permission_overwrites: [] },
    ],
  };

  it('hides the ticket channel from a plain member, keeps the public one, drops voice and categories', () => {
    const snapshot = readGuildPermissionSnapshot(guild, SELF, [{ user_id: SELF, roles: [] }]);
    expect(snapshot.ownerId).toBe('1');
    expect(snapshot.memberRoleIds).toEqual(new Set());

    const picked = filterPickableChannels(snapshot.channels, {
      guildId: GUILD,
      userId: SELF,
      ownerId: snapshot.ownerId,
      rolePermissions: snapshot.rolePermissions,
      memberRoleIds: snapshot.memberRoleIds!,
    });
    expect(picked.map((c) => c.id)).toEqual(['public']);
  });

  it('keeps the ticket channel for staff — the picker must not hide what the user can read', () => {
    const snapshot = readGuildPermissionSnapshot(guild, SELF, [{ user_id: SELF, roles: [STAFF_ROLE] }]);
    const picked = filterPickableChannels(snapshot.channels, {
      guildId: GUILD,
      userId: SELF,
      ownerId: snapshot.ownerId,
      rolePermissions: snapshot.rolePermissions,
      memberRoleIds: snapshot.memberRoleIds!,
    });
    expect(picked.map((c) => c.id)).toEqual(['public', 'ticket']);
  });
});
