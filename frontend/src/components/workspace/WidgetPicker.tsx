import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Plus } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import {
  WORKSPACE_MAX_PANELS,
  WORKSPACE_WIDGETS,
  appendPanelToColumn,
  countPanels,
  defaultAddColumnId,
} from '../../data/workspaceWidgets';
import { AnimatePresence, MotionFeatures, fadeIn, m, useTransition } from '../../lib/motion';
import { cn } from '../../lib/utils';
import type { WorkspaceLayout, WorkspacePanelType } from '../../types/workspace';

interface WidgetPickerProps {
  layout: WorkspaceLayout;
  onChange: (layout: WorkspaceLayout) => void;
  onPickRoom: () => void;
}

export default function WidgetPicker({ layout, onChange, onPickRoom }: WidgetPickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const rooms = useAppStore((s) => s.rooms);
  const panelCount = countPanels(layout);
  const atMax = panelCount >= WORKSPACE_MAX_PANELS;
  // Menu chrome only: it fades on open/close, the items inside never animate.
  const swap = useTransition('fade');

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const handleAdd = (type: WorkspacePanelType) => {
    if (atMax) return;
    setOpen(false);
    const columnId = defaultAddColumnId(layout);
    if (type === 'room') {
      const firstRoom = rooms[0]?.id;
      if (firstRoom) {
        onChange(appendPanelToColumn(layout, columnId, type, { roomId: firstRoom }));
      } else {
        onPickRoom();
      }
      return;
    }
    onChange(appendPanelToColumn(layout, columnId, type));
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={atMax}
        onClick={() => setOpen((v) => !v)}
        // `tabular-nums` on the button itself rather than a span around the
        // count, so the accessible name stays one string ("Add panel (3/6)").
        className="oct-btn-primary inline-flex items-center gap-tight px-cozy py-tight type-label uppercase tracking-wide tabular-nums disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Plus size={14} strokeWidth={2.5} />
        Add panel ({panelCount}/{WORKSPACE_MAX_PANELS})
        <ChevronDown
          size={12}
          className={cn('transition-transform duration-fast', open && 'rotate-180')}
        />
      </button>
      {/* MotionFeatures sits here, on the surface, rather than higher up — the
          toolbar renders on every workspace visit and the runtime should only
          be paid for by the route that animates. */}
      <MotionFeatures>
        <AnimatePresence initial={false}>
          {open && (
            <m.div
              key="widget-menu"
              variants={fadeIn}
              initial="hidden"
              animate="visible"
              exit="hidden"
              transition={swap}
              className="oct-card absolute left-0 top-full mt-snug z-50 min-w-[240px] py-tight overflow-hidden"
            >
              {WORKSPACE_WIDGETS.map((w) => (
                <button
                  key={w.type}
                  type="button"
                  onClick={() => handleAdd(w.type)}
                  className="w-full text-left px-comfy py-snug oct-row-hover"
                >
                  <p className="type-label uppercase text-oct-text">{w.label}</p>
                  <p className="type-caption font-mono text-oct-muted">{w.description}</p>
                </button>
              ))}
            </m.div>
          )}
        </AnimatePresence>
      </MotionFeatures>
    </div>
  );
}
