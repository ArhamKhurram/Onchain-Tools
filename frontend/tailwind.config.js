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
          border: 'rgb(var(--oct-border) / <alpha-value>)',
          'border-bright': 'rgb(var(--oct-border-bright) / <alpha-value>)',
          text: 'rgb(var(--oct-text) / <alpha-value>)',
          muted: 'rgb(var(--oct-muted) / <alpha-value>)',
          accent: 'rgb(var(--oct-accent) / <alpha-value>)',
          'accent-hover': 'rgb(var(--oct-accent-hover) / <alpha-value>)',
          flame: 'rgb(var(--oct-flame) / <alpha-value>)',
          'accent-dim': 'rgb(var(--oct-accent-dim))',
          live: 'rgb(var(--oct-live) / <alpha-value>)',
          'live-dim': 'rgb(var(--oct-live-dim))',
          green: 'rgb(var(--oct-green) / <alpha-value>)',
          yellow: 'rgb(var(--oct-yellow) / <alpha-value>)',
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
      fontFamily: {
        display: ['Fraunces', 'Georgia', 'serif'],
        sans: ['"Space Grotesk"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
        discord: ['"Space Grotesk"', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        cockpit: '0px',
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
  plugins: [],
};
