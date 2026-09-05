import { RefObject, useRef } from 'react';
import { MotionValue, useScroll, useTransform } from 'framer-motion';

/**
 * Scroll-scrubbed motion for a snap section as it crosses the custom scroll
 * container (`#landing-scroll`). Returns a ref to attach to the <section> plus
 * a couple of derived MotionValues for tasteful parallax as it enters + exits.
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

  return { sectionRef, headingY, bodyY };
}
