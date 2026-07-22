import { create } from 'zustand';

export type ThemeMode = 'dark' | 'light';

const STORAGE_KEY = 'oct-theme';

function readStoredTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function applyTheme(mode: ThemeMode): void {
  document.documentElement.setAttribute('data-theme', mode);
  document.documentElement.style.colorScheme = mode;
}

interface ThemeState {
  theme: ThemeMode;
  setTheme: (mode: ThemeMode) => void;
  toggleTheme: () => void;
  hydrate: () => void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: readStoredTheme(),

  setTheme: (mode) => {
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      /* ignore */
    }
    applyTheme(mode);
    set({ theme: mode });
  },

  toggleTheme: () => {
    const next = get().theme === 'dark' ? 'light' : 'dark';
    get().setTheme(next);
  },

  hydrate: () => {
    const mode = readStoredTheme();
    applyTheme(mode);
    set({ theme: mode });
  },
}));

/** Call once before React paint (also mirrored in index.html inline script). */
export function initTheme(): void {
  applyTheme(readStoredTheme());
}
