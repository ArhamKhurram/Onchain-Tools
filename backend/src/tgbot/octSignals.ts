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
// per chain, in env — the same ids the existing Telegram source config shows.
//
// WHY THE TOPIC IS PART OF THE ID. The two algorithm feeds are two forum-TOPICS
// of ONE supergroup, addressed `-100…:topicId` (e.g. `-1003705845819:3` for SOL,
// `:4` for EVM — the `telegramChannelId` shape from telegram/messageProcessor).
// The supergroup's peer id is identical for both; only the topic tells them
// apart. So the match is on the FULL composite id INCLUDING the topic. Dropping
// the topic (as an earlier version did) collapsed `:3` and `:4` onto the same
// key: the SOL and EVM sets became identical, every EVM signal was mislabelled
// SOL, and any OTHER topic in that supergroup — general chat, a service post,
// the bare group — matched too and got force-forwarded. A configured source
// therefore matches ONLY its own topic; a bare-group source matches only a
// bare-group (topic-less) message.
//
// PURE. No I/O beyond reading process.env (the convention every sibling in this
// directory follows — see source.ts, guard.ts, digest.ts), so the whole
// recognise-and-shape step is a unit test rather than a running bot.

import { detectContractAddresses, normalizeContractAddress } from '../utils/contract.js';

/** Which source a signal came from. Drives the card's chain line + dedupe key. */
export type OctSignalChain = 'sol' | 'evm';

/**
 * One forwarded signal, reduced to what the card and the fan-out need.
 *
 * `text` is UNTRUSTED third-party content and is escaped at render, never here.
 * `addresses` are extracted by the shared detector, so they are already
 * narrowed to real SOL/EVM shapes. `ticker`/`mcapDisplay` are parsed from the
 * same untrusted body by the pure helpers below: bounded, validated, and
 * escaped at render — they are the ONLY scan fields the minimal card shows.
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
  /**
   * Bare ticker parsed from the body (no `$`, upper-cased, length-capped), or
   * null when none could be found. The render adds exactly one `$`.
   */
  ticker: string | null;
  /**
   * Normalised market-cap display string parsed from a labelled `MC`/`MCAP`/
   * `Market Cap` figure (e.g. `$735.02K`), or null when absent/unparseable.
   * Never a NaN or a wrong number — an unparseable figure omits the line.
   */
  mcapDisplay: string | null;
}

// --- Field extraction from the untrusted scan body --------------------------
//
// UNTRUSTED INPUT. Everything below reads third-party text. Each helper is pure,
// bounds the length of what it returns, rejects non-finite numbers, and leaves
// escaping to the renderer (html.ts). None of them can throw on hostile input.

/** Longest ticker the card will show (a real ticker is a handful of chars). */
const MAX_TICKER_LEN = 15;
/** Longest market-cap numeric run we accept before treating it as garbage. */
const MAX_MCAP_DIGITS = 20;

/**
 * The token name from the FIRST non-empty line, markdown stripped — the ticker
 * fallback when the body carries no explicit `$SYMBOL`. Returns null when the
 * line reduces to nothing usable.
 */
