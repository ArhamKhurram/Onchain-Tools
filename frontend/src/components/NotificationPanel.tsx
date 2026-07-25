import { useEffect, useRef, useState } from 'react';
import { Bell, X } from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import {
  alertBorderClass,
  alertIcon,
  alertIconClass,
  alertPreview,
  alertTimeAgo,
  openAlertTarget,
} from '../utils/alertDisplay';

export default function NotificationPanel() {
  const notificationHistory = useAppStore((s) => s.notificationHistory);
  const unreadNotificationCount = useAppStore((s) => s.unreadNotificationCount);
  const markNotificationsRead = useAppStore((s) => s.markNotificationsRead);
  const clearNotificationHistory = useAppStore((s) => s.clearNotificationHistory);

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    markNotificationsRead();
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open, markNotificationsRead]);

  const toggle = () => setOpen((v) => !v);

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={toggle}
        className={`relative p-1.5 rounded-cockpit border-2 transition-colors ${
          open
            ? 'text-oct-accent border-oct-border-bright bg-oct-surface'
            : 'text-oct-muted border-transparent hover:text-oct-text hover:border-oct-border-bright'
        }`}
        title="Notifications"
        aria-label="Notifications"
        aria-expanded={open}
      >
        <Bell size={16} strokeWidth={2} />
        {unreadNotificationCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-0.5 rounded-full bg-oct-accent text-[9px] font-bold text-white border border-oct-bg flex items-center justify-center">
            {unreadNotificationCount > 9 ? '9+' : unreadNotificationCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 z-[120] w-80 sm:w-96 max-w-[calc(100vw-2rem)] rounded-cockpit border-2 border-black bg-oct-surface shadow-oct-hard overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2.5 border-b-2 border-black">
            <span className="font-mono text-xs font-bold uppercase tracking-widest text-oct-text">
              Notifications
            </span>
            <div className="flex items-center gap-2">
              {notificationHistory.length > 0 && (
                <button
                  type="button"
                  onClick={clearNotificationHistory}
                  className="font-mono text-[10px] uppercase text-oct-muted hover:text-oct-accent transition-colors"
                >
                  Clear all
                </button>
              )}
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="p-0.5 text-oct-muted hover:text-oct-text"
                aria-label="Close"
              >
                <X size={14} />
              </button>
            </div>
          </div>

          <div className="max-h-[min(420px,60vh)] overflow-y-auto">
            {notificationHistory.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 px-4 text-center">
                <Bell size={28} className="text-oct-muted/40 mb-2" strokeWidth={1.5} />
                <p className="font-mono text-xs uppercase tracking-wide text-oct-muted">No notifications</p>
                <p className="text-[11px] text-oct-muted/80 mt-1">
                  Contract scans, highlights, and keyword hits appear here.
                </p>
              </div>
            ) : (
              <ul>
                {notificationHistory.map((alert) => {
                  const Icon = alertIcon(alert.type);
                  const preview = alertPreview(alert);
                  const clickable = Boolean(alert.message.platformUrl);

                  return (
                    <li key={alert.id} className="border-b border-oct-border/60 last:border-b-0">
                      <button
                        type="button"
                        onClick={() => openAlertTarget(alert)}
                        disabled={!clickable}
                        className={`w-full flex items-start gap-2.5 px-3 py-2.5 text-left transition-colors border-l-[4px] ${alertBorderClass(alert.type)} ${
                          clickable ? 'hover:bg-oct-surface-raised/60 cursor-pointer' : 'cursor-default'
                        }`}
                      >
                        <Icon size={16} className={`shrink-0 mt-0.5 ${alertIconClass(alert.type)}`} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-sm font-medium text-oct-text leading-snug">{alert.reason}</p>
                            <span className="text-[10px] font-mono text-oct-muted shrink-0 tabular-nums">
                              {alertTimeAgo(alert.timestamp)}
                            </span>
                          </div>
                          {preview && (
                            <p className="text-xs text-oct-muted truncate mt-0.5">{preview}</p>
                          )}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
