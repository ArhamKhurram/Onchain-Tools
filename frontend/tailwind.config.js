/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // ── Neobrutalist red + black palette ──────────────────────────────
        // Near-pure black surfaces, stark off-white text, bold primary red.
        oct: {
          bg: '#0A0A0A',
          panel: '#141414',
          surface: '#141414',
          'surface-raised': '#1E1E1E',
          border: '#2E2E2E',
          'border-bright': '#4D4D4D',
          text: '#F5F5F5',
          muted: '#9A9A9A',
          accent: '#FF2A2A',
          'accent-hover': '#E10600',
          'accent-dim': 'rgba(255, 42, 42, 0.14)',
          // "live" now reads as the primary red so the app stays cohesively
          // red + black. Distinct pulse animation still signals real-time.
          live: '#FF2A2A',
          'live-dim': 'rgba(255, 42, 42, 0.16)',
          // Functional status accents (kept minimal, used only for signals).
          green: '#22C55E',
          yellow: '#FBBF24',
        },
        // Legacy "discord-*" tokens remapped onto the same neobrutalist palette
        // so screens that still reference them inherit the new look.
        discord: {
          dark: '#0A0A0A',
          darker: '#141414',
          sidebar: '#141414',
          main: '#1E1E1E',
          input: '#1E1E1E',
          hover: '#1E1E1E',
          'hover-light': '#262626',
          border: '#2E2E2E',
          blurple: '#FF2A2A',
          'blurple-hover': '#E10600',
          green: '#22C55E',
          red: '#FF2A2A',
          yellow: '#FBBF24',
          text: '#F5F5F5',
          'text-normal': '#F5F5F5',
          'text-muted': '#9A9A9A',
          'text-link': '#FF2A2A',
          'header-primary': '#F5F5F5',
          'header-secondary': '#9A9A9A',
          'channel-icon': '#9A9A9A',
          divider: '#2E2E2E',
          'embed-bg': '#141414',
          highlight: 'rgba(255, 42, 42, 0.12)',
          'mention-bg': 'rgba(255, 42, 42, 0.08)',
          'scrollbar-thin-track': '#0A0A0A',
          'scrollbar-thin-thumb': '#2E2E2E',
        },
      },
      fontFamily: {
        sans: ['"Space Grotesk"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
        discord: ['"Space Grotesk"', 'system-ui', 'sans-serif'],
      },
      // Neobrutalism = sharp corners. Keep the token name stable but flatten it.
      borderRadius: {
        cockpit: '0px',
      },
      borderWidth: {
        3: '3px',
      },
      boxShadow: {
        // Hard, zero-blur offset shadows — the neobrutalist signature.
        'oct-glow': '4px 4px 0 0 #000000',
        'oct-hard': '4px 4px 0 0 #000000',
        'oct-hard-sm': '2px 2px 0 0 #000000',
        'oct-hard-lg': '6px 6px 0 0 #000000',
        'oct-hard-red': '4px 4px 0 0 #FF2A2A',
        'oct-hard-red-sm': '2px 2px 0 0 #FF2A2A',
      },
      keyframes: {
        'pulse-live': {
          '0%, 100%': { opacity: '1', boxShadow: '0 0 0 0 rgba(255, 42, 42, 0.6)' },
          '50%': { opacity: '0.7', boxShadow: '0 0 0 3px rgba(255, 42, 42, 0)' },
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
