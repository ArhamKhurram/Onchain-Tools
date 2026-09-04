import { docsUrl } from '../../lib/links';
import SurfaceEmptyState from './SurfaceEmptyState';

// Portfolio with no holding wallet. Distinct from the Directory: these are the
// wallets you BUY from, and Birdeye (not GMGN) prices them — see CLAUDE.md's
// provider split.
export default function PortfolioEmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <SurfaceEmptyState
      eyebrow="[ PORTFOLIO ]"
      title="No holding wallet"
      body="Portfolio is the PnL, holdings and activity of the wallets you trade from, priced by Birdeye. Add a SOL, ETH, Base, BSC or Robinhood address to see it."
      primary={{ label: 'Add a holding wallet', onClick: onAdd }}
      secondary={{ label: 'About Portfolio', href: docsUrl('portfolio/portfolio') }}
    />
  );
}
