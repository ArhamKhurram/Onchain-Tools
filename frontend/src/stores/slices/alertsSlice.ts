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

const _initialNotificationHistory = loadNotificationHistory();
const _initialNotificationsLastReadAt = loadNotificationsLastReadAt();

export interface AlertsSlice {
  alerts: Alert[];
  notificationHistory: Alert[];
  notificationsLastReadAt: number;
  unreadNotificationCount: number;

  addAlert: (alert: Alert) => void;
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
