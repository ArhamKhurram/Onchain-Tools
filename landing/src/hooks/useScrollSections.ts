import { useEffect, useState } from 'react';

export function useScrollSections(sectionIds: string[], containerId = 'landing-scroll') {
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    const container = document.getElementById(containerId);
    if (!container) return;

    const handleScroll = () => {
      const mid = container.scrollTop + container.clientHeight * 0.45;
      let idx = 0;
      for (let i = 0; i < sectionIds.length; i++) {
        const el = document.getElementById(sectionIds[i]);
        if (el && el.offsetTop <= mid) idx = i;
      }
      setActiveIndex(idx);
    };

    handleScroll();
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [sectionIds, containerId]);

  const scrollToSection = (index: number) => {
    const el = document.getElementById(sectionIds[index]);
    el?.scrollIntoView({ behavior: 'smooth' });
  };

  return { activeIndex, scrollToSection };
}
