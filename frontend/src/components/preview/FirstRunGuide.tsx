import { Check, Plus, ArrowRight } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';

// Shown the moment a real token connects but no room exists yet — so the first
// post-connect screen isn't blank. It confirms the hard step is done and points
// straight at the one action that makes the feed fire (create a room from the
// servers the user already belongs to). This is the scoped-down guided first-run:
// a full starter-template builder needs the user's real guild/channel list, so
// the honest next step is "pick from your servers," which the room config does.
export default function FirstRunGuide() {
  const openConfigModal = useAppStore((s) => s.openConfigModal);

  const steps: Array<{ label: string; done: boolean }> = [
    { label: 'Sign in to OCT', done: true },
    { label: 'Connect Discord', done: true },
    { label: 'Create your first room', done: false },
  ];

  return (
    <div className="flex-1 flex items-center justify-center bg-oct-surface-raised p-6">
      <div className="max-w-md w-full oct-card p-6">
        <p className="oct-eyebrow tracking-[0.2em] mb-3">[ Almost there ]</p>
        <h2 className="font-display text-2xl text-oct-text tracking-tight mb-2">
          Discord connected.
        </h2>
        <p className="text-sm text-oct-muted leading-relaxed mb-5">
          One step left. Create a room and add channels from the servers you&apos;re already in — calls
          from those channels stream here the moment they drop.
        </p>

        <ol className="space-y-2.5 mb-6">
          {steps.map((s) => (
            <li key={s.label} className="flex items-center gap-3">
              <span
                className={`flex items-center justify-center w-5 h-5 rounded-full border text-[11px] ${
                  s.done
                    ? 'bg-oct-accent border-oct-accent text-white'
                    : 'border-oct-border text-oct-muted'
                }`}
              >
                {s.done ? <Check size={12} strokeWidth={3} /> : ''}
              </span>
              <span className={`text-sm ${s.done ? 'text-oct-muted line-through' : 'text-oct-text font-medium'}`}>
                {s.label}
              </span>
            </li>
          ))}
        </ol>

        <button
          type="button"
          onClick={() => openConfigModal()}
          className="brutal-btn w-full py-2.5 text-sm"
        >
          <Plus size={16} />
          Create your first room
          <ArrowRight size={16} />
        </button>
      </div>
    </div>
  );
}
