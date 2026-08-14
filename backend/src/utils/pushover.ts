import type { PushoverConfig } from '../discord/types.js';

const PUSHOVER_URL = 'https://api.pushover.net/1/messages.json';

interface PushoverMessage {
  title: string;
  message: string;
  url?: string;
  urlTitle?: string;
  /**
   * Per-message priority override. Only the revival alert path uses this (it
   * always sends emergency priority 2); every other caller inherits the user's
   * configured priority.
   */
  priority?: number;
  /** Emergency re-alert cadence in seconds (priority 2 only). */
  retry?: number;
  /** Emergency alert lifetime in seconds (priority 2 only). */
  expire?: number;
}

export async function sendPushover(config: PushoverConfig, msg: PushoverMessage): Promise<void> {
  if (!config.enabled || !config.appToken || !config.userKey) return;

  try {
    const priority = msg.priority ?? config.priority ?? 1;
    const body: Record<string, string | number> = {
      token: config.appToken,
      user: config.userKey,
      title: msg.title,
      message: msg.message,
      priority,
      sound: config.sound ?? 'siren',
    };
    // Emergency priority requires retry/expire params
    if (priority === 2) {
      body.retry = msg.retry ?? 60;
      body.expire = msg.expire ?? 600;
    }
    if (msg.url) body.url = msg.url;
    if (msg.urlTitle) body.url_title = msg.urlTitle;

    const res = await fetch(PUSHOVER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[Pushover] HTTP ${res.status}: ${text}`);
    }
  } catch (err) {
    console.error('[Pushover] Failed to send notification:', err);
  }
}