function extractHeaderName(text: string): string | null {
  const firstLine = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '');
  if (!firstLine) return null;

  // A real scan puts the token name in a FORMATTED header (a markdown link or
  // bold run). Remember that before stripping the markup, so we can tell a
  // genuine name from a line of prose.
  const wasFormatted = /\[[^\]]+\]\([^)]*\)/.test(firstLine) || /\*\*[^*]+\*\*/.test(firstLine);

  let s = firstLine;
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'); // [label](url) → label
  s = s.replace(/https?:\/\/\S+/g, ' '); // bare urls
  s = s.replace(/[*_`~]+/g, ''); // markdown emphasis markers
  s = s.replace(/\([^)]*\)\s*$/g, ''); // a trailing ($TICKER) / (…) group
  s = s.replace(/^[^\p{L}\p{N}$]+/u, ''); // leading emoji / bullet / symbols
  s = s.trim();
  if (s === '') return null;

  // Only accept prose as a name when the header was actually formatted like one,
  // or is short enough to plausibly BE a name — never a whole sentence, which
  // would render as a nonsense "$THE MARKET IS" ticker.
  if (!wasFormatted && (s.length > 32 || s.split(/\s+/).length > 4)) return null;
  return s;
}

/**
 * The ticker for the card: the first `$SYMBOL`, else the header name. Stripped
 * of a leading `$`, upper-cased, and length-capped. Null when nothing usable is
 * found — the render then shows a neutral header instead.
 */
export function parseSignalTicker(text: string): string | null {
  const dollar = text.match(/\$([A-Za-z][A-Za-z0-9_]{0,29})/);
  const raw = dollar?.[1] ?? extractHeaderName(text);
  if (!raw) return null;
  const cleaned = raw.replace(/^\$+/, '').trim().toUpperCase();
  if (cleaned === '') return null;
  return cleaned.slice(0, MAX_TICKER_LEN);
}

/**
 * The market cap for the card: a labelled `MC`/`MCAP`/`Market Cap` figure with
 * an optional `$` and `K`/`M`/`B`/`T` suffix (`$17.5K`, `$1.2M`, `750K`),
 * normalised to a `$…` display string. Null when absent or unparseable — never
 * a NaN and never a different number than the one written.
 *
 * The label anchor means ATH/VOL/LIQ figures on adjacent lines cannot be
 * mistaken for the market cap.
 */
export function parseSignalMarketCap(text: string): string | null {
  const m = text.match(
    /\b(?:MCAP|MC|MARKET\s*CAP)\b\s*[:=]?\s*\*{0,2}\s*\$?\s*(\d[\d,]*(?:\.\d+)?)\s*([KMBT])?/i,
  );
  if (!m) return null;
  const numStr = m[1].replace(/,/g, '');
  if (numStr.length > MAX_MCAP_DIGITS) return null;
  const value = Number(numStr);
  if (!Number.isFinite(value) || value <= 0) return null;
  const suffix = (m[2] ?? '').toUpperCase();
  return `$${numStr}${suffix}`;
}

// --- Dedupe (one call = one alert) ------------------------------------------
//
// Upstream posts the SAME call twice within seconds — a text card and an image
// card — each carrying the same contract. Left alone that is two alerts. This
// collapses them to one per (chain, primary address) inside a TTL window,
// first-wins. In-memory only: no persistence, no Supabase, nothing to restore.

/** Env names for the dedupe window, primary first. */
const DEDUPE_TTL_ENV = ['OCT_SIGNAL_DEDUPE_TTL_MS', 'TG_BOT_SIGNAL_DEDUPE_TTL_MS'] as const;
/** Default window: two near-simultaneous posts of one call collapse. */
const DEFAULT_DEDUPE_TTL_MS = 10 * 60 * 1000;
/** Hard ceiling on the map so a long-running process cannot grow it unbounded. */
const DEDUPE_MAX_ENTRIES = 5000;

function readDedupeTtlMs(): number {
  for (const name of DEDUPE_TTL_ENV) {
    const raw = process.env[name]?.trim();
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return DEFAULT_DEDUPE_TTL_MS;
}

/**
 * The dedupe key for a signal: chain + case-normalised primary address. Chain
 * is part of the key on purpose — the same CA on SOL and on EVM are two real,
 * distinct tokens and both must alert. EVM addresses fold to lowercase (the same
 * mint arrives in mixed casings); SOL is base58 and case-SENSITIVE, so it is
 * left untouched — exactly `normalizeContractAddress`'s contract.
 */
export function octSignalDedupeKey(chain: OctSignalChain, address: string): string {
  return `${chain}:${normalizeContractAddress(address)}`;
}

/**
 * A tiny in-memory TTL set of recently-seen signal keys. One instance lives on
 * the alert router (a sibling of its guard/buffer). Expired keys are swept on
 * every check, and the map is capped so it cannot leak.
 */
export class OctSignalDedupe {
  /** key → epoch-ms at which the key expires. */
  private readonly seen = new Map<string, number>();

  /**
   * True when `key` was seen inside the TTL window (drop this signal); false the
   * FIRST time (record it and deliver). First-wins: a later duplicate never
   * refreshes the window, so a genuine re-call after the TTL alerts again.
   */
  isDuplicate(key: string, now: number = Date.now()): boolean {
    this.evict(now);
    const expiresAt = this.seen.get(key);
    if (expiresAt !== undefined && expiresAt > now) return true;
    this.seen.set(key, now + readDedupeTtlMs());
    if (this.seen.size > DEDUPE_MAX_ENTRIES) this.trim();
    return false;
  }

  /** Drop every expired key. */
  private evict(now: number): void {
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(key);
    }
  }

  /** Last-resort cap: drop the oldest-inserted keys (Map preserves order). */
  private trim(): void {
    const overflow = this.seen.size - DEDUPE_MAX_ENTRIES;
    if (overflow <= 0) return;
    let dropped = 0;
    for (const key of this.seen.keys()) {
      this.seen.delete(key);
      if (++dropped >= overflow) break;
    }
  }
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
 * Canonical form of a Telegram source id for exact comparison.
 *
 * Only the PEER-prefix noise is normalised: `-1001234567890`, its bare
 * `1234567890`, and (for a basic group) a single leading `-` all reduce to the
 * same digit-core, so the env value and the ingested id compare equal whichever
 * `-100`/bare form each happens to use. Two channels that merely share a prefix
 * still stay distinct — this compares the whole digit-core, never a prefix.
 *
 * The `:topicId` segment is PRESERVED and REQUIRED: a forum-topic source is
 * `<digit-core>:<topic>`, and `:3` never compares equal to `:4` or to the bare
 * group. The topic is normalised to its integer form so `:03` and `:3` agree; a
 * malformed/empty topic segment is treated as "no topic" (bare group).
 */
function canonicalChannelId(id: string): string {
  const trimmed = id.trim();
  const colon = trimmed.indexOf(':');
  const chatPart = colon === -1 ? trimmed : trimmed.slice(0, colon);
  const topicPart = colon === -1 ? '' : trimmed.slice(colon + 1).trim();

  const core = chatPart
    .trim()
    .replace(/^-100/, '') // supergroup/channel peer prefix
    .replace(/^-/, ''); // basic-group prefix

  const topicNum = Number(topicPart);
  const topic = topicPart !== '' && Number.isInteger(topicNum) && topicNum > 0 ? String(topicNum) : '';

  return topic !== '' ? `${core}:${topic}` : core;
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
  // Ticker/MC are parsed from the RAW body (before signature stripping) so a
  // stat line is never lost to an aggressive strip; the CA is likewise
  // extracted independently. Both are omitted, not faked, when absent.
  const ticker = parseSignalTicker(raw);
  const mcapDisplay = parseSignalMarketCap(raw);
  return { chain, network, addresses, text, ticker, mcapDisplay };
}
