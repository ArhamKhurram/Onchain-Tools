import { AlertTriangle } from 'lucide-react';
import { useAppStore } from '../stores/appStore';

/**
 * Shown when the console cannot reach its backend at all.
 *
 * This exists because of a real incident: the API origin was missing from the
 * backend's CORS allow-list after a domain move, so every request failed at the
 * browser. The console did not report anything — it simply rendered as if the
 * account were empty. Saved settings looked lost, the Feed asked for a Discord
 * token that was already configured, and Save was permanently disabled because
 * `config` never loaded. Nothing on screen suggested a connectivity problem.
 *
 * A failed fetch and a CORS rejection are indistinguishable from JS, so this
 * deliberately does not guess which one it is — it says the backend is
 * unreachable and names the two usual causes.
 */
export default function BackendUnreachableBanner() {
  const backendReachable = useAppStore((s) => s.backendReachable);

  // null = not attempted yet. Only warn on a definite failure, so the banner
  // never flashes during startup.
  if (backendReachable !== false) return null;

  return (
    <div
      role="alert"
      className="flex items-start gap-3 px-4 py-3 bg-oct-flame text-black border-b-2 border-black"
    >
      <AlertTriangle size={18} className="shrink-0 mt-0.5" />
      <div className="font-mono text-xs leading-relaxed">
        <span className="font-bold uppercase tracking-wider">Backend unreachable.</span>{' '}
        Your settings, rooms and contracts cannot load, and changes cannot be saved.
        Nothing has been lost — the console just cannot reach the API.
        <span className="block mt-1 opacity-80">
          Usually either the API is down, or this origin is missing from the backend&apos;s
          allowed-origins list. Check the browser console for a CORS error.
        </span>
      </div>
    </div>
  );
}
