import { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface GateScreenProps {
  onEnter: () => void;
}

export function GateScreen({ onEnter }: GateScreenProps) {
  const [visible, setVisible] = useState(true);
  const [tick, setTick] = useState(0);

  const dismiss = useCallback(() => {
    setVisible(false);
    setTimeout(onEnter, 480);
  }, [onEnter]);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1200);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        dismiss();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, dismiss]);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.45, ease: [0.4, 0, 0.2, 1] }}
          className="fixed inset-0 z-[100] bg-black flex flex-col items-center justify-center cursor-pointer select-none"
          onClick={dismiss}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && dismiss()}
          aria-label="Enter site"
        >
          <span className="absolute top-5 left-5 w-2 h-2 rounded-full bg-oct-flame animate-pulse" />
          <span className="absolute top-5 right-5 font-mono text-sm text-white/70 tabular-nums">
            {String(tick % 100).padStart(2, '0')}
          </span>

          <h1 className="font-display text-[clamp(4rem,18vw,11rem)] leading-none tracking-tight text-white">
            OCT
          </h1>

          <button
            type="button"
            className="mt-8 font-mono text-sm sm:text-base text-white/90 tracking-wide hover:text-white transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              dismiss();
            }}
          >
            [ PRESS ENTER ]
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
