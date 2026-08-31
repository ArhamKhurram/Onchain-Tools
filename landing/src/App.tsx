import { Suspense, lazy, useRef, useState } from 'react';
import { LazyMotion } from 'framer-motion';
import { GateScreen } from './components/landing/GateScreen';
import { LandingNav } from './components/landing/LandingNav';
import { HeroSection } from './components/landing/HeroSection';
import { StackSection } from './components/landing/StackSection';
import { EnterSection } from './components/landing/EnterSection';
import { SecurityStrip } from './components/landing/SecurityStrip';
// Lazy: WHAT'S NEW is the last section (four viewports below the fold) and its
// build-time-inlined changelog payload (~15 kB and growing with every release)
// doesn't belong in the render-blocking chunk. The Suspense fallback keeps the
// section id + snap geometry so the scroll rail and anchor jumps still work
// during the (brief) load.
const UpdatesSection = lazy(() =>
  import('./components/landing/UpdatesSection').then((mod) => ({ default: mod.UpdatesSection })),
);
import { ScrollRail } from './components/landing/ScrollRail';
import { ScrollFooter } from './components/landing/ScrollFooter';
import { useScrollSections } from './hooks/useScrollSections';
import { scrollLandingToTop } from './lib/scroll';

const SECTION_IDS = ['hero', 'stack', 'enter', 'security', 'updates'];

export default function App() {
  const [entered, setEntered] = useState(false);
  const scrollRef = useRef<HTMLElement>(null);
  const { activeIndex, scrollToSection } = useScrollSections(SECTION_IDS);

  const isAtBottom = activeIndex === SECTION_IDS.length - 1;
  const isDarkSection = activeIndex === 2 || activeIndex === 4;
  const isFlameSection = activeIndex === 0 || activeIndex === 1 || activeIndex === 3;

  return (
    // LazyMotion + `m.` components load only the animation features the landing
    // uses (domAnimation: animate/whileInView/exit/gestures). The full `motion`
    // import statically bundled the drag + layout-projection subsystems
    // (~90 kB pre-minify) that no live landing component uses. `strict` throws
    // if a full `motion.` component ever sneaks back in. The features load via
    // dynamic import (src/motionFeatures.ts) so they stay out of the critical
    // chunk — see that file for why this can't blank the gate screen.
    <LazyMotion features={() => import('./motionFeatures').then((mod) => mod.default)} strict>
      <GateScreen onEnter={() => setEntered(true)} />

      <LandingNav entered={entered} lightNav={isDarkSection} />

      <ScrollRail
        count={SECTION_IDS.length}
        activeIndex={activeIndex}
        onSelect={scrollToSection}
        visible={entered && !isDarkSection}
        light={isDarkSection}
      />

      <ScrollFooter
        label={isAtBottom ? 'GO TO THE TOP' : 'SCROLL FOR MORE'}
        visible={entered && (isFlameSection || isAtBottom)}
        onAction={isAtBottom ? scrollLandingToTop : undefined}
        compact={isAtBottom}
      />

      <main
        id="landing-scroll"
        ref={scrollRef}
        className={`h-[100dvh] overflow-y-auto snap-y snap-proximity scroll-smooth ${entered ? '' : 'overflow-hidden'}`}
      >
        <HeroSection scrollRef={scrollRef} />
        <StackSection scrollRef={scrollRef} />
        <EnterSection scrollRef={scrollRef} />
        <SecurityStrip scrollRef={scrollRef} />
        <Suspense
          fallback={<section id="updates" className="snap-start snap-always min-h-[100dvh] bg-black" />}
        >
          <UpdatesSection scrollRef={scrollRef} />
        </Suspense>
      </main>
    </LazyMotion>
  );
}
