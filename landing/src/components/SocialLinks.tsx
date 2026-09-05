import { SOCIAL_X_URL, SOCIAL_X_HANDLE, SOCIAL_DISCORD_URL } from '../constants';

// Marks are inline SVG rather than icon-pack imports: lucide dropped its
// Twitter/X glyph and never shipped a Discord one, and pulling a second icon
// dependency in for two paths isn't worth it.

function XIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function DiscordIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M20.317 4.369a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.211.375-.445.865-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.009c.12.099.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.891.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.056c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.331c-1.183 0-2.157-1.086-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.211 0 2.176 1.096 2.157 2.42 0 1.332-.955 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.086-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.211 0 2.176 1.096 2.157 2.42 0 1.332-.946 2.418-2.157 2.418z" />
    </svg>
  );
}

/**
 * X + Discord links. `className` is applied to each anchor so the caller
 * controls colour/typography — the landing nav inherits `currentColor`, which
 * flips black/white per section.
 */
export function SocialLinks({ className = '' }: { className?: string }) {
  // p-2 keeps the mark visually 14-15px while giving a ~30px hit area — a bare
  // icon anchor is a 14px tap target, well under the accessible minimum. The
  // caller pairs this with a tight gap so the padding reads as the spacing.
  const base = `pointer-events-auto p-2 opacity-70 hover:opacity-100 transition-opacity inline-flex items-center gap-1.5 ${className}`;
  return (
    <>
      <a
        href={SOCIAL_X_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Onchain Tools on X (${SOCIAL_X_HANDLE})`}
        title={SOCIAL_X_HANDLE}
        className={base}
      >
        <XIcon />
      </a>
      <a
        href={SOCIAL_DISCORD_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Join the Onchain Tools Discord"
        title="Discord"
        className={base}
      >
        <DiscordIcon />
      </a>
    </>
  );
}
