import { docsUrl } from '../../lib/links';
import SurfaceEmptyState from './SurfaceEmptyState';

// Directory (tracked wallets). The add form is a modal owned by WalletTracker,
// so the action is handed in rather than routed.
export default function WalletsEmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <SurfaceEmptyState
      eyebrow="[ DIRECTORY ]"
      title="No wallets tracked"
      body="The Directory is the on-chain addresses you watch — whales, KOLs, deployers — with an alert when one moves. It is private to your account."
      primary={{ label: 'Add a wallet', onClick: onAdd }}
      secondary={{ label: 'About the Directory', href: docsUrl('portfolio/directory') }}
      layout="inline"
    />
  );
}
