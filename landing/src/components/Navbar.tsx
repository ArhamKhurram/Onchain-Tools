import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Menu, X, Hash, ArrowRight } from 'lucide-react';
import { OctLogo } from './OctLogo';
import { APP_CONSOLE_PATH } from '../constants';

const navLinks: { label: string; href: string; external?: boolean }[] = [
  { label: 'Features', href: '#features' },
  { label: 'Console', href: '#console' },
  { label: 'Security', href: '#security' },
  { label: 'Setup', href: '#setup' },
  { label: 'Changelog', href: '#changelog' },
];

export function Navbar() {
  const [activeSection, setActiveSection] = useState('');
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 20);

      const els = navLinks
        .filter((l) => !l.external)
        .map((l) => document.getElementById(l.href.slice(1)))
        .filter((el): el is HTMLElement => el !== null);

      const nearBottom =
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 300;
      if (nearBottom && els.length) {
        const last = els.reduce((a, b) => (a.offsetTop > b.offsetTop ? a : b));
        setActiveSection(last.id);
        return;
      }

      let current = '';
      let currentTop = -Infinity;
      for (const el of els) {
        const top = el.getBoundingClientRect().top;
        if (top <= 120 && top > currentTop) {
          currentTop = top;
          current = el.id;
        }
      }
      setActiveSection(current);
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>, href: string) => {
    e.preventDefault();
    setMobileOpen(false);
    window.history.pushState(null, '', href);
    const el = document.querySelector(href);
    el?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <motion.nav
      initial={{ y: -80 }}
      animate={{ y: 0 }}
      transition={{ duration: 0.4, ease: [0.25, 0.4, 0.25, 1] }}
      className={`fixed top-0 left-0 right-0 z-50 transition-colors duration-200 border-b ${
        scrolled || mobileOpen
          ? 'bg-oct-surface/95 border-oct-border shadow-lg shadow-black/40 backdrop-blur-sm'
          : 'bg-oct-surface/80 border-transparent'
      }`}
    >
      <div className="mx-auto max-w-6xl h-12 px-4 flex items-center justify-between">
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setMobileOpen(false);
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
          className="hover:opacity-90 transition-opacity"
        >
          <OctLogo size="sm" showSubtitle />
        </a>

        <div className="hidden sm:flex items-center gap-1">
          {navLinks.map((link) => {
            const isActive = !link.external && activeSection === link.href.slice(1);
            return (
              <a
                key={link.href}
                href={link.href}
                {...(link.external
                  ? { target: '_blank', rel: 'noopener noreferrer' }
                  : { onClick: (e: React.MouseEvent<HTMLAnchorElement>) => handleClick(e, link.href) }
                )}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors ${
                  isActive
                    ? 'bg-oct-accent-dim text-oct-accent'
                    : 'text-dc-text-muted hover:text-dc-text hover:bg-dc-hover/50'
                }`}
              >
                <Hash size={14} className="text-dc-channel-icon" />
                {link.label.toLowerCase()}
              </a>
            );
          })}
          <div className="w-px h-5 bg-dc-divider mx-2" />
          <a
            href={APP_CONSOLE_PATH}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-oct-accent text-white text-sm font-medium hover:bg-oct-accent-hover transition-colors shadow-oct-glow-sm"
          >
            Launch Console
            <ArrowRight size={14} />
          </a>
        </div>

        <button
          onClick={() => setMobileOpen(!mobileOpen)}
          className="sm:hidden text-dc-text-muted hover:text-dc-text transition-colors"
          aria-label="Toggle menu"
        >
          {mobileOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
      </div>

      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="sm:hidden overflow-hidden border-t border-dc-divider bg-oct-surface"
          >
            <div className="px-4 py-3 flex flex-col gap-1">
              {navLinks.map((link) => {
                const isActive = !link.external && activeSection === link.href.slice(1);
                return (
                  <a
                    key={link.href}
                    href={link.href}
                    {...(link.external
                      ? { target: '_blank', rel: 'noopener noreferrer' }
                      : { onClick: (e: React.MouseEvent<HTMLAnchorElement>) => handleClick(e, link.href) }
                    )}
                    className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors ${
                      isActive
                        ? 'bg-oct-accent-dim text-oct-accent'
                        : 'text-dc-text-muted hover:text-dc-text hover:bg-dc-hover/50'
                    }`}
                  >
                    <Hash size={14} className="text-dc-channel-icon" />
                    {link.label.toLowerCase()}
                  </a>
                );
              })}
              <a
                href={APP_CONSOLE_PATH}
                className="flex items-center justify-center gap-2 px-3 py-2.5 mt-2 rounded-md bg-oct-accent text-white text-sm font-medium hover:bg-oct-accent-hover transition-colors"
              >
                Launch Console
                <ArrowRight size={14} />
              </a>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.nav>
  );
}
