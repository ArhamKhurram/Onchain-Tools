import { RefObject, useRef } from 'react';
import { motion, useScroll, useTransform } from 'framer-motion';
import { CrystalVisual } from './CrystalVisual';
import { HeroCanvas } from './HeroCanvas';

export function HeroSection({ scrollRef }: { scrollRef: RefObject<HTMLElement | null> }) {
  const sectionRef = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({
    container: scrollRef,
    target: sectionRef,
    offset: ['start start', 'end start'],
  });
  // Headline drifts up and dissolves as the hero exits; the field parallaxes slower.
  const contentY = useTransform(scrollYProgress, [0, 1], ['0%', '-24%']);
  const contentOpacity = useTransform(scrollYProgress, [0, 0.7], [1, 0]);
  const fieldY = useTransform(scrollYProgress, [0, 1], ['0%', '12%']);
  const fieldScale = useTransform(scrollYProgress, [0, 1], [1, 1.12]);

  return (
    <section
      id="hero"
      ref={sectionRef}
      className="relative snap-start snap-always min-h-[100dvh] flex flex-col items-center justify-center bg-oct-flame text-black overflow-hidden px-6 pr-12 sm:pr-14 pt-20 pb-24"
    >
      <motion.div style={{ y: fieldY, scale: fieldScale }} className="absolute inset-0 -z-0">
        <HeroCanvas />
      </motion.div>

      <motion.div
        style={{ y: contentY, opacity: contentOpacity }}
        className="relative z-10 w-full max-w-6xl mx-auto flex flex-col items-center justify-center text-center min-h-[70vh]"
      >
        <motion.p
          initial={{ opacity: 0, y: 10 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="font-mono text-xs sm:text-sm tracking-[0.2em] mb-6 sm:mb-10"
        >
          [ ONCHAIN TERMINAL ]
        </motion.p>

        <motion.h1
          initial={{ opacity: 0, scale: 0.98 }}
          whileInView={{ opacity: 1, scale: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.7, delay: 0.05 }}
          className="font-display text-[clamp(2.5rem,11vw,7rem)] leading-[0.9] tracking-tight text-center"
        >
          <span className="block">ALPHA IN</span>
          <span className="block">ONE CONSOLE</span>
        </motion.h1>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.2 }}
          className="mt-6 sm:mt-10 flex justify-center"
        >
          <CrystalVisual />
        </motion.div>
      </motion.div>
    </section>
  );
}
