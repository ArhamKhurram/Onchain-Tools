// The OCT-side seam for Slotshark's own Twitter triggers — UNIMPLEMENTED, and
// deliberately so.
//
// TODO(unverified): the trigger CRUD path(s), the request/response shape, and
// whether any fire notification comes back to OCT at all. The only Slotshark
// endpoint this codebase knows is POST /buy (executors/slotshark.ts:66); /sell
// and /wallets/withdraw are named in docs only as blast-radius facts. Today's
// evidence says trade notifications route through Slotshark's own Telegram bot
// (ADR-012:26-28) — i.e. out of band, never to us. Do not guess an endpoint
// here; the alpha points the operator at Slotshark's dashboard instead.
//
// This matters more than a normal stub because the alpha's HEADLINE mechanism
// runs through it: the tweet -> buy loop lives inside Slotshark, configured in
// the operator's Slotshark account, and OCT is never told when it fires. That
// is why the console carries a permanent notice saying so, and why none of
// OCT's caps bind an automatic buy. The moment this interface has a verified
// implementation, that notice has to change with it.
//
// The shape below is chosen to match SlotsharkExecutor's constraints so an
// implementation slots in without redesign: same REGION_BASE_URLS enum, same
// bearer header, same never-log-the-token rule.

import type { SlotsharkRegion } from './slotshark.js';

/** What a Slotshark-side Twitter trigger would look like to OCT. Shape unverified. */
export interface SlotsharkTriggerSpec {
  handle: string;
  mint: string;
  /** Native-unit spend, as Slotshark denominates it. */
  amount: number;
  walletAddress: string;
}

export interface SlotsharkTrigger extends SlotsharkTriggerSpec {
  id: string;
}

export interface SlotsharkTriggers {
  list(): Promise<SlotsharkTrigger[]>;
  create(spec: SlotsharkTriggerSpec): Promise<SlotsharkTrigger>;
  remove(id: string): Promise<boolean>;
}

export interface SlotsharkTriggersConfig {
  apiToken: string;
  region: SlotsharkRegion;
}

const UNVERIFIED =
  'Slotshark trigger configuration is not proxied through OCT: no trigger endpoint is ' +
  'verifiable from this repo. Configure triggers in Slotshark’s own dashboard.';

/**
 * The only implementation that ships. Every method throws, loudly and with the
 * same message the console shows, so a future caller cannot mistake silence for
 * success. It is exported from the barrel and called by nothing.
 */
export class NotImplementedSlotsharkTriggers implements SlotsharkTriggers {
  constructor(_cfg?: SlotsharkTriggersConfig) {}

  async list(): Promise<SlotsharkTrigger[]> {
    throw new Error(UNVERIFIED);
  }
  async create(_spec: SlotsharkTriggerSpec): Promise<SlotsharkTrigger> {
    throw new Error(UNVERIFIED);
  }
  async remove(_id: string): Promise<boolean> {
    throw new Error(UNVERIFIED);
  }
}

export const SLOTSHARK_TRIGGERS_UNVERIFIED = UNVERIFIED;
