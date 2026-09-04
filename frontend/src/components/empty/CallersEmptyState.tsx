import { useAppStore } from '../../stores/appStore';
import { useUpstreamGap } from '../../hooks/useActivation';
import { routes } from '../../lib/routes';
import { docsUrl } from '../../lib/links';
import SurfaceEmptyState from './SurfaceEmptyState';

// Contracts and Radar are downstream of Feed: nothing on their own page can
// fill them. So the one primary action is whichever upstream step is missing —
// connect a source, create a room — or, when both exist, simply open Feed and
// wait. Both tabs share this so they never disagree about why they are empty.

interface CallersEmptyStateProps {
  surface: 'contracts' | 'radar';
  /** Radar sits inside a `<td>`; Contracts fills its scroll area. */
  layout?: 'page' | 'inline';
}

const COPY = {
  contracts: {
    eyebrow: '[ CONTRACTS ]',
    title: 'No contracts detected yet',
    what: 'Every Solana and EVM address posted in your rooms lands here as it drops, with caller, chain and market cap.',
    docs: 'callers/contracts',
  },
  radar: {
    eyebrow: '[ RADAR ]',
    title: 'Radar is empty',
    what: 'Radar aggregates the contract feed by token — mention count, first caller, peak multiple — so a CA getting passed around stands out.',
    docs: 'callers/radar',
  },
} as const;

export default function CallersEmptyState({ surface, layout = 'page' }: CallersEmptyStateProps) {
  const gap = useUpstreamGap();
  const openConfigModal = useAppStore((s) => s.openConfigModal);
  const copy = COPY[surface];

  const why =
    gap === 'source'
      ? 'Nothing feeds it until a Discord or Telegram source is connected.'
      : gap === 'room'
        ? 'A source is connected but no room is streaming yet.'
        : 'Rooms are live. It fills the first time one of them posts a CA.';

  const primary =
    gap === 'source'
      ? { label: 'Connect a source', to: routes.feed }
      : gap === 'room'
        ? { label: 'Create a room', onClick: () => openConfigModal() }
        : { label: 'Open Feed', to: routes.feed };

  return (
    <SurfaceEmptyState
      eyebrow={copy.eyebrow}
      title={copy.title}
      body={`${copy.what} ${why}`}
      primary={primary}
      secondary={{ label: `About ${surface}`, href: docsUrl(copy.docs) }}
      layout={layout}
    />
  );
}
