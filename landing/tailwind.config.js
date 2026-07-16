/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        oct: {
          bg: '#08080a',
          surface: '#111114',
          'surface-raised': '#18181c',
          border: '#1f1f24',
          'border-bright': '#2a2a32',
          text: '#e8e8ec',
          muted: '#6b6b76',
          accent: '#ff1744',
          'accent-hover': '#ff4569',
          'accent-dim': 'rgba(255, 23, 68, 0.12)',
          green: '#00e676',
          yellow: '#ffab00',
          solana: '#14f195',
          evm: '#ffab00',
        },
        // Legacy aliases used by existing components
        dc: {
          dark: '#08080a',
          darker: '#111114',
          sidebar: '#111114',
          main: '#18181c',
          input: '#1f1f24',
          hover: '#18181c',
          blurple: '#ff1744',
          'blurple-hover': '#ff4569',
          green: '#00e676',
          red: '#ff1744',
          yellow: '#ffab00',
          text: '#e8e8ec',
          'text-muted': '#6b6b76',
          'text-faint': '#4a4a54',
          'channel-icon': '#6b6b76',
          divider: '#1f1f24',
          highlight: 'rgba(255, 23, 68, 0.12)',
          evm: '#ffab00',
          solana: '#14f195',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
      boxShadow: {
        'oct-glow': '0 0 20px rgba(255, 23, 68, 0.35)',
        'oct-glow-sm': '0 0 12px rgba(255, 23, 68, 0.25)',
      },
    },
  },
  plugins: [],
};
