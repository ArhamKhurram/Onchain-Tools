import { X } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import {
  AnimatePresence,
  MotionFeatures,
  fadeIn,
  fadeInUp,
  m,
  useTransition,
} from '../../lib/motion';
import { cn } from '../../lib/utils';

interface RoomPickerModalProps {
  open: boolean;
  selectedRoomId?: string;
  onSelect: (roomId: string) => void;
  onClose: () => void;
}

export default function RoomPickerModal({ open, selectedRoomId, onSelect, onClose }: RoomPickerModalProps) {
  const rooms = useAppStore((s) => s.rooms);
  const dmChannels = useAppStore((s) => s.dmChannels);
  // Backdrop fades, card rises — the two standard modal motions. Both collapse
  // to instant under reduced motion via the hook.
  const backdrop = useTransition('fade');
  const enter = useTransition('snappy');

  const options: { id: string; label: string }[] = [
    { id: 'mentions', label: 'Mentions' },
    ...rooms.map((r) => ({ id: r.id, label: r.name })),
    ...dmChannels.map((dm) => ({
      id: `dm:${dm.id}`,
      label: dm.recipients.map((r) => r.global_name ?? r.username).join(', ') || 'DM',
    })),
  ];

  // The wrapper is always mounted so AnimatePresence can see the child leave;
  // `open` gates the child, not the component, which is why the early return
  // that used to live here is gone.
  return (
    <MotionFeatures>
      <AnimatePresence>
        {open && (
          <m.div
            key="room-picker"
            variants={fadeIn}
            initial="hidden"
            animate="visible"
            exit="hidden"
            transition={backdrop}
            className="fixed inset-0 z-[100] flex items-center justify-center p-roomy bg-black/70"
          >
            <m.div
              variants={fadeInUp}
              transition={enter}
              className="w-full max-w-md oct-card oct-card-flush shadow-oct-soft-lg overflow-hidden"
            >
              <div className="oct-headerbar flex items-center justify-between px-comfy py-cozy">
                <h3 className="type-title uppercase tracking-wide text-oct-text">Choose room</h3>
                <button type="button" onClick={onClose} className="oct-icon-btn p-tight">
                  <X size={16} />
                </button>
              </div>
              <ul className="max-h-[50vh] overflow-y-auto divide-y divide-oct-border/60">
                {options.length === 0 ? (
                  <li className="px-comfy py-section text-center type-body font-mono text-oct-muted">
                    No rooms configured — add rooms in Settings first
                  </li>
                ) : (
                  options.map((opt) => (
                    <li key={opt.id}>
                      <button
                        type="button"
                        onClick={() => {
                          onSelect(opt.id);
                          onClose();
                        }}
                        // The selected row is an ACTIVE state, which is what the
                        // accent is for.
                        className={cn(
                          'w-full text-left px-comfy py-cozy type-body oct-row-hover',
                          selectedRoomId === opt.id ? 'text-oct-accent font-bold' : 'text-oct-text',
                        )}
                      >
                        {opt.label}
                      </button>
                    </li>
                  ))
                )}
              </ul>
            </m.div>
          </m.div>
        )}
      </AnimatePresence>
    </MotionFeatures>
  );
}
