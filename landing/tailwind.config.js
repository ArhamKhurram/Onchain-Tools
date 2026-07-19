/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        oct: {
          bg: '#000000',
          surface: '#0a0a0a',
          flame: '#ff1744',
          accent: '#ff1744',
          'accent-hover': '#ff4569',
          text: '#ffffff',
          muted: '#888888',
        },
        dc: {
          dark: '#000000',
          text: '#ffffff',
          'text-muted': '#888888',
          'text-faint': '#555555',
          divider: '#222222',
          solana: '#14f195',
          evm: '#ffab00',
        },
      },
      fontFamily: {
        display: ['Fraunces', 'Georgia', 'serif'],
        mono: ['IBM Plex Mono', 'ui-monospace', 'monospace'],
        sans: ['IBM Plex Mono', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
};
