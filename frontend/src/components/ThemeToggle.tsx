import { Moon, Sun } from 'lucide-react';
import { useThemeStore } from '../stores/themeStore';

export default function ThemeToggle() {
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);
  const isLight = theme === 'light';

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isLight}
      aria-label={isLight ? 'Switch to dark theme' : 'Switch to light theme'}
      title={isLight ? 'Dark mode' : 'Light mode'}
      onClick={toggleTheme}
      className={[
        'relative shrink-0 w-11 h-6 rounded-full border-2 transition-colors duration-200',
        'border-oct-border-bright bg-oct-surface-raised',
        'hover:border-oct-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oct-accent/50',
      ].join(' ')}
    >
      <Sun
        size={11}
        className={[
          'absolute left-1 top-1/2 -translate-y-1/2 transition-opacity duration-200 pointer-events-none',
          isLight ? 'text-oct-accent opacity-100' : 'text-oct-muted opacity-35',
        ].join(' ')}
        aria-hidden
      />
      <Moon
        size={11}
        className={[
          'absolute right-1 top-1/2 -translate-y-1/2 transition-opacity duration-200 pointer-events-none',
          isLight ? 'text-oct-muted opacity-35' : 'text-oct-accent opacity-100',
        ].join(' ')}
        aria-hidden
      />
      <span
        className={[
          'absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-oct-accent shadow-oct-hard-sm',
          'transition-transform duration-200 ease-out',
          isLight ? 'translate-x-5' : 'translate-x-0',
        ].join(' ')}
      />
    </button>
  );
}
