import { useTransition, type Transition } from '../../lib/motion';

/**
 * Props for a chrome surface that crossfades when the preset changes.
 *
 * FeedChrome keys the active layout by preset inside an `AnimatePresence
 * mode="wait"`, so the outgoing chrome fades out before the incoming one fades
 * in. Presets are not single-rooted (rail is a fixed nav + a sticky strip + a
 * footer that must stay direct children of the shell's flex column), so the
 * fade lives on each preset's own root elements rather than on a wrapper.
 *
 * Chrome only. Message rows are virtualised and re-render per WebSocket frame;
 * they never carry motion props.
 */
export interface ChromeFadeProps {
  initial: { opacity: number };
  animate: { opacity: number };
  exit: { opacity: number };
  transition: Transition;
}

const HIDDEN = { opacity: 0 };
const SHOWN = { opacity: 1 };

export function useChromeFade(): ChromeFadeProps {
  const transition = useTransition('fade');
  return { initial: HIDDEN, animate: SHOWN, exit: HIDDEN, transition };
}
