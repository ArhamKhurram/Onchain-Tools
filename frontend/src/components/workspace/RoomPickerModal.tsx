import { X } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';

interface RoomPickerModalProps {
  open: boolean;
  selectedRoomId?: string;
  onSelect: (roomId: string) => void;
  onClose: () => void;
}

export default function RoomPickerModal({ open, selectedRoomId, onSelect, onClose }: RoomPickerModalProps) {
  const rooms = useAppStore((s) => s.rooms);
  const dmChannels = useAppStore((s) => s.dmChannels);

  if (!open) return null;

  const options: { id: string; label: string }[] = [
    { id: 'mentions', label: 'Mentions' },
    ...rooms.map((r) => ({ id: r.id, label: r.name })),
    ...dmChannels.map((dm) => ({
      id: `dm:${dm.id}`,
      label: dm.recipients.map((r) => r.global_name ?? r.username).join(', ') || 'DM',
    })),
  ];

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70">
      <div className="w-full max-w-md border-2 border-black bg-oct-bg shadow-oct-hard">
        <div className="flex items-center justify-between px-4 py-3 border-b-2 border-black bg-oct-surface">
          <h3 className="text-sm font-extrabold uppercase tracking-wide text-oct-text">Choose room</h3>
          <button type="button" onClick={onClose} className="p-1 text-oct-muted hover:text-oct-text">
            <X size={16} />
          </button>
        </div>
        <ul className="max-h-[50vh] overflow-y-auto divide-y divide-oct-border">
          {options.length === 0 ? (
            <li className="px-4 py-6 text-center text-sm text-oct-muted font-mono">
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
                  className={`w-full text-left px-4 py-2.5 text-sm hover:bg-oct-surface-raised transition-colors ${
                    selectedRoomId === opt.id ? 'text-oct-accent font-bold' : 'text-oct-text'
                  }`}
                >
                  {opt.label}
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
