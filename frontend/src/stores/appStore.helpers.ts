import type { Room, FrontendMessage, Alert, ContractEntry } from '../types';
import { isHostedMode, getAccessToken } from '../lib/supabase';
import { mergeContractEntries } from '../utils/contractMetadata';

export const API_BASE = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL}/api`
  : '/api';
export const MAX_MESSAGES_PER_ROOM = 1000;
export const MAX_ALERTS = 50;
export const MAX_NOTIFICATION_HISTORY = 10;
export const NOTIFICATION_HISTORY_KEY = 'oct.notificationHistory';
export const NOTIFICATIONS_LAST_READ_KEY = 'oct.notificationsLastReadAt';
export const MAX_CONTRACTS = 2000;
export const MAX_PANES = 4;

function contractKey(c: ContractEntry): string {
  return `${c.messageId}:${c.address.toLowerCase()}`;
}

export function loadNotificationHistory(): Alert[] {
  try {
    const raw = localStorage.getItem(NOTIFICATION_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, MAX_NOTIFICATION_HISTORY) : [];
  } catch {
    return [];
  }
}

export function persistNotificationHistory(history: Alert[]): void {
  try {
    localStorage.setItem(NOTIFICATION_HISTORY_KEY, JSON.stringify(history.slice(0, MAX_NOTIFICATION_HISTORY)));
  } catch {
    // ignore quota errors
  }
}

export function loadNotificationsLastReadAt(): number {
  try {
    const raw = localStorage.getItem(NOTIFICATIONS_LAST_READ_KEY);
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export function persistNotificationsLastReadAt(ts: number): void {
  try {
    localStorage.setItem(NOTIFICATIONS_LAST_READ_KEY, String(ts));
  } catch {
    // ignore
  }
}

export function countUnreadNotifications(history: Alert[], lastReadAt: number): number {
  return history.filter((a) => a.timestamp > lastReadAt).length;
}

/** Keep in-memory detections when a refetch returns fewer rows (client gateway mode). */
export function mergeContractLists(local: ContractEntry[], server: ContractEntry[]): ContractEntry[] {
  const map = new Map<string, ContractEntry>();
  for (const c of local) map.set(contractKey(c), c);
  for (const c of server) {
    const key = contractKey(c);
    const existing = map.get(key);
    map.set(key, existing ? mergeContractEntries(existing, c) : c);
  }
  return [...map.values()]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, MAX_CONTRACTS);
}

export function deriveAddressChains(contracts: ContractEntry[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const c of contracts) {
    if (c.chain === 'evm' && c.evmChain) map[c.address.toLowerCase()] = c.evmChain;
  }
  return map;
}

const PANE_STORAGE_KEY = 'oct.paneRoomIds';

// A popout window shares the main window's origin (and therefore its
// localStorage). It must never write the shared layout keys or persist layout
// to the backend, or it would clobber the main window's saved split layout.
export const IS_POPOUT = (() => {
  try {
    return new URLSearchParams(window.location.search).get('popout') === '1';
  } catch {
    return false;
  }
})();

export function loadPaneRoomIds(): string[] {
  try {
    const raw = localStorage.getItem(PANE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string').slice(0, MAX_PANES);
  } catch {}
  return [];
}

export function savePaneRoomIds(ids: string[]): void {
  if (IS_POPOUT) return;
  try { localStorage.setItem(PANE_STORAGE_KEY, JSON.stringify(ids)); } catch {}
}

export const EDIT_MODE_STORAGE_KEY = 'oct.layoutEditMode';
export const GRID_MIRROR_STORAGE_KEY = 'oct.gridMirror';

export function loadLayoutEditMode(): boolean {
  try { return localStorage.getItem(EDIT_MODE_STORAGE_KEY) === '1'; } catch { return false; }
}

export function loadGridMirror(): boolean {
  try { return localStorage.getItem(GRID_MIRROR_STORAGE_KEY) === '1'; } catch { return false; }
}

// Picks a room/DM/mentions key to fill a new pane slot, avoiding the ones
// already shown when possible, falling back to duplicates.
export function pickPaneFill(state: { rooms: Room[]; messages: Record<string, FrontendMessage[]> }, taken: string[]): string {
  const takenSet = new Set(taken);
  for (const r of state.rooms) if (!takenSet.has(r.id)) return r.id;
  for (const key of Object.keys(state.messages)) {
    if ((key.startsWith('dm:') || key.startsWith('tg-dm:')) && (state.messages[key]?.length ?? 0) > 0 && !takenSet.has(key)) {
      return key;
    }
  }
  if (!takenSet.has('mentions')) return 'mentions';
  return taken[0] ?? state.rooms[0]?.id ?? 'mentions';
}

export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (isHostedMode) {
    const token = await getAccessToken();
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }
  }
  return fetch(input, { ...init, headers });
}
