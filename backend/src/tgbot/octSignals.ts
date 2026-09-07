// "OCT Alerts": algorithm-scan signals from operator-configured source channels,
// forwarded through the bot to its subscribers in realtime.
//
// WHITE-LABEL. What reaches a chat is an OCT card attributed to "OCT Alerts ·
// SOL/EVM" — the CHAIN the signal came from, never the upstream that produced
// it. The upstream is named NOWHERE: not here, not in the alert-type key
// (`octSignals`), not in the card, not in an env var. Where a source channel
// has to be named it is named by CHAIN/ROLE ("sol source", "evm source"), and
// the operator supplies the actual channel IDs (and any upstream branding to
// strip) purely through env — so the vendor string lives only in the
// deployment's configuration, never in this repository.
//
// WHY BY ID, NOT BY TITLE. The two source channels' titles are user-editable
// and share a prefix, so a title match is both fragile and would have to encode
// the vendor word. Channel IDs are stable and exact. The operator lists them,
// per chain, in env — the same `-100…` ids the existing Telegram source config
// shows for those channels.
//
// PURE. No I/O beyond reading process.env (the convention every sibling in this
// directory follows — see source.ts, guard.ts, digest.ts), so the whole
// recognise-and-shape step is a unit test rather than a running bot.

import { detectContractAddresses } from '../utils/contract.js';

/** Which source a signal came from. Drives the card's "· SOL"/"· EVM" label. */
export type OctSignalChain = 'sol' | 'evm';

/**
 * One forwarded signal, reduced to what the card and the fan-out need.
 *
 * `text` is UNTRUSTED third-party content and is escaped at render, never here.
 * `addresses` are extracted by the shared detector, so they are already
 * narrowed to real SOL/EVM shapes.
 */
export interface OctSignalView {
  /** The source channel's role — the label chain, not necessarily the address's. */
  chain: OctSignalChain;
  /** URL-routing hint for buildRevivalContractUrl / the quick-buy keyboard. */
  network: string;
  /** Contract addresses found in the message (may be empty — text still forwards). */
  addresses: string[];
  /** The scan body, with any upstream signature stripped. Escaped at render. */
  text: string;
}

/** Env names for the SOL source channel id list, primary first. */
const SOL_SOURCE_ENV = ['OCT_SIGNAL_SOURCE_CHANNEL_IDS_SOL', 'TG_BOT_SIGNAL_SOURCE_CHANNEL_IDS_SOL'] as const;
/** Env names for the EVM source channel id list, primary first. */
const EVM_SOURCE_ENV = ['OCT_SIGNAL_SOURCE_CHANNEL_IDS_EVM', 'TG_BOT_SIGNAL_SOURCE_CHANNEL_IDS_EVM'] as const;
/**
 * Env names for the substrings to strip from a forwarded body. The operator
 * puts the upstream's own signature/branding here; it is the ONLY place that
 * string is allowed to exist, and it never enters the codebase.
 */
const STRIP_TERMS_ENV = ['OCT_SIGNAL_STRIP_TERMS', 'TG_BOT_SIGNAL_STRIP_TERMS'] as const;

function readEnvList(names: readonly string[]): string[] {
  for (const name of names) {
    const raw = process.env[name]?.trim();
    if (raw) return raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
  }
  return [];
}

/**
 * Canonical digit-core of a Telegram chat id, so `-1001234567890`, its bare
 * `1234567890`, and a `-100…:topicId` form all compare equal — while two
 * DIFFERENT channels that merely share a prefix stay distinct (this is an exact
 * comparison of the full id's digits, never a prefix test).
 */
function canonicalChannelId(id: string): string {
  return id
    .trim()
    .replace(/:.*/, '') // drop any :topicId suffix
    .replace(/^-100/, '') // supergroup/channel peer prefix
    .replace(/^-/, ''); // basic-group prefix
}

/** The configured id sets, per chain, canonicalised for exact comparison. */
function readSignalSources(): { sol: Set<string>; evm: Set<string> } {
  return {
    sol: new Set(readEnvList(SOL_SOURCE_ENV).map(canonicalChannelId)),
    evm: new Set(readEnvList(EVM_SOURCE_ENV).map(canonicalChannelId)),
  };
}

/** Whether the bot has any signal source configured at all. */
export function hasSignalSources(): boolean {
  const { sol, evm } = readSignalSources();
  return sol.size > 0 || evm.size > 0;
}

/**
 * The chain a message from `chatId` counts as, or null when the channel is not
 * a configured signal source. Read fresh so a restart-free env change applies,
 * exactly like readGuardLimits / readDefaultAlertSource.
 */
export function resolveOctSignalChain(chatId: string): OctSignalChain | null {
  const key = canonicalChannelId(chatId);
  if (key === '') return null;
  const { sol, evm } = readSignalSources();
  if (sol.has(key)) return 'sol';
  if (evm.has(key)) return 'evm';
  return null;
}

/** The operator-configured strip substrings (never a hardcoded vendor word). */
export function readSignalStripTerms(): string[] {
  return readEnvList(STRIP_TERMS_ENV);
}

/**
 * A line that reads as an upstream signature/footer rather than scan content:
 * a bare handle, a bare link, or a promotional call-to-action. Contract
 * addresses are extracted independently of the body, so stripping such a line
 * can never cost the CA.
 */
function isSignatureLine(line: string): boolean {
  if (/^@[\w]{3,}$/.test(line)) return true;
  if (/^(?:https?:\/\/\S+|t\.me\/\S+)$/i.test(line)) return true;
  if (/^(?:powered by|sponsored by|brought to you by|via|join|subscribe|follow)\b/i.test(line)) return true;
  // A dash-led line is only a signature when it ALSO carries a promo marker, so
  // an em-dashed sentence of real content survives.
  if (/^[—–-]{1,3}\s*\S/.test(line) && /(?:powered|sponsor|via|join|subscribe|follow|t\.me\/|@)/i.test(line)) {
    return true;
  }
  return false;
}

/**
 * Remove upstream branding from a forwarded body: any line containing an
 * operator-configured strip term, and any line shaped like a signature/footer.
 * Blank runs are collapsed. The substantive scan text — and every contract
 * address, which is extracted separately — is preserved.
 */
export function stripUpstreamSignature(text: string, needles: string[]): string {
  const lc = needles.map((n) => n.trim().toLowerCase()).filter((n) => n !== '');
  const kept = text.split(/\r?\n/).filter((raw) => {
    const line = raw.trim();
    if (line === '') return true;
    const low = line.toLowerCase();
    if (lc.some((n) => low.includes(n))) return false;
    return !isSignatureLine(line);
  });
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Recognise a message from a configured signal source and shape it for the
 * fan-out, or null when the channel is not a source (or nothing is left to
 * forward). No side effects — the caller decides whether to deliver.
 */
export function buildOctSignalView(input: {
  chatId: string;
  text: string;
  evmChainHint?: string | null;
}): OctSignalView | null {
  const chain = resolveOctSignalChain(input.chatId);
  if (!chain) return null;

  const raw = input.text ?? '';
  const addresses = detectContractAddresses(raw).addresses;
  const text = stripUpstreamSignature(raw, readSignalStripTerms());

  // A message with neither an address nor any body left is not worth a ping.
  if (addresses.length === 0 && text === '') return null;

  const network = chain === 'sol' ? 'solana' : (input.evmChainHint?.trim() || 'evm');
  return { chain, network, addresses, text };
}
