import { APP_CONSOLE_PATH } from '../../constants';

interface LandingNavProps {
  entered: boolean;
  lightNav?: boolean;
}

/** Minimal landing header — no console module tabs; one CTA to /dashboard. */
export function LandingNav({ entered, lightNav = false }: LandingNavProps) {
  if (!entered) return null;

  return (
    <header
      className={`fixed top-0 inset-x-0 z-50 px-4 sm:px-8 py-4 flex items-center justify-between font-mono text-[11px] sm:text-xs uppercase tracking-[0.12em] pointer-events-none ${
        lightNav ? 'text-white' : 'text-black'
      }`}
    >
      <a
        href="#"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('landing-scroll')?.scrollTo({ top: 0, behavior: 'smooth' });
        }}
        className="font-display text-sm sm:text-base tracking-tight normal-case pointer-events-auto hover:opacity-80 transition-opacity"
      >
        OCT
      </a>

      <span className="hidden md:inline absolute left-1/2 -translate-x-1/2 opacity-60 pointer-events-none">
        ONCHAIN.TOOLS
      </span>

      <a
        href={APP_CONSOLE_PATH}
        className="pointer-events-auto opacity-90 hover:opacity-100 transition-opacity border-2 border-current px-3 py-1.5 sm:px-4 sm:py-2"
      >
        [ OPEN CONSOLE ]
      </a>
    </header>
  );
}
