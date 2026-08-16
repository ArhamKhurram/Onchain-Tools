import { ArrowRight } from 'lucide-react';
import { OctLogo } from './OctLogo';
import { APP_CONSOLE_PATH, SOCIAL_X_URL, SOCIAL_X_HANDLE } from '../constants';

/** X (formerly Twitter) mark. Inline so the footer needs no icon-pack entry. */
function XIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-dc-divider bg-dc-sidebar py-8 px-6">
      <div className="mx-auto max-w-6xl flex flex-col sm:flex-row items-center justify-between gap-4">
        <OctLogo size="sm" showSubtitle />
        <p className="text-[11px] text-dc-text-faint text-center max-w-md leading-relaxed">
          Onchain Tools (OCT) is an independent project and is not affiliated with Discord Inc.
          Using self-bots is against Discord&apos;s Terms of Service. This tool is for personal
          and educational use only. Use at your own risk.
        </p>
        <div className="flex items-center gap-4">
          <a
            href={SOCIAL_X_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Onchain Tools on X (${SOCIAL_X_HANDLE})`}
            title={SOCIAL_X_HANDLE}
            className="text-dc-text-muted hover:text-oct-accent transition-colors flex items-center gap-1.5 text-xs font-medium"
          >
            <XIcon />
            <span className="hidden sm:inline">{SOCIAL_X_HANDLE}</span>
          </a>
          <a
            href={APP_CONSOLE_PATH}
            className="text-dc-text-muted hover:text-oct-accent transition-colors flex items-center gap-1.5 text-xs font-medium"
          >
            <ArrowRight size={14} />
            Launch Console
          </a>
        </div>
      </div>
    </footer>
  );
}
