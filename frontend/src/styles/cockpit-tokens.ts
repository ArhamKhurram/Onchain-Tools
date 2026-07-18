/**
 * OCT neobrutalist design tokens (red + black).
 * Use these values — do not substitute generic dark-mode defaults.
 */
export const cockpit = {
  bg: '#0A0A0A',
  panel: '#141414',
  accentRed: '#FF2A2A',
  accentBlue: '#FF2A2A',
  text: '#F5F5F5',
  muted: '#9A9A9A',
  border: '#2E2E2E',
} as const;

export type StatusVariant = 'live' | 'pending' | 'neutral';
