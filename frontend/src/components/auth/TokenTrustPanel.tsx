import { useState } from 'react';
import { ChevronDown, ShieldCheck, HelpCircle } from 'lucide-react';
import { isClientGatewayMode } from '../../discord/clientGateway';
import { track } from '../../lib/analytics';

// The trust panel that sits at the token-paste step — the activation cliff.
// Three jobs, all aimed at converting "I don't know what they're asking / this
// looks like a scam" into an informed, de-risked step:
//   1. Show where the token goes (browser → Discord; never OCT's servers in
//      hosted/browser-gateway mode — which is verifiable, so we invite it).
//   2. Teach how to extract the token (the step is impossible without this).
//   3. Name the Discord ToS reality plainly instead of hiding it.
// Copy is deliberately honest: no "safe/undetectable/official" claims.

function Diagram({ browserLocal }: { browserLocal: boolean }) {
  return (
    <div className="flex items-stretch gap-2 text-center font-mono text-[10px] uppercase tracking-[0.08em]">
      <div className="flex-1 rounded-oct-sm border border-oct-accent/40 bg-oct-accent-dim px-2 py-2.5 text-oct-accent">
        Your browser
      </div>
      <div className="flex items-center text-oct-muted">→</div>
      <div className="flex-1 rounded-oct-sm border border-oct-border bg-oct-surface-raised px-2 py-2.5 text-oct-text">
        Discord
      </div>
      {browserLocal && (
        <>
          <div className="flex items-center text-oct-muted">✕</div>
          <div className="flex-1 rounded-oct-sm border border-dashed border-oct-border px-2 py-2.5 text-oct-muted line-through decoration-oct-red/70">
            OCT servers
          </div>
        </>
      )}
    </div>
  );
}

export default function TokenTrustPanel() {
  const [howToOpen, setHowToOpen] = useState(false);
  const browserLocal = isClientGatewayMode();

  const toggleHowTo = () => {
    setHowToOpen((prev) => {
      const next = !prev;
      if (next) track('token_help_opened');
      return next;
    });
  };

  return (
    <div className="mt-5 space-y-3">
      {/* Where your token goes */}
      <div className="rounded-oct border border-oct-border bg-oct-surface-raised/50 p-3.5">
        <div className="flex items-center gap-2 mb-3">
          <ShieldCheck size={15} className="text-oct-accent-2" />
          <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-oct-text">
            Where your token goes
          </span>
        </div>
        <Diagram browserLocal={browserLocal} />
        <p className="mt-3 text-[11px] leading-relaxed text-oct-muted">
          {browserLocal ? (
            <>
              Your token is used <span className="text-oct-text">only in this browser tab</span> to
              connect straight to Discord. It is stored locally and{' '}
              <span className="text-oct-text">never sent to OCT&apos;s servers</span>. Don&apos;t take
              our word for it — open DevTools → Network and watch: nothing with your token goes to us.
            </>
          ) : (
            <>
              Your token is stored <span className="text-oct-text">locally on this machine</span> and
              used to connect to Discord from here. It stays on your device.
            </>
          )}
        </p>
      </div>

      {/* How to get your token */}
      <div className="rounded-oct border border-oct-border bg-oct-surface-raised/50">
        <button
          type="button"
          onClick={toggleHowTo}
          aria-expanded={howToOpen}
          className="w-full flex items-center gap-2 px-3.5 py-3 text-left"
        >
          <HelpCircle size={15} className="text-oct-accent-2 shrink-0" />
          <span className="flex-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-oct-text">
            How do I get my Discord token?
          </span>
          <ChevronDown
            size={15}
            className={`text-oct-muted transition-transform ${howToOpen ? 'rotate-180' : ''}`}
          />
        </button>
        {howToOpen && (
          <div className="px-3.5 pb-3.5 -mt-1">
            <ol className="space-y-2 text-[11px] leading-relaxed text-oct-muted list-decimal pl-4 marker:text-oct-accent marker:font-mono">
              <li>Open Discord in a desktop browser (not the app) and log in.</li>
              <li>
                Press <span className="text-oct-text font-mono">F12</span> to open DevTools, then open
                the <span className="text-oct-text">Network</span> tab.
              </li>
              <li>
                Type <span className="text-oct-text font-mono">/api</span> in the filter box and click
                around Discord until requests appear.
              </li>
              <li>
                Click any request, find the{' '}
                <span className="text-oct-text font-mono">authorization</span> header, and copy its
                value — that is your token.
              </li>
              <li>Paste it above and hit Connect.</li>
            </ol>
          </div>
        )}
      </div>

      {/* Honest ToS note */}
      <p className="text-[10.5px] leading-relaxed text-oct-muted px-0.5">
        Heads up: this connects through your Discord{' '}
        <span className="text-oct-text">account token</span> (user-account automation, sometimes
        called a &quot;self-bot&quot;). That is against Discord&apos;s Terms of Service in principle;
        OCT only reads messages, but use an account you&apos;re comfortable with. Discord does not
        endorse this.
      </p>
    </div>
  );
}
