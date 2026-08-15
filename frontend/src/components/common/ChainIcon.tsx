import { chainSlugFromNetworkId } from '@oct/shared';

// Small brand-colored glyphs for the chains OCT's FOMO integration covers
// (see FOMO_NETWORK_CHAIN_SLUGS in packages/shared/src/contract.ts). These are
// abstracted shapes, not reproductions of any chain's official logo mark —
// intentionally simple so they read at feed-row size (14-16px) and match the
// app's flat, no-gradient icon style.
//
// Colors intentionally mirror CHAIN_META in ../../types/wallets.ts, which
// keys by WalletChain ('ethereum' | 'bsc' | ...) rather than the FOMO chain
// slug used here ('eth' | 'bsc' | ...) — kept as a second small map rather
// than reshaping either caller's key space for this.
const CHAIN_ICON_META: Record<string, { label: string; color: string }> = {
  sol: { label: 'Solana', color: '#9945FF' },
  eth: { label: 'Ethereum', color: '#627EEA' },
  bsc: { label: 'BNB Chain', color: '#F0B90B' },
  base: { label: 'Base', color: '#0052FF' },
  robinhood: { label: 'Robinhood Chain', color: '#22C55E' },
};

function ChainGlyph({ slug, color }: { slug: string; color: string }) {
  switch (slug) {
    case 'sol':
      // Three offset horizontal bars.
      return (
        <g fill={color}>
          <rect x="2" y="3" width="12" height="2.4" rx="1.2" />
          <rect x="4" y="6.8" width="10" height="2.4" rx="1.2" opacity="0.8" />
          <rect x="2" y="10.6" width="12" height="2.4" rx="1.2" />
        </g>
      );
    case 'eth':
      // Classic diamond silhouette, split top/bottom.
      return (
        <g fill={color}>
          <path d="M8 1L3 8.2L8 6.2L13 8.2L8 1Z" opacity="0.65" />
          <path d="M8 6.2L3 8.2L8 15L13 8.2L8 6.2Z" />
        </g>
      );
    case 'bsc':
      // Five-diamond cross, echoing the BNB mark.
      return (
        <g fill={color}>
          <rect x="6.5" y="6.5" width="3" height="3" transform="rotate(45 8 8)" />
          <rect x="6.5" y="1" width="3" height="3" transform="rotate(45 8 2.5)" />
          <rect x="6.5" y="12" width="3" height="3" transform="rotate(45 8 13.5)" />
          <rect x="1" y="6.5" width="3" height="3" transform="rotate(45 2.5 8)" />
          <rect x="12" y="6.5" width="3" height="3" transform="rotate(45 13.5 8)" />
        </g>
      );
    case 'base':
      // Base's own mark is literally a filled circle.
      return <circle cx="8" cy="8" r="6.5" fill={color} />;
    case 'robinhood':
      // No established simple mark; a diamond keeps it distinct from Base's circle.
      return <rect x="3" y="3" width="10" height="10" rx="2" transform="rotate(45 8 8)" fill={color} />;
    default:
      return <circle cx="8" cy="8" r="5" fill={color} />;
  }
}

interface ChainIconProps {
  networkId: number | null | undefined;
  size?: number;
  className?: string;
}

/** Small chain-brand glyph for a FOMO trade's `networkId`. Renders nothing for an unmapped/missing network. */
export default function ChainIcon({ networkId, size = 14, className = '' }: ChainIconProps) {
  const slug = chainSlugFromNetworkId(networkId ?? null);
  if (!slug) return null;
  const meta = CHAIN_ICON_META[slug];
  if (!meta) return null;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={`shrink-0 ${className}`}
      role="img"
      aria-label={meta.label}
    >
      <title>{meta.label}</title>
      <ChainGlyph slug={slug} color={meta.color} />
    </svg>
  );
}
