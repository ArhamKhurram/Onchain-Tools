// "N picks not live — j7 slot cap reached": the compact notice that makes the
// roster cap visible. Collapsed it is one line; expanded it names every pick of
// the user's that is not being watched, with a follower count so the ranking
// (most-followed first, see backend j7/rosterPlan.ts) is legible.
//
// The list is the INTERSECTION of the user's roster with the global dropped
// set, not the whole dropped set — the user needs to know which of THEIR picks
// are dark, and the global tail is noise to them. Renders nothing when that
// intersection is empty, so the tab's layout is untouched in the common case.
//
// No motion: the notice sits above a roster that re-renders on every follow /
// unfollow, and an expand transition here would animate on each of those.

import { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { DroppedLookup, DroppedTracker } from '../../lib/droppedRoster';
import { droppedAmong, normDroppedKey } from '../../lib/droppedRoster';

export interface DroppedNoticeItem {
  /** The roster key — wallet (pump) or handle (fomo). */
  key: string;
  /** What to print for it; falls back to the key. */
  label?: string | null;
}

export default function DroppedRosterNotice({
  dropped,
  tracker,
  items,
  className,
}: {
  dropped: DroppedLookup;
  tracker: DroppedTracker;
  /** The user's own roster, in display order. */
  items: readonly DroppedNoticeItem[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const notLive = droppedAmong(dropped, tracker, items, (i) => i.key);
  if (notLive.length === 0) return null;

  const noun = tracker === 'pump' ? 'caller' : 'trader';
  const n = notLive.length;

  return (
    <div
      className={cn(
        'rounded-oct border border-oct-warn/40 bg-oct-warn-dim text-oct-text',
        className,
      )}
      role="status"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-snug px-comfy py-cozy text-left"
      >
        <AlertTriangle size={14} className="shrink-0 text-oct-warn" />
        <span className="type-label text-xs text-oct-text">
          <span className="type-data font-bold text-oct-warn">{n}</span> {n === 1 ? 'pick' : 'picks'} not live
          <span className="text-oct-muted"> — j7 slot cap reached</span>
        </span>
        <span className="flex-1" />
        <span className="type-caption text-2xs text-oct-muted">{open ? 'hide' : 'show'}</span>
        {open ? (
          <ChevronDown size={14} className="shrink-0 text-oct-muted" />
        ) : (
          <ChevronRight size={14} className="shrink-0 text-oct-muted" />
        )}
      </button>
      {open && (
        <div className="border-t border-oct-warn/30 px-comfy py-cozy">
          <p className="type-caption text-2xs text-oct-muted mb-snug">
            Every j7 {noun} slot is taken. Slots go to the most-followed {noun}s first, so these are not being
            watched — their calls will not arrive until a slot frees or another j7 account is added.
          </p>
          <ul className="space-y-hair">
            {notLive.map((item) => {
              const target = dropped[tracker].get(normDroppedKey(item.key));
              return (
                <li key={item.key} className="flex items-center gap-cozy">
                  <span className="type-body text-xs text-oct-text truncate" title={item.key}>
                    {item.label || item.key}
                  </span>
                  <span className="flex-1" />
                  {target && (
                    <span className="type-data text-2xs text-oct-muted whitespace-nowrap">
                      {target.followerCount} {target.followerCount === 1 ? 'follower' : 'followers'}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
