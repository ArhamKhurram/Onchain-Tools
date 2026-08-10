import { RefObject, useRef } from 'react';
import { MotionValue, useScroll, useTransform } from 'framer-motion';

/**
 * Scroll-scrubbed motion for a snap section as it crosses the custom scroll
 * container (`#landing-scroll`). Returns a ref to attach to the <section> plus
 * a few derived MotionValues for tasteful parallax/opacity as it enters + exits.
 */
export function useSectionScroll(scrollRef: RefObject<HTMLElement | null>) {
  const sectionRef = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({
    container: scrollRef,
    target: sectionRef,
    offset: ['start end', 'end start'],
  });

  // Heading rises gently through the viewport (enter → exit).
  const headingY: MotionValue<string> = useTransform(scrollYProgress, [0, 1], ['40px', '-40px']);
  // Body content lags slightly for depth.
  const bodyY: MotionValue<string> = useTransform(scrollYProgress, [0, 1], ['24px', '-24px']);
  // Fade in on enter, hold, fade on exit.
  const opacity: MotionValue<number> = useTransform(
    scrollYProgress,
    [0, 0.25, 0.8, 1],
    [0.3, 1, 1, 0.4],
  );

  return { sectionRef, headingY, bodyY, opacity };
}
