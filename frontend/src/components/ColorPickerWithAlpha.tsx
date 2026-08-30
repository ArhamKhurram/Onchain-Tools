import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createTrailingCommit } from '../utils/trailingCommit';

/**
 * Quiet time after the last picker tick before the value is committed via
 * `onChange`. Native color inputs and range sliders fire continuously during a
 * drag; several consumers wire `onChange` straight into `updateConfig` (a
 * network round trip), so per-tick commits flooded the backend and lagged the
 * whole console. The swatch previews instantly from local state; only the
 * settled value is committed upstream.
 */
const COMMIT_DELAY_MS = 250;

export function parseHexAlpha(color: string): { base: string; alpha: number } {
  if (!color || !color.startsWith('#')) return { base: '#000000', alpha: 1 };
  if (color.length === 9) {
    return { base: color.slice(0, 7), alpha: parseInt(color.slice(7, 9), 16) / 255 };
  }
  return { base: color.length >= 7 ? color.slice(0, 7) : color, alpha: 1 };
}

export function buildHexAlpha(base: string, alpha: number): string {
  const hex6 = base.startsWith('#') ? base.slice(0, 7) : `#${base.slice(0, 6)}`;
  if (alpha >= 1) return hex6;
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
  return `${hex6}${a.toString(16).padStart(2, '0')}`;
}

/** Multiply a stored color's alpha by an extra factor, returning rgba(). */
export function colorWithExtraAlpha(color: string, extraAlpha: number): string {
  const { base, alpha } = parseHexAlpha(color);
  const r = parseInt(base.slice(1, 3), 16) || 0;
  const g = parseInt(base.slice(3, 5), 16) || 0;
  const b = parseInt(base.slice(5, 7), 16) || 0;
  return `rgba(${r}, ${g}, ${b}, ${(alpha * extraAlpha).toFixed(3)})`;
}

interface ColorPickerWithAlphaProps {
  value: string;
  onChange: (color: string) => void;
  defaultColor?: string;
  size?: 'sm' | 'md';
  showTextInput?: boolean;
  className?: string;
}

export default function ColorPickerWithAlpha({
  value,
  onChange,
  defaultColor = '#000000',
  size = 'sm',
  showTextInput = false,
  className = '',
}: ColorPickerWithAlphaProps) {
  // Value being previewed mid-gesture, before it has been committed upstream.
  // `null` means "mirror the prop".
  const [live, setLive] = useState<string | null>(null);

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const committer = useMemo(
    () => createTrailingCommit<string>((c) => onChangeRef.current(c), COMMIT_DELAY_MS),
    [],
  );
  // Flush — not drop — a still-pending value when the picker unmounts, so
  // closing the modal right after choosing a colour keeps the choice.
  useEffect(() => () => committer.flush(), [committer]);

  // When the committed value echoes back through the prop (or an external
  // Reset changes it), go back to mirroring the prop.
  useEffect(() => {
    setLive(null);
  }, [value]);

  const shown = live ?? value;
  const { base, alpha } = useMemo(() => parseHexAlpha(shown || defaultColor), [shown, defaultColor]);
  const pct = Math.round(alpha * 100);

  const push = useCallback(
    (c: string) => {
      setLive(c);
      committer.push(c);
    },
    [committer],
  );

  const handleColorChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => push(buildHexAlpha(e.target.value, alpha)),
    [push, alpha],
  );

  const handleAlphaChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => push(buildHexAlpha(base, Number(e.target.value) / 100)),
    [push, base],
  );

  const handleTextChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = e.target.value;
      if (/^#?[0-9a-fA-F]{0,8}$/.test(v)) push(v.startsWith('#') ? v : `#${v}`);
    },
    [push],
  );

  const swatchSize = size === 'sm' ? 'w-5 h-5' : 'w-8 h-8';

  const checkerBg =
    'repeating-conic-gradient(#808080 0% 25%, transparent 0% 50%) 50% / 8px 8px';

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {/* Color swatch with checkerboard behind for alpha preview */}
      <div className={`${swatchSize} rounded border border-discord-divider shrink-0 relative overflow-hidden`}>
        <div className="absolute inset-0" style={{ background: checkerBg }} />
        <div className="absolute inset-0" style={{ backgroundColor: shown || defaultColor }} />
        <input
          type="color"
          value={base}
          onChange={handleColorChange}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        />
      </div>

      {/* Opacity slider */}
      <div className="flex items-center gap-1.5 min-w-0">
        <input
          type="range"
          min={0}
          max={100}
          value={pct}
          onChange={handleAlphaChange}
          className="w-16 h-1 accent-discord-blurple cursor-pointer"
          title={`Opacity: ${pct}%`}
        />
        <span className="text-[10px] text-discord-text-muted w-7 text-right tabular-nums shrink-0">
          {pct}%
        </span>
      </div>

      {showTextInput && (
        <input
          type="text"
          value={shown}
          onChange={handleTextChange}
          placeholder={defaultColor}
          className="w-[5.5rem] bg-discord-dark border-none rounded px-2 py-1 text-[11px] text-discord-text outline-none focus:ring-1 focus:ring-discord-blurple font-mono"
        />
      )}
    </div>
  );
}
