import { ArrowRight, Globe, LayoutDashboard, Radio, ShieldCheck } from 'lucide-react';
import { AnimatedSection } from './AnimatedSection';
import { APP_CONSOLE_PATH } from '../constants';

export function LaunchConsole() {
  return (
    <section id="console" className="relative py-20 px-6 scroll-mt-14">
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-oct-accent/[0.03] to-transparent pointer-events-none" />

      <div className="relative mx-auto max-w-4xl">
        <AnimatedSection className="text-center mb-10">
          <h2 className="text-2xl sm:text-4xl font-bold text-white">
            Launch the Console
          </h2>
          <p className="mt-3 text-dc-text-muted max-w-xl mx-auto text-sm">
            OCT runs entirely in the browser — no downloads, no installers. Sign in, connect your
            Discord token, and start monitoring alpha from a unified web console.
          </p>
        </AnimatedSection>

        <AnimatedSection delay={0.1}>
          <div className="rounded-xl border border-oct-accent/20 bg-oct-surface p-8 sm:p-10 text-center shadow-oct-glow-sm">
            <div className="flex justify-center mb-6">
              <div className="w-14 h-14 rounded-xl bg-oct-accent-dim border border-oct-accent/30 flex items-center justify-center text-oct-accent">
                <LayoutDashboard size={28} />
              </div>
            </div>

            <h3 className="text-xl font-semibold text-white mb-2">OCT Web Console</h3>
            <p className="text-sm text-dc-text-muted max-w-md mx-auto mb-8">
              Feed, Wallets, and Callers — your onchain terminal, ready in seconds.
            </p>

            <a
              href={APP_CONSOLE_PATH}
              className="inline-flex items-center gap-2 px-8 py-3 rounded-lg bg-oct-accent text-white font-semibold text-sm hover:bg-oct-accent-hover transition-colors shadow-oct-glow"
            >
              Launch Console
              <ArrowRight size={16} />
            </a>

            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-oct-accent-dim border border-oct-accent/20 text-oct-accent text-xs font-semibold">
                <Globe size={12} />
                Web-only · Hosted on Vercel
              </span>
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-semibold">
                <ShieldCheck size={12} />
                AES-256 Encrypted Tokens
              </span>
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-dc-main border border-dc-divider text-dc-text-muted text-xs font-semibold">
                <Radio size={12} />
                Live Discord &amp; Telegram
              </span>
            </div>
          </div>
        </AnimatedSection>
      </div>
    </section>
  );
}
