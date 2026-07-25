export type RadarColumnId =
  | 'mentions'
  | 'callers'
  | 'fomo'
  | 'groups'
  | 'windowMentions'
  | 'recent'
  | 'mcAtCall'
  | 'mcNow'
  | 'mult'
  | 'firstCaller';

export const RADAR_COLUMN_ORDER: RadarColumnId[] = [
  'mentions',
  'callers',
  'groups',
  'fomo',
  'windowMentions',
  'recent',
  'mcAtCall',
  'mcNow',
  'mult',
  'firstCaller',
];

export const RADAR_COLUMN_LABELS: Record<RadarColumnId, string> = {
  mentions: 'Mentions',
  callers: 'Callers',
  groups: 'Groups',
  fomo: 'FOMO',
  windowMentions: 'Window mentions',
  recent: 'Latest',
  mcAtCall: 'MC@call',
  mcNow: 'MC now',
  mult: '×',
  firstCaller: 'First caller',
};

const STORAGE_KEY = 'oct.radar.visibleColumns';

/** Default: hide FOMO + first caller to save space. */
export const DEFAULT_VISIBLE_COLUMNS: RadarColumnId[] = [
  'mentions',
  'callers',
  'groups',
  'windowMentions',
  'recent',
  'mcAtCall',
  'mcNow',
  'mult',
];

export function loadVisibleRadarColumns(): Set<RadarColumnId> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set(DEFAULT_VISIBLE_COLUMNS);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set(DEFAULT_VISIBLE_COLUMNS);
    const valid = parsed.filter((id): id is RadarColumnId =>
      RADAR_COLUMN_ORDER.includes(id as RadarColumnId),
    );
    return valid.length > 0 ? new Set(valid) : new Set(DEFAULT_VISIBLE_COLUMNS);
  } catch {
    return new Set(DEFAULT_VISIBLE_COLUMNS);
  }
}

export function saveVisibleRadarColumns(cols: Set<RadarColumnId>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...cols]));
}
