import type { StateCreator } from 'zustand';
import type { Alert } from '../../types';
import type { AppState } from '../appStore';
import {
  MAX_ALERTS,
  MAX_NOTIFICATION_HISTORY,
  loadNotificationHistory,
  persistNotificationHistory,
  loadNotificationsLastReadAt,
  persistNotificationsLastReadAt,
  countUnreadNotifications,
} from '../appStore.helpers';
import { dedupeContractAlert, type ContractAlertSeen } from '../../utils/alertDedupe';

const _initialNotificationHistory = loadNotificationHistory();
const _initialNotificationsLastReadAt = loadNotificationsLastReadAt();

// Session-only, deliberately outside the store: this is transient bookkeeping,
// not state anything renders or persists.
let _contractAlertSeen: ContractAlertSeen = {};

export interface AlertsSlice {
  alerts: Alert[];
  notificationHistory: Alert[];
  notificationsLastReadAt: number;
  unreadNotificationCount: number;

  /** False when the alert was dropped as a duplicate contract scan. */
  addAlert: (alert: Alert) => boolean;
  dismissAlert: (alertId: string) => void;
  markNotificationsRead: () => void;
  clearNotificationHistory: () => void;
}

export const createAlertsSlice: StateCreator<AppState, [], [], AlertsSlice> = (set) => ({
  alerts: [],
  notificationHistory: _initialNotificationHistory,
  notificationsLastReadAt: _initialNotificationsLastReadAt,
  unreadNotificationCount: countUnreadNotifications(_initialNotificationHistory, _initialNotificationsLastReadAt),

  addAlert: (alert) => {
    // The same call arrives twice within moments — once from the caller's bare
    // address, once from the scanner bot's embed reply (and, before the two
    // transports were made exclusive, potentially from both). One toast.
    const { duplicate, seen } = dedupeContractAlert(alert, _contractAlertSeen, Date.now());
    _contractAlertSeen = seen;
    if (duplicate) return false;

    set((state) => {
      const updated = [alert, ...state.alerts];
      if (updated.length > MAX_ALERTS) updated.length = MAX_ALERTS;
      const history = [
        alert,
        ...state.notificationHistory.filter((a) => a.id !== alert.id),
      ].slice(0, MAX_NOTIFICATION_HISTORY);
      persistNotificationHistory(history);
      return {
        alerts: updated,
        notificationHistory: history,
        unreadNotificationCount: countUnreadNotifications(history, state.notificationsLastReadAt),
      };
    });
    return true;
  },

  dismissAlert: (alertId) => {
    set((state) => ({
      alerts: state.alerts.filter((a) => a.id !== alertId),
    }));
  },

  markNotificationsRead: () => {
    set((state) => {
      const now = Date.now();
      persistNotificationsLastReadAt(now);
      return { notificationsLastReadAt: now, unreadNotificationCount: 0 };
    });
  },

  clearNotificationHistory: () => {
    persistNotificationHistory([]);
    const now = Date.now();
    persistNotificationsLastReadAt(now);
    set({
      notificationHistory: [],
      notificationsLastReadAt: now,
      unreadNotificationCount: 0,
    });
  },
});
