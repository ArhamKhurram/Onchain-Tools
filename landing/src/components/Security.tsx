import { ShieldCheck, Lock, EyeOff, ExternalLink, Shield, Cloud } from 'lucide-react';
import { AnimatedSection } from './AnimatedSection';

export function Security() {
  return (
    <section id="security" className="relative py-20 px-6 scroll-mt-14">
      <div className="mx-auto max-w-4xl">
        <AnimatedSection className="text-center mb-12">
          <h2 className="text-2xl sm:text-4xl font-bold text-white">
            Your Tokens Are Safe
          </h2>
          <p className="mt-3 text-dc-text-muted max-w-xl mx-auto text-sm">
            Onchain Tools takes credential security seriously. Your Discord tokens, Telegram sessions,
            API keys, and all sensitive data are encrypted and never stored in plain text.
          </p>
        </AnimatedSection>

        <AnimatedSection delay={0.1}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="bg-dc-sidebar rounded-lg border border-dc-divider p-6 flex flex-col gap-3">
              <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-400">
                <Lock size={20} />
              </div>
              <h3 className="font-semibold text-white text-sm">AES-256-GCM Encryption</h3>
              <p className="text-xs text-dc-text-muted leading-relaxed">
                Every Discord token, Telegram session string, API ID, and API hash is encrypted at rest using AES-256-GCM — the same standard used by banks and governments.
              </p>
            </div>

            <div className="bg-dc-sidebar rounded-lg border border-dc-divider p-6 flex flex-col gap-3">
              <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-400">
                <EyeOff size={20} />
              </div>
              <h3 className="font-semibold text-white text-sm">Never Stored in Plain Text</h3>
              <p className="text-xs text-dc-text-muted leading-relaxed">
                All credentials are encrypted before they reach the database. Your Telegram phone number and 2FA password are never stored or logged — they exist only in memory during the auth handshake.
              </p>
            </div>

            <div className="bg-dc-sidebar rounded-lg border border-dc-divider p-6 flex flex-col gap-3">
              <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-400">
                <Shield size={20} />
              </div>
              <h3 className="font-semibold text-white text-sm">Server Hardening</h3>
              <p className="text-xs text-dc-text-muted leading-relaxed">
                Helmet security headers, API rate limiting, strict CORS policies, and JWT-authenticated WebSockets protect every request.
              </p>
            </div>

            <div className="bg-dc-sidebar rounded-lg border border-dc-divider p-6 flex flex-col gap-3">
              <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-400">
                <ShieldCheck size={20} />
              </div>
              <h3 className="font-semibold text-white text-sm">Open Source & Auditable</h3>
              <p className="text-xs text-dc-text-muted leading-relaxed">
                Don&apos;t just trust it — verify it. The entire encryption implementation is open source. Inspect every line yourself.
              </p>
            </div>
          </div>
        </AnimatedSection>

        <AnimatedSection delay={0.15} className="mt-4">
          <div className="bg-dc-sidebar rounded-lg border border-dc-divider p-6 flex items-start gap-4">
            <div className="w-10 h-10 rounded-lg bg-oct-accent-dim flex items-center justify-center text-oct-accent shrink-0">
              <Cloud size={20} />
            </div>
            <div>
              <h3 className="font-semibold text-white text-sm">Hosted on Vercel</h3>
              <p className="text-xs text-dc-text-muted leading-relaxed mt-1">
                OCT runs as a secure web application. Your encrypted credentials are stored in a
                managed database with row-level security — accessible only to your authenticated account.
              </p>
            </div>
          </div>
        </AnimatedSection>
      </div>
    </section>
  );
}
