import type { ReactNode } from 'react';
import { ArrowRight, ExternalLink } from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn } from '../../lib/utils';
import { fadeInUp, m, MotionFeatures, useTransition } from '../../lib/motion';

// ── The activation empty state ────────────────────────────────────────────────
// Sits beside `console/ConsoleEmptyState` rather than replacing it. That one is
// the sign-in gate (icon tile, display heading, bracketed CTA) and stays as it
// is. This one is for a surface the user CAN already use but has not fed yet,
// and it is deliberately narrower in what it allows:
//
//   - one or two sentences on what the surface does,
//   - exactly ONE primary action — the thing that makes the surface non-empty,
//   - at most one secondary link.
//
// No illustration, no icon tile. An empty state is a feature on this console:
// it is where a new user learns the dependency chain (source → room → watch →
// signal), so the copy carries the weight and nothing competes with the button.
//
// It animates. Empty states are chrome — they render once and are replaced by
// the real surface, never re-rendered per WebSocket frame — so they are on the
// allowed list at the top of lib/motion.ts. `MotionFeatures` is mounted here,
// locally, so the runtime rides the lazily-loaded page chunk that uses it.

export interface SurfaceEmptyStateAction {
  label: string;
  /** Router path. Ignored when `onClick` is given. */
  to?: string;
  /** Handle in-page (open a modal, switch a tab) instead of navigating. */
  onClick?: () => void;
}

export interface SurfaceEmptyStateProps {
  /** Bracketed kicker naming the surface, e.g. `[ RADAR ]`. */
  eyebrow: string;
  title: string;
  /** One or two sentences. What the surface does, then why it is empty. */
  body: ReactNode;
  primary: SurfaceEmptyStateAction;
  /** External (docs) links open in a new tab; router paths use Link. */
  secondary?: { label: string; to?: string; href?: string };
  /**
   * `page` fills the surface and centres (the default). `inline` drops the
   * min-height so it can sit inside a table cell or a card without pushing the
   * chrome around it off screen.
   */
  layout?: 'page' | 'inline';
  className?: string;
}

const PRIMARY_CLASS =
  'oct-btn-primary inline-flex items-center gap-cozy px-roomy py-cozy type-label uppercase tracking-[0.1em]';

export default function SurfaceEmptyState({
  eyebrow,
  title,
  body,
  primary,
  secondary,
  layout = 'page',
  className,
}: SurfaceEmptyStateProps) {
  const transition = useTransition('snappy');

  return (
    <MotionFeatures>
      <div
        className={cn(
          'flex items-center justify-center bg-oct-bg',
          layout === 'page' ? 'h-full p-section' : 'py-section px-roomy',
          className,
        )}
      >
        <m.div
          variants={fadeInUp}
          initial="hidden"
          animate="visible"
          transition={transition}
          className="w-full max-w-md text-center"
        >
          <p className="type-caption font-mono uppercase tracking-[0.2em] text-oct-muted mb-comfy">{eyebrow}</p>
          <h2 className="type-heading text-oct-text tracking-tight mb-cozy">{title}</h2>
          <p className="type-body text-oct-muted leading-relaxed mb-roomy">{body}</p>

          {primary.onClick ? (
            <button type="button" onClick={primary.onClick} className={PRIMARY_CLASS}>
              {primary.label}
              <ArrowRight size={14} />
            </button>
          ) : primary.to ? (
            <Link to={primary.to} className={PRIMARY_CLASS}>
              {primary.label}
              <ArrowRight size={14} />
            </Link>
          ) : null}

          {secondary && (secondary.to || secondary.href) && (
            <p className="mt-comfy type-caption font-mono text-oct-muted">
              {secondary.href ? (
                <a
                  href={secondary.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-tight underline underline-offset-4 hover:text-oct-text"
                >
                  {secondary.label}
                  <ExternalLink size={12} />
                </a>
              ) : (
                <Link to={secondary.to!} className="underline underline-offset-4 hover:text-oct-text">
                  {secondary.label}
                </Link>
              )}
            </p>
          )}
        </m.div>
      </div>
    </MotionFeatures>
  );
}
