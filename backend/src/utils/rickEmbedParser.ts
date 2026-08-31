/**
 * Parse Rick-style Discord embeds into structured token metadata.
 * Rick titles look like: "Robinhood the Cat · ROBINHOOD/WETH"
 * Description packs FDV / Liq / Vol / Age as emoji-labeled metrics.
 */

import { detectContractAddresses, normalizeContractAddress } from './contract.js';
import { lookupCachedMessage } from './messageReplyCache.js';

export interface TokenEnrichment {
  address: string;
  tokenName?: string;
  tokenSymbol?: string;
  tokenPair?: string;
  description?: string;
  fdvAtCall?: number;
  fdvAtCallDisplay?: string;
  liquidityUsd?: number;
  liquidityDisplay?: string;
  volumeUsd?: number;
  volumeDisplay?: string;
  priceUsd?: number;
  tokenAge?: string;
  evmChain?: string;
  enrichmentSource: 'rick' | 'dexscreener' | 'gmgn';
  // Global first call — Rick's cross-server footer ("espadabtw @ 49.3K · 86x · 10h").
  firstCallerName?: string;
  firstCallMcapUsd?: number;
  /** ISO timestamp: message time minus the footer's relative age. */
  firstCallAt?: string;
}

export interface RickReplyContext {
  addressOverride?: string;
  callerName?: string;
  messageId?: string;
}

type EmbedLike = {
  title?: string;
  description?: string;
  author?: { name?: string };
  fields?: { name: string; value: string }[];
  footer?: { text?: string };
};

const ADDR_RE = /0x[a-fA-F0-9]{40}/;

/** Compact display → number: "21.9K" → 21900, "1.2M" → 1200000 */
export function parseCompactUsd(raw: string): number | undefined {
  const cleaned = raw.replace(/[$,\s]/g, '').trim();
  const m = cleaned.match(/^([\d.]+)\s*([KMBTkmbt])?$/);
  if (!m) {
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : undefined;
  }
  const base = Number(m[1]);
  if (!Number.isFinite(base)) return undefined;
  const mult: Record<string, number> = {
    k: 1e3, K: 1e3,
    m: 1e6, M: 1e6,
    b: 1e9, B: 1e9,
    t: 1e12, T: 1e12,
  };
  return m[2] ? base * (mult[m[2]] ?? 1) : base;
}

function embedBlob(embeds: EmbedLike[]): string {
  const parts: string[] = [];
  for (const e of embeds) {
    if (e.title) parts.push(e.title);
    if (e.description) parts.push(e.description);
    if (e.author?.name) parts.push(e.author.name);
    if (e.footer?.text) parts.push(e.footer.text);
    if (e.fields) {
      for (const f of e.fields) {
        parts.push(f.name, f.value);
      }
    }
  }
  return parts.join('\n');
}

function looksLikeRick(embeds: EmbedLike[], authorUsername?: string): boolean {
  const name = (authorUsername ?? '').toLowerCase();
  if (name.includes('rick')) return true;
  const blob = embedBlob(embeds).toLowerCase();
  const hasFdv = /\bfdv\b|💎/.test(blob);
  const hasLiq = /\bliq\b|💧/.test(blob);
  const hasPairTitle = embeds.some((e) => e.title && /[·•|/]/.test(e.title) && /[A-Za-z0-9]{2,}\/[A-Za-z0-9]{2,}/.test(e.title));
  return (hasFdv && hasLiq) || hasPairTitle;
}

