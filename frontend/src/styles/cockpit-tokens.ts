/**
 * OCT cockpit / racing-livery design tokens.
 * Use these values — do not substitute generic dark-mode defaults.
 */
export const cockpit = {
  bg: '#0B0E1A',
  panel: '#12142299',
  accentRed: '#E11D2E',
  accentBlue: '#2B4EFF',
  text: '#E8EAF0',
  muted: '#7C87A3',
  border: '#1F2333',
} as const;

export type StatusVariant = 'live' | 'pending' | 'neutral';
