import { isHostedMode } from '../../lib/supabase';
import { docsUrl } from '../../lib/links';
import SurfaceEmptyState from './SurfaceEmptyState';

// Sniper with no venue connected AND no rules. Both conditions on purpose: a
// dry-run rule is legitimately drafted before any venue exists (that is how the
// local operator proves the pipeline), so a venue-only gate would hide a rules
// table that has content in it. The rules table's own "No snipe rules" state
// takes over once a venue is live.
//
// Local mode cannot connect from the console — the token is an env var and the
// backend refuses to write its own .env — so the action there is to open the
// Venues tab, which explains exactly which two variables to set.
export default function SniperEmptyState({ onOpenVenues }: { onOpenVenues: () => void }) {
  return (
    <SurfaceEmptyState
      eyebrow="[ SNIPER ]"
      title="No venue connected"
      body={
        isHostedMode
          ? 'The sniper fires console-declared buys through Slotshark, behind your own caps and a kill switch. It cannot fire until a venue credential is stored.'
          : 'The sniper fires console-declared buys through Slotshark, behind your own caps and a kill switch. Local mode reads the venue token from backend/.env.'
      }
      primary={{ label: isHostedMode ? 'Connect Slotshark' : 'Set up the venue', onClick: onOpenVenues }}
      secondary={{ label: 'How the sniper works', href: docsUrl('sniper/sniper') }}
    />
  );
}
