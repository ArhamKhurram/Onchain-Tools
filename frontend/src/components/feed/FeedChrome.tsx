import { useCallback, useEffect, useState } from 'react';
import type { ComponentType } from 'react';
import { DEFAULT_FEED_CHROME_PRESET } from './feedChromeContract';
import type { FeedChromePreset, FeedChromePresetProps } from './feedChromeContract';
import { useFeedChromeModel } from './useFeedChromeModel';
import RoomPalette from './RoomPalette';
import TerminalChrome from './presets/TerminalChrome';
import MastheadChrome from './presets/MastheadChrome';
import RailChrome from './presets/RailChrome';

// Exhaustive by construction: a preset added to the union without a layout here
// is a compile error.
const PRESET_LAYOUTS: Record<FeedChromePreset, ComponentType<FeedChromePresetProps>> = {
  terminal: TerminalChrome,
  masthead: MastheadChrome,
  rail: RailChrome,
};

interface FeedChromeProps {
  preset?: FeedChromePreset;
}

export default function FeedChrome({ preset = DEFAULT_FEED_CHROME_PRESET }: FeedChromeProps) {
  const model = useFeedChromeModel(preset);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (e.key.toLowerCase() !== 'k') return;
      e.preventDefault();
      setPaletteOpen((v) => !v);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const Layout = PRESET_LAYOUTS[preset];

  return (
    <>
      <Layout model={model} paletteOpen={paletteOpen} onOpenPalette={openPalette} />
      <RoomPalette open={paletteOpen} model={model} onClose={closePalette} />
    </>
  );
}
