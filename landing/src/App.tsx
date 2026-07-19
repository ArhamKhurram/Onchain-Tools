import { useState } from 'react';
import { GateScreen } from './components/landing/GateScreen';
import { LandingNav } from './components/landing/LandingNav';
import { HeroSection } from './components/landing/HeroSection';
import { StackSection } from './components/landing/StackSection';
import { EnterSection } from './components/landing/EnterSection';
import { SecurityStrip } from './components/landing/SecurityStrip';
import { ScrollRail } from './components/landing/ScrollRail';
import { ScrollFooter } from './components/landing/ScrollFooter';
import { useScrollSections } from './hooks/useScrollSections';

const SECTION_IDS = ['hero', 'stack', 'enter', 'security'];

export default function App() {
  const [entered, setEntered] = useState(false);
  const { activeIndex, scrollToSection } = useScrollSections(SECTION_IDS);

  const scrollToTop = () => {
    const container = document.getElementById('landing-scroll');
    container?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const isAtBottom = activeIndex === SECTION_IDS.length - 1;
  const isEnterSection = activeIndex === 2;
  const isFlameSection = activeIndex === 0 || activeIndex === 1 || activeIndex === 3;

  return (
    <>
      <GateScreen onEnter={() => setEntered(true)} />

      <LandingNav entered={entered} lightNav={isEnterSection} />

      <ScrollRail
        count={SECTION_IDS.length}
        activeIndex={activeIndex}
        onSelect={scrollToSection}
        visible={entered && !isEnterSection}
        light={isEnterSection}
      />

      <ScrollFooter
        label={isAtBottom ? 'GO TO THE TOP' : 'SCROLL FOR MORE'}
        visible={entered && isFlameSection}
        onAction={isAtBottom ? scrollToTop : undefined}
        compact={isAtBottom}
      />

      <main
        id="landing-scroll"
        className={`h-[100dvh] overflow-y-auto snap-y snap-proximity scroll-smooth ${entered ? '' : 'overflow-hidden'}`}
      >
        <HeroSection />
        <StackSection />
        <EnterSection />
        <SecurityStrip />
      </main>
    </>
  );
}