function extractAddress(blob: string): string | null {
  // Rick prints EVM addresses EIP-55 checksummed while the caller's own post is
  // usually all-lowercase; normalise so both describe the same token. Base58
  // (Solana) is case-sensitive and passes through untouched.
  const evm = blob.match(ADDR_RE);
  if (evm) return normalizeContractAddress(evm[0]);
  const labeled = blob.match(/(?:CA|Contract)[:\s`]*([1-9A-HJ-NP-Za-km-z]{32,44})/i);
  if (labeled) return labeled[1];
  return null;
}

function normalizeCallerName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function callerNamesMatch(footerUser: string, callerName: string): boolean {
  const a = normalizeCallerName(footerUser);
  const b = normalizeCallerName(callerName);
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

/** "47s" / "10h" / "3d" / "2w" / "1mo" → milliseconds. */
export function parseRelativeAgeMs(raw: string): number | undefined {
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(mo|[smhdw])$/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const unit = m[2].toLowerCase();
  const ms: Record<string, number> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
    mo: 2_592_000_000, // 30d
  };
  const unitMs = ms[unit];
  return unitMs !== undefined ? n * unitMs : undefined;
}

export interface GlobalFirstCall {
  firstCallerName: string;
  firstCallMcapUsd?: number;
  firstCallMcapDisplay?: string;
  /** ISO timestamp of the first call, when the line carried a relative age. */
  firstCallAt?: string;
}

/**
 * Rick's global first-caller line — the footer naming who called the token
 * first ACROSS servers, at what market cap, and how long ago:
 *   "espadabtw @ 49.3K · 86x · 10h"
 *   "jace444444 @ 341.3K 📈 2x - 47s 👀 41"
 * Tolerant by design: a line must at least carry `<name> @ <mcap>` plus either
 * a multiple ("86x") or a relative age to count — a bare "name @ mcap" is the
 * per-caller entry line `parseFooterCallMc` already handles, not a global
 * first-call claim. Absent or malformed → null, never throws.
 */
export function parseGlobalFirstCall(
  blob: string,
  messageTimestamp?: string,
): GlobalFirstCall | null {
  for (const line of blob.split('\n')) {
    const head = line.match(/^\s*([A-Za-z0-9_.]{2,})\s*@\s*\$?\s*([\d.]+[KMBTkmbt]?)\b/);
    if (!head) continue;

    const rest = line.slice((head.index ?? 0) + head[0].length);
    const mult = rest.match(/(?:^|[\s·•|[(-])([\d.]+)\s*x\b/i);
    const age = rest.match(/(?:^|[\s·•|[(-])(\d+(?:\.\d+)?\s*(?:mo|[smhdw]))\b/i);
    if (!mult && !age) continue;

    const mcap = parseCompactUsd(head[2]);
    const result: GlobalFirstCall = {
      firstCallerName: head[1],
      firstCallMcapUsd: mcap,
      firstCallMcapDisplay: head[2],
    };

    if (age?.[1]) {
      const ageMs = parseRelativeAgeMs(age[1]);
      if (ageMs !== undefined) {
        const baseMs = messageTimestamp ? new Date(messageTimestamp).getTime() : Date.now();
        if (Number.isFinite(baseMs)) {
          result.firstCallAt = new Date(baseMs - ageMs).toISOString();
        }
      }
    }
    return result;
  }
  return null;
}

/** Rick footer lines like "jace444444 @ 341.3K" — caller entry MC. */
function parseFooterCallMc(blob: string): { username?: string; display: string; value?: number } | null {
  const m = blob.match(/(?:^|[\n|])\s*([A-Za-z0-9_]+)?\s*@\s*\$?\s*([\d.]+[KMBTkmbt]?)/);
  if (!m?.[2]) return null;
  const display = m[2].trim();
  return {
    username: m[1]?.trim() || undefined,
    display,
    value: parseCompactUsd(display),
  };
}

function parseTitle(title: string): Pick<TokenEnrichment, 'tokenName' | 'tokenSymbol' | 'tokenPair'> {
  const parts = title.split(/\s*[·•|]\s*/);
  if (parts.length >= 2) {
    const name = parts[0].trim();
    const pair = parts[parts.length - 1].trim();
    const symbol = pair.split('/')[0]?.trim();
    return {
      tokenName: name || undefined,
      tokenSymbol: symbol || undefined,
      tokenPair: pair.includes('/') ? pair : undefined,
    };
  }
  const slash = title.match(/^(.+?)\s*[|/]\s*([A-Za-z0-9.]+(?:\/[A-Za-z0-9.]+)?)$/);
  if (slash) {
    return {
      tokenName: slash[1].trim(),
      tokenSymbol: slash[2].split('/')[0],
      tokenPair: slash[2].includes('/') ? slash[2] : undefined,
    };
  }
  return { tokenName: title.trim() || undefined };
}

function pickMetric(blob: string, patterns: RegExp[]): { display?: string; value?: number } {
  for (const re of patterns) {
    const m = blob.match(re);
    if (m?.[1]) {
      const display = m[1].trim();
      return { display, value: parseCompactUsd(display) };
    }
  }
  return {};
}

function pickFdvAtCall(blob: string, callerName?: string): { display?: string; value?: number } {
  const footer = parseFooterCallMc(blob);
  const mainFdv = pickMetric(blob, [
    /FDV[^0-9$]*\$?\s*([\d.]+[KMBTkmbt]?)/i,
    /💎[^0-9$]*\$?\s*([\d.]+[KMBTkmbt]?)/,
  ]);

  if (footer?.value != null && callerName && footer.username && callerNamesMatch(footer.username, callerName)) {
    return { display: footer.display, value: footer.value };
  }
  return mainFdv;
}

/**
 * Try to parse token enrichment from Discord embeds (Rick and similar bots).
 */
export function parseRickEmbeds(
  embeds: EmbedLike[] | undefined,
  authorUsername?: string,
  replyContext?: Pick<RickReplyContext, 'addressOverride' | 'callerName'> & { messageTimestamp?: string },
): TokenEnrichment | null {
  if (!embeds || embeds.length === 0) return null;
  if (!looksLikeRick(embeds, authorUsername)) return null;

  const blob = embedBlob(embeds);
  const address = replyContext?.addressOverride ?? extractAddress(blob);
  if (!address) return null;

  const titleEmbed = embeds.find((e) => e.title) ?? embeds[0];
  const fromTitle = titleEmbed?.title ? parseTitle(titleEmbed.title) : {};

  const fdv = pickFdvAtCall(blob, replyContext?.callerName);
  const liq = pickMetric(blob, [
    /Liq(?:uidity)?[^0-9$]*\$?\s*([\d.]+[KMBTkmbt]?)/i,
    /💧[^0-9$]*\$?\s*([\d.]+[KMBTkmbt]?)/,
  ]);
  const vol = pickMetric(blob, [
    /Vol(?:ume)?[^0-9$]*\$?\s*([\d.]+[KMBTkmbt]?)/i,
    /📊[^0-9$]*\$?\s*([\d.]+[KMBTkmbt]?)/,
  ]);
  const price = pickMetric(blob, [
    /(?:Price|USD)[^0-9$]*\$?\s*([\d.]+)/i,
    /\$\s*([\d.]+(?:e-?\d+)?)/i,
  ]);

  const globalFirst = parseGlobalFirstCall(blob, replyContext?.messageTimestamp);

  const ageMatch = blob.match(/(?:Age|🕐|⏱)[^\n\d]*(\d+[smhdw])/i);
  const chainMatch = blob.match(/\u{1F310}\s*(\w+)/u)
    ?? blob.match(/\b(Base|ETH|Ethereum|BSC|BNB|Arbitrum|ARB|Solana|SOL|Robinhood)\b/i);

  let description: string | undefined;
  if (titleEmbed?.description) {
    const lines = titleEmbed.description.split('\n').map((l) => l.trim()).filter(Boolean);
    const soft = lines.find((l) => !/FDV|Liq|Vol|Age|TH|HP|\$[\d.]/.test(l) && l.length > 8 && l.length < 120);
    description = soft;
  }

  return {
    address,
    ...fromTitle,
    description,
    fdvAtCall: fdv.value,
    fdvAtCallDisplay: fdv.display,
    liquidityUsd: liq.value,
    liquidityDisplay: liq.display,
    volumeUsd: vol.value,
    volumeDisplay: vol.display,
    priceUsd: price.value,
    tokenAge: ageMatch?.[1],
    firstCallerName: globalFirst?.firstCallerName,
    firstCallMcapUsd: globalFirst?.firstCallMcapUsd,
    firstCallAt: globalFirst?.firstCallAt,
    evmChain: chainMatch?.[1]?.toLowerCase() === 'ethereum' ? 'eth'
      : chainMatch?.[1]?.toLowerCase() === 'bnb' ? 'bsc'
      : chainMatch?.[1]?.toLowerCase() === 'solana' ? 'sol'
      : chainMatch?.[1]?.toLowerCase(),
    enrichmentSource: 'rick',
  };
}

/**
 * Extract any enrichment candidates from a message (embeds + content).
 */
export function tryParseTokenEnrichment(opts: {
  embeds?: EmbedLike[];
  content?: string;
  authorUsername?: string;
  addressOverride?: string;
  callerName?: string;
  /** Timestamp of the embed's message — anchors the global-first relative age. Defaults to now. */
  messageTimestamp?: string;
}): TokenEnrichment | null {
  const fromEmbeds = parseRickEmbeds(opts.embeds, opts.authorUsername, {
    addressOverride: opts.addressOverride,
    callerName: opts.callerName,
    messageTimestamp: opts.messageTimestamp,
  });
  if (fromEmbeds) return fromEmbeds;
  return null;
}

export function buildRickReplyContext(
  referencedMessage?: {
    id?: string;
    content?: string;
    author?: { username?: string; global_name?: string | null };
  } | null,
  messageReference?: { message_id?: string } | null,
): RickReplyContext {
  let ref = referencedMessage;
  if ((!ref?.content || !ref.id) && messageReference?.message_id) {
    const cached = lookupCachedMessage(messageReference.message_id);
    if (cached) {
      ref = {
        id: messageReference.message_id,
        content: cached.content,
        author: {
          username: cached.authorUsername,
          global_name: cached.authorName,
        },
      };
    } else if (messageReference.message_id) {
      return { messageId: messageReference.message_id };
    }
  }
  if (!ref) return {};

  const refContent = ref.content ?? '';
  const addresses = refContent ? detectContractAddresses(refContent).addresses : [];
  const callerName = ref.author?.global_name ?? ref.author?.username;

  return {
    messageId: ref.id,
    addressOverride: addresses[0],
    callerName: callerName ?? undefined,
  };
}
