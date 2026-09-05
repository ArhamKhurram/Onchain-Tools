import plugin from 'tailwindcss/plugin';

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Theme palette via CSS vars — dark: black/red, light: cream/blue (index.css).
        // The vars hold bare `R G B` channel triples, wrapped here in
        // `rgb(... / <alpha-value>)` so alpha modifiers (`border-oct-accent/30`)
        // actually compile. The `*-dim` tokens bake in their own alpha, so they
        // are passed through as-is and take no alpha modifier.
        oct: {
          bg: 'rgb(var(--oct-bg) / <alpha-value>)',
          panel: 'rgb(var(--oct-panel) / <alpha-value>)',
          surface: 'rgb(var(--oct-surface) / <alpha-value>)',
          'surface-raised': 'rgb(var(--oct-surface-raised) / <alpha-value>)',
          elevated: 'rgb(var(--oct-elevated) / <alpha-value>)',
          border: 'rgb(var(--oct-border) / <alpha-value>)',
          'border-bright': 'rgb(var(--oct-border-bright) / <alpha-value>)',
          text: 'rgb(var(--oct-text) / <alpha-value>)',
          muted: 'rgb(var(--oct-muted) / <alpha-value>)',
          accent: 'rgb(var(--oct-accent) / <alpha-value>)',
          'accent-hover': 'rgb(var(--oct-accent-hover) / <alpha-value>)',
          'accent-2': 'rgb(var(--oct-accent-2) / <alpha-value>)',
          'accent-2-hover': 'rgb(var(--oct-accent-2-hover) / <alpha-value>)',
          'accent-2-dim': 'rgb(var(--oct-accent-2-dim))',
          flame: 'rgb(var(--oct-flame) / <alpha-value>)',
          'accent-dim': 'rgb(var(--oct-accent-dim))',
          live: 'rgb(var(--oct-live) / <alpha-value>)',
          'live-dim': 'rgb(var(--oct-live-dim))',
          // Semantic status tokens. Kept SEPARATE from the accent on purpose:
          // in the dark theme the accent is itself a red, so `text-oct-accent`
          // on a failure state and on a brand link are indistinguishable.
          // Reach for these when the colour carries MEANING (profit, caution,
          // failure) and for the accent only when it carries BRAND.
          // `green`/`yellow` below are the legacy hue-named aliases — same
          // values, resolved through the same vars, kept for existing call
          // sites. New work should use good/warn/critical.
          good: 'rgb(var(--oct-good) / <alpha-value>)',
          warn: 'rgb(var(--oct-warn) / <alpha-value>)',
          critical: 'rgb(var(--oct-critical) / <alpha-value>)',
          'good-dim': 'rgb(var(--oct-good-dim))',
          'warn-dim': 'rgb(var(--oct-warn-dim))',
          'critical-dim': 'rgb(var(--oct-critical-dim))',
          green: 'rgb(var(--oct-green) / <alpha-value>)',
          yellow: 'rgb(var(--oct-yellow) / <alpha-value>)',
          telegram: 'rgb(var(--oct-telegram) / <alpha-value>)',
        },
        discord: {
          dark: 'rgb(var(--oct-bg) / <alpha-value>)',
          darker: 'rgb(var(--oct-surface) / <alpha-value>)',
          sidebar: 'rgb(var(--oct-surface) / <alpha-value>)',
          main: 'rgb(var(--oct-surface-raised) / <alpha-value>)',
          input: 'rgb(var(--oct-surface-raised) / <alpha-value>)',
          hover: 'rgb(var(--oct-surface-raised) / <alpha-value>)',
          'hover-light': 'rgb(var(--oct-border) / <alpha-value>)',
          border: 'rgb(var(--oct-border) / <alpha-value>)',
          blurple: 'rgb(var(--oct-accent) / <alpha-value>)',
          'blurple-hover': 'rgb(var(--oct-accent-hover) / <alpha-value>)',
          green: 'rgb(var(--oct-green) / <alpha-value>)',
          red: 'rgb(var(--oct-flame) / <alpha-value>)',
          yellow: 'rgb(var(--oct-yellow) / <alpha-value>)',
          text: 'rgb(var(--oct-text) / <alpha-value>)',
          'text-normal': 'rgb(var(--oct-text) / <alpha-value>)',
          'text-muted': 'rgb(var(--oct-muted) / <alpha-value>)',
          'text-link': 'rgb(var(--oct-accent) / <alpha-value>)',
          'header-primary': 'rgb(var(--oct-text) / <alpha-value>)',
          'header-secondary': 'rgb(var(--oct-muted) / <alpha-value>)',
          'channel-icon': 'rgb(var(--oct-muted) / <alpha-value>)',
          divider: 'rgb(var(--oct-border) / <alpha-value>)',
          'embed-bg': 'rgb(var(--oct-surface) / <alpha-value>)',
          highlight: 'rgb(var(--oct-accent-dim))',
          'mention-bg': 'rgb(var(--oct-accent-dim))',
          'scrollbar-thin-track': 'rgb(var(--oct-bg) / <alpha-value>)',
          'scrollbar-thin-thumb': 'rgb(var(--oct-border) / <alpha-value>)',
        },
      },
      // Type scale. Tailwind ships no `fontSize` override here by default, so
      // every `text-*` call-site inherited Tailwind's stock ramp — which put
      // OCT's dominant body text at 12px (`text-xs`, 437 sites) and its
      // secondary at 14px (`text-sm`, 334 sites). Every terminal OCT competes
      // with runs dominant body text at 14px+, so the console was rendering a
      // full step below the category floor. Redefining the NAMED sizes lifts
      // ~870 existing call-sites at once with zero component edits.
      //
      // `text-xs` is 13px and `text-sm` is 15px. That is deliberate — do not
      // "fix" them back to 12/14. Deleting this whole block is the revert.
      //
      // Each size carries its own line-height and letter-spacing so vertical
      // rhythm stops depending on the `line-height: 1.5` inherited from body.
      // Tracking is positive below 13px (Carbon's productive set opens small
      // text) and negative from 15px up (Linear's measured curve). `tracking-*`
      // utilities still win where a component sets one explicitly, because
      // Tailwind emits letterSpacing after fontSize.
      //
      // `2xs` (12px) is the hard floor for new work; nothing should render
      // below it. The 407 legacy `text-[8..11px]` arbitrary sizes bypass this
      // block entirely and are unaffected — migrating them is a separate pass.
      fontSize: {
        '2xs': ['0.75rem', { lineHeight: '1rem', letterSpacing: '0.01em' }], // 12
        xs: ['0.8125rem', { lineHeight: '1.125rem', letterSpacing: '0em' }], // 13
        sm: ['0.9375rem', { lineHeight: '1.375rem', letterSpacing: '-0.011em' }], // 15
        base: ['1rem', { lineHeight: '1.5rem', letterSpacing: '-0.011em' }], // 16
        lg: ['1.125rem', { lineHeight: '1.625rem', letterSpacing: '-0.014em' }], // 18
        xl: ['1.25rem', { lineHeight: '1.75rem', letterSpacing: '-0.016em' }], // 20
        '2xl': ['1.5rem', { lineHeight: '1.875rem', letterSpacing: '-0.014em' }], // 24
        '3xl': ['1.875rem', { lineHeight: '2.125rem', letterSpacing: '-0.018em' }], // 30
        '4xl': ['2.25rem', { lineHeight: '2.375rem', letterSpacing: '-0.022em' }], // 36
        '5xl': ['3rem', { lineHeight: '3rem', letterSpacing: '-0.026em' }], // 48
      },
      fontFamily: {
        display: ['Fraunces', 'Georgia', 'serif'],
        sans: ['"Space Grotesk"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
        discord: ['"Space Grotesk"', 'system-ui', 'sans-serif'],
      },
      // Density scale — NAMED spacing roles layered on top of Tailwind's numeric
      // ramp, backed by the `--oct-space-*` vars in index.css.
      //
      // This deliberately EXTENDS rather than replaces `spacing`. Redefining the
      // numeric scale would move every existing `p-4`/`gap-2` in the app at once
      // — the same lever the fontSize block above pulls on purpose for type, and
      // exactly the wrong one for layout, where the blast radius is every screen
      // rather than one legible ramp. So `p-4` still means 16px; `p-roomy` also
      // means 16px, and is the token you reach for in new work.
      //
      // Reading them as roles rather than numbers is the point: a dense table row
      // is `py-snug` because it is dense, not because someone picked 1.5.
      spacing: {
        hair: 'var(--oct-space-hair)', // 2px
        tight: 'var(--oct-space-tight)', // 4px
        snug: 'var(--oct-space-snug)', // 6px
        cozy: 'var(--oct-space-cozy)', // 8px
        comfy: 'var(--oct-space-comfy)', // 12px
        roomy: 'var(--oct-space-roomy)', // 16px
        section: 'var(--oct-space-section)', // 24px
        gutter: 'var(--oct-space-gutter)', // 32px
      },
      // Motion durations, shared with lib/motion.ts so CSS transitions and
      // Motion tweens stay on one clock (`duration-fast`, `duration-base`, …).
      transitionDuration: {
        instant: 'var(--oct-duration-instant)',
        fast: 'var(--oct-duration-fast)',
        base: 'var(--oct-duration-base)',
        slow: 'var(--oct-duration-slow)',
      },
      borderRadius: {
        cockpit: '0px',
        // Premium terminal radii — refined, not fully rounded.
        oct: '10px',
        'oct-sm': '6px',
        'oct-lg': '14px',
      },
      borderWidth: {
        3: '3px',
      },
      boxShadow: {
        'oct-glow': '4px 4px 0 0 rgb(var(--oct-shadow))',
        'oct-hard': '4px 4px 0 0 rgb(var(--oct-shadow))',
        'oct-hard-sm': '2px 2px 0 0 rgb(var(--oct-shadow))',
        'oct-hard-lg': '6px 6px 0 0 rgb(var(--oct-shadow))',
        'oct-hard-red': '4px 4px 0 0 rgb(var(--oct-accent))',
        'oct-hard-red-sm': '2px 2px 0 0 rgb(var(--oct-accent))',
        // Soft premium elevation + accent glow.
        'oct-soft': '0 1px 2px 0 rgb(var(--oct-shadow-soft)), 0 10px 26px -16px rgb(var(--oct-shadow-soft))',
        'oct-soft-lg': '0 2px 4px 0 rgb(var(--oct-shadow-soft)), 0 24px 48px -24px rgb(var(--oct-shadow-soft))',
        'oct-glow-accent': '0 0 24px -6px rgb(var(--oct-glow-accent))',
      },
      keyframes: {
        'pulse-live': {
          '0%, 100%': { opacity: '1', boxShadow: '0 0 0 0 rgb(var(--oct-live-pulse))' },
          '50%': { opacity: '0.7', boxShadow: '0 0 0 3px transparent' },
        },
        'pulse-pending': {
          '0%, 100%': { opacity: '1', boxShadow: '0 0 0 0 rgba(251, 191, 36, 0.5)' },
          '50%': { opacity: '0.7', boxShadow: '0 0 0 3px rgba(251, 191, 36, 0)' },
        },
      },
      animation: {
        'pulse-live': 'pulse-live 2.4s ease-in-out infinite',
        'pulse-pending': 'pulse-pending 2.8s ease-in-out infinite',
      },
    },
  },
  plugins: [
    // ── Semantic type roles ──────────────────────────────────────────────────
    // The `fontSize` block above fixes the SIZES; this fixes the VOCABULARY.
    // `text-sm` says how big something is, not what it is, so every new surface
    // re-derives "what size is a card title?" from scratch. These name the role
    // instead: `type-title`, `type-body`, `type-data`.
    //
    // Three properties make them worth having over raw `text-*`:
    //
    //  1. They read their sizes back out of `theme.fontSize`, so the roles can
    //     never drift from the ramp. Retune `sm` once and every `type-body` in
    //     the app follows — which is exactly the failure mode the hand-written
    //     px values in index.css warn about ("If you change the scale, change
    //     these").
    //  2. They carry weight and family too, not just size, so a label is one
    //     class rather than `text-xs font-semibold tracking-wide`.
    //  3. They are registered as COMPONENTS, not utilities. That puts them in an
    //     earlier cascade layer, so a one-off `text-lg` on the same element still
    //     wins. The `.oct-*` type helpers in index.css sit in the utilities layer
    //     and therefore BEAT `text-*` — the documented cause of eight modal
    //     headers rendering a 14px title above 15px body copy.
    //
    // Relationship to the `.oct-*` type helpers: those stay exactly as they are.
    // They are load-bearing across screens and flipping their cascade position
    // would be a silent restyle of surfaces this pass is not touching. `type-*`
    // is the vocabulary for new and migrated work; the two converge when the
    // last `.oct-label` call site is gone.
    //
    // Family is left to inherit on everything except the data roles, so a
    // headline can opt into Fraunces with `.font-display` without fighting it.
    plugin(({ addComponents, theme }) => {
      const fontSize = theme('fontSize');
      // theme() hands font stacks back as an array in some Tailwind versions and
      // as an already-joined string in others; normalise rather than assume.
      const monoStack = theme('fontFamily.mono');
      const mono = Array.isArray(monoStack) ? monoStack.join(', ') : monoStack;

      /** Flatten a [size, { lineHeight, letterSpacing }] scale entry into CSS. */
      const step = (key, extra) => {
        const [size, mods = {}] = fontSize[key];
        return { fontSize: size, ...mods, ...extra };
      };

      addComponents({
        /* Page + hero titles. Pair with `.font-display` for the serif treatment. */
        '.type-display': step('3xl', { fontWeight: '700' }),
        /* Top-level section headings within a page. */
        '.type-heading': step('xl', { fontWeight: '700' }),
        /* Card, panel and modal titles. */
        '.type-title': step('base', { fontWeight: '700' }),
        /* Default body copy — the console's baseline. */
        '.type-body': step('sm', { fontWeight: '400' }),
        /* Form and inline labels. */
        '.type-label': step('xs', { fontWeight: '600' }),
        /* Secondary/annotation copy. 12px is the floor; nothing goes below it. */
        '.type-caption': step('2xs', { fontWeight: '500' }),

        // The numeric roles. `tabular-nums` is the whole point: proportional
        // digits make a column of market caps ragged because a 1 is narrower
        // than a 0, so values stop being scannable down the column. `slashed-
        // zero` disambiguates 0/O in addresses and tickers. Both belong to the
        // token, not to the call site — a mint address or a PnL figure wants
        // them every time it is rendered.
        //
        // For migrating an existing cell that already has its own `text-*`,
        // Tailwind's core `tabular-nums` utility is the one-class fix.
        /* Mono data: prices, market caps, multiples, addresses, timestamps. */
        '.type-data': step('xs', {
          fontFamily: mono,
          fontWeight: '500',
          fontVariantNumeric: 'tabular-nums slashed-zero',
        }),
        /* Headline numbers in stat tiles and summary rows. */
        '.type-metric': step('2xl', {
          fontWeight: '700',
          fontVariantNumeric: 'tabular-nums',
          lineHeight: '1.1',
        }),
      });
    }),
  ],
};
