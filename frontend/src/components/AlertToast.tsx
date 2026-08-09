import { useEffect } from 'react';
import { X } from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import type { ToastPosition } from '../types';
import {
  alertBorderClass,
  alertIcon,
  alertIconClass,
  alertPreview,
  openAlertTarget,
} from '../utils/alertDisplay';

const AUTO_DISMISS_MS = 8000;

const POSITION_STYLES: Record<ToastPosition, string> = {
  'top-left': 'top-4 left-4 items-start',
  'top-center': 'top-4 left-1/2 -translate-x-1/2 items-center',
  'top-right': 'top-4 right-4 items-end',
  'bottom-left': 'bottom-4 left-4 items-start flex-col-reverse',
  'bottom-center': 'bottom-4 left-1/2 -translate-x-1/2 items-center flex-col-reverse',
  'bottom-right': 'bottom-4 right-4 items-end flex-col-reverse',
  center: 'top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 items-center',
};

export default function AlertToast() {
  const alerts = useAppStore((s) => s.alerts);
  const dismissAlert = useAppStore((s) => s.dismissAlert);
  const dismissAllAlerts = useAppStore((s) => s.dismissAllAlerts);
  const config = useAppStore((s) => s.config);
  const enabled = config?.toastAlertsEnabled ?? true;
  const position = config?.toastPosition ?? 'top-right';

  useEffect(() => {
    if (alerts.length === 0) return;
    const latest = alerts[0];
    const showLatest = enabled || latest.type === 'missed_runner';
    if (!showLatest) return;
    const timer = setTimeout(() => dismissAlert(latest.id), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [alerts, dismissAlert, enabled]);

  const visible = alerts.filter((a) => enabled || a.type === 'missed_runner').slice(0, 5);

  if (visible.length === 0) return null;

  return (
    <div
      className={`fixed z-[100] flex flex-col gap-2 w-96 max-w-[calc(100vw-2rem)] pointer-events-none ${POSITION_STYLES[position]}`}
    >
      {visible.length > 1 && (
        <button
          onClick={dismissAllAlerts}
          className="pointer-events-auto flex items-center gap-1.5 px-2.5 py-1 rounded-cockpit border-2 border-black bg-oct-surface-raised text-xs font-bold text-discord-text-muted hover:text-white shadow-oct-hard transition-colors"
        >
          <X size={13} /> Clear all ({visible.length})
        </button>
      )}
      {visible.map((alert) => {
        const Icon = alertIcon(alert.type);
        const handleOpen = alert.message.platformUrl
          ? () => openAlertTarget(alert)
          : undefined;

        return (
        <div
          key={alert.id}
          role={handleOpen ? 'button' : undefined}
          tabIndex={handleOpen ? 0 : undefined}
          onClick={handleOpen}
          onKeyDown={handleOpen ? (e) => { if (e.key === 'Enter' || e.key === ' ') handleOpen(); } : undefined}
          className={`pointer-events-auto flex items-start gap-3 p-3 rounded-cockpit shadow-oct-hard border-2 border-black animate-slide-in bg-oct-surface border-l-[6px] ${alertBorderClass(alert.type)} ${
            alert.type === 'missed_runner' && handleOpen ? 'cursor-pointer hover:bg-oct-surface-raised/80' : ''
          }`}
          style={{
            animation: 'slideIn 0.3s ease-out',
          }}
        >
          <div className="mt-0.5">
            <Icon size={18} className={alertIconClass(alert.type)} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-white">{alert.reason}</p>
            <p className="text-xs text-discord-text-muted truncate mt-0.5">
              {alertPreview(alert) || '\u00A0'}
            </p>
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); dismissAlert(alert.id); }}
            className="text-discord-text-muted hover:text-white shrink-0"
          >
            <X size={16} />
          </button>
        </div>
        );
      })}
    </div>
  );
}
