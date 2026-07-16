/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        oct: {
          bg: '#0B0E1A',
          panel: '#12142299',
          surface: '#121422',
          'surface-raised': '#161828',
          border: '#1F2333',
          text: '#E8EAF0',
          muted: '#7C87A3',
          accent: '#E11D2E',
          live: '#2B4EFF',
          'live-dim': 'rgba(43, 78, 255, 0.14)',
        },
        discord: {
          dark: '#0B0E1A',
          darker: '#121422',
          sidebar: '#121422',
          main: '#161828',
          input: '#1F2333',
          hover: '#161828',
          'hover-light': '#1a1d2e',
          blurple: '#2B4EFF',
          'blurple-hover': '#3d5fff',
          green: '#2B4EFF',
          red: '#E11D2E',
          yellow: '#E11D2E',
          text: '#E8EAF0',
          'text-normal': '#E8EAF0',
          'text-muted': '#7C87A3',
          'text-link': '#2B4EFF',
          'header-primary': '#E8EAF0',
          'header-secondary': '#7C87A3',
          'channel-icon': '#7C87A3',
          divider: '#1F2333',
          'embed-bg': '#121422',
          highlight: 'rgba(43, 78, 255, 0.12)',
          'mention-bg': 'rgba(43, 78, 255, 0.08)',
          'scrollbar-thin-track': '#121422',
          'scrollbar-thin-thumb': '#1F2333',
        },
      },
      fontFamily: {
        sans: ['"Space Grotesk"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
        discord: ['"Space Grotesk"', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        cockpit: '3px',
      },
      keyframes: {
        'pulse-live': {
          '0%, 100%': { opacity: '1', boxShadow: '0 0 0 0 rgba(43, 78, 255, 0.5)' },
          '50%': { opacity: '0.85', boxShadow: '0 0 6px 2px rgba(43, 78, 255, 0.35)' },
        },
        'pulse-pending': {
          '0%, 100%': { opacity: '1', boxShadow: '0 0 0 0 rgba(225, 29, 46, 0.4)' },
          '50%': { opacity: '0.8', boxShadow: '0 0 5px 1px rgba(225, 29, 46, 0.3)' },
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
