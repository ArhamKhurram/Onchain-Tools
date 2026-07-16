/**
 * Parse Rick-style Discord embeds into structured token metadata.
 * Rick titles look like: "Robinhood the Cat · ROBINHOOD/WETH"
 * Description packs FDV / Liq / Vol / Age as emoji-labeled metrics.
 */

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
  enrichmentSource: 'rick' | 'dexscreener';
}

type EmbedLike = {
  title?: string;
  description?: string;
  author?: { name?: string };
  fields?: { name: string; value: string }[];
};

const ADDR_RE = /0x[a-fA-F0-9]{40}/;
const SOL_ADDR_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/;

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
  const evm = blob.match(ADDR_RE);
  if (evm) return evm[0];
  // Prefer Sol addresses that appear after "CA" labels
  const labeled = blob.match(/(?:CA|Contract)[:\s`]*([1-9A-HJ-NP-Za-km-z]{32,44})/i);
  if (labeled) return labeled[1];
  return null;
}

function parseTitle(title: string): Pick<TokenEnrichment, 'tokenName' | 'tokenSymbol' | 'tokenPair'> {
  // "Robinhood the Cat · ROBINHOOD/WETH" or "Name - SYMBOL/PAIR"
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

/**
 * Try to parse token enrichment from Discord embeds (Rick and similar bots).
 */
export function parseRickEmbeds(
  embeds: EmbedLike[] | undefined,
  authorUsername?: string,
): TokenEnrichment | null {
  if (!embeds || embeds.length === 0) return null;
  if (!looksLikeRick(embeds, authorUsername)) return null;

  const blob = embedBlob(embeds);
  const address = extractAddress(blob);
  if (!address) return null;

  const titleEmbed = embeds.find((e) => e.title) ?? embeds[0];
  const fromTitle = titleEmbed?.title ? parseTitle(titleEmbed.title) : {};

  const fdv = pickMetric(blob, [
    /FDV[^0-9$]*\$?\s*([\d.]+[KMBTkmbt]?)/i,
    /💎[^0-9$]*\$?\s*([\d.]+[KMBTkmbt]?)/,
  ]);
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

  const ageMatch = blob.match(/(?:Age|🕐|⏱)[^\n\d]*(\d+[smhdw])/i);
  const chainMatch = blob.match(/\u{1F310}\s*(\w+)/u)
    ?? blob.match(/\b(Base|ETH|Ethereum|BSC|BNB|Arbitrum|ARB|Solana|SOL|Robinhood)\b/i);

  let description: string | undefined;
  if (titleEmbed?.description) {
    // First non-metric line as soft description
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
    evmChain: chainMatch?.[1]?.toLowerCase() === 'ethereum' ? 'eth'
      : chainMatch?.[1]?.toLowerCase() === 'bnb' ? 'bsc'
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
}): TokenEnrichment | null {
  const fromEmbeds = parseRickEmbeds(opts.embeds, opts.authorUsername);
  if (fromEmbeds) return fromEmbeds;
  return null;
}
