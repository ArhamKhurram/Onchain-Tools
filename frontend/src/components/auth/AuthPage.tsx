import { useState } from 'react';
import { Loader2, AlertCircle, Mail, Lock, ArrowLeft } from 'lucide-react';
import { getSupabase } from '../../lib/supabase';
import { consoleOriginPath } from '../../lib/routes';
import { cn } from '../../lib/utils';
import {
  AnimatePresence,
  fadeInUp,
  m,
  MotionFeatures,
  useStagger,
  useTransition,
} from '../../lib/motion';
import OctLogo from '../OctLogo';

// ── Reference implementation for the design-token + motion foundation ─────────
// This is the worked example for the system introduced alongside it, and the
// pattern later screens should copy. Three things are on show:
//
//  1. NAMED DENSITY over ad-hoc numbers. `p-section`, `gap-cozy`, `mb-roomy`
//     instead of `p-6`, `gap-2`, `mb-4`. The value is the same; the intent is
//     now legible, and the whole console can be retuned from the
//     `--oct-space-*` variables without touching a component.
//  2. SEMANTIC STATUS COLOUR over the brand accent. The auth error used to
//     render in `oct-accent` — which in the dark theme is a red, so a failed
//     login and the primary button were the same colour. It is now
//     `oct-critical`, and the success message is `oct-good`.
//  3. MOTION ON CHROME ONLY. A staggered entrance, a crossfade when the view
//     switches, and a collapse for the alerts. Nothing here streams, nothing
//     here is virtualised — which is precisely why it is allowed to animate.
//     See the rule at the top of lib/motion.ts.
//
// Motion arrives through the lazily-loaded LoginPage chunk, so the animation
// runtime stays off the boot path.

type AuthView = 'login' | 'signup' | 'forgot';

const HEADINGS: Record<AuthView, { title: string; blurb: string }> = {
  login: {
    title: 'Welcome back',
    blurb: 'Sign in to sync rooms and settings across devices.',
  },
  signup: {
    title: 'Create account',
    blurb: 'Create an account to get started.',
  },
  forgot: {
    title: 'Reset password',
    blurb: "Enter your email and we'll send a reset link.",
  },
};

const SUBMIT_LABELS: Record<AuthView, { idle: string; busy: string }> = {
  login: { idle: 'Sign in', busy: 'Signing in...' },
  signup: { idle: 'Create account', busy: 'Creating account...' },
  forgot: { idle: 'Send reset link', busy: 'Sending...' },
};

/** Shared shell for both text fields. Static, so it is a constant, not a call. */
const FIELD_CLASS = 'w-full pl-9 pr-comfy py-cozy oct-input type-body disabled:opacity-50';

/**
 * The two status blocks differ only in their semantic colour, which is the
 * shape `cn` exists for — one layout, a tone picked at runtime, no duplicated
 * class string to drift. It also shows the colour split doing real work: an
 * error is `oct-critical` and a success is `oct-good`, neither of them the
 * brand accent that both used to borrow.
 */
const alertClass = (tone: 'critical' | 'good') =>
  cn(
    'flex items-start gap-cozy px-comfy py-cozy rounded-oct border type-body',
    tone === 'critical' && 'bg-oct-critical-dim border-oct-critical/50 text-oct-critical',
    tone === 'good' && 'bg-oct-good-dim border-oct-good/50 text-oct-good',
  );

/** Alert boxes collapse in and out rather than snapping the form taller. */
const collapse = {
  initial: { opacity: 0, height: 0 },
  animate: { opacity: 1, height: 'auto' as const },
  exit: { opacity: 0, height: 0 },
};

const errorMessage = (err: unknown, fallback: string) =>
  err instanceof Error ? err.message : fallback;

export default function AuthPage({ onAuth }: { onAuth: () => void }) {
  const [view, setView] = useState<AuthView>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // Both resolve to an instant transition under `prefers-reduced-motion`.
  const enter = useTransition('snappy');
  const swap = useTransition('fade');
  const stagger = useStagger();

  const supabase = getSupabase();

  const goTo = (next: AuthView) => {
    setView(next);
    setError(null);
    setMessage(null);
  };

  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || (!password.trim() && view !== 'forgot')) return;

    setLoading(true);
    setError(null);
    setMessage(null);

    try {
      if (view === 'forgot') {
        const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
          redirectTo: `${window.location.origin}${consoleOriginPath('/')}`,
        });
        if (error) throw error;
        setMessage('Password reset link sent. Check your email.');
        setLoading(false);
        return;
      }

      if (view === 'signup') {
        const { error } = await supabase.auth.signUp({
          email: email.trim(),
          password: password.trim(),
          options: {
            emailRedirectTo: `${window.location.origin}${consoleOriginPath('/')}`,
          },
        });
        if (error) throw error;
        setMessage('Account created! Check your email to confirm, then sign in.');
        setView('login');
        setLoading(false);
        return;
      }

      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password: password.trim(),
      });
      if (error) throw error;
      onAuth();
    } catch (err: unknown) {
      setError(errorMessage(err, 'Authentication failed.'));
    }
    setLoading(false);
  };

  const handleDiscordOAuth = async () => {
    setLoading(true);
    setError(null);
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'discord',
        options: { redirectTo: `${window.location.origin}${consoleOriginPath('/')}` },
      });
      if (error) throw error;
    } catch (err: unknown) {
      const msg = errorMessage(err, 'OAuth failed.');
      if (msg.includes('provider is not enabled')) {
        setError(
          'Discord sign-in is not enabled on this Supabase project yet. ' +
          'Enable it under Authentication → Providers → Discord, or use email/password for now.',
        );
      } else {
        setError(msg);
      }
      setLoading(false);
    }
  };

  const heading = HEADINGS[view];
  const submit = SUBMIT_LABELS[view];

  return (
    <div className="relative flex items-center justify-center min-h-full w-full bg-oct-bg py-gutter px-roomy overflow-hidden">
      {/* Ambient brand glow behind the card. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-32 left-1/2 -translate-x-1/2 h-80 w-80 rounded-full bg-oct-accent/20 blur-[130px]"
      />
      {/* The stagger parent. Children below opt in with `variants={fadeInUp}`;
          each one waits 40ms on the last, which reads as a single considered
          movement rather than a queue. */}
      <MotionFeatures>
        <m.div
          variants={stagger}
          initial="hidden"
          animate="visible"
          className="relative w-full max-w-md"
        >
          <m.div
            variants={fadeInUp}
            transition={enter}
            className="flex flex-col items-center mb-section"
          >
            <p className="oct-eyebrow mb-roomy">OCT</p>
            <OctLogo size="lg" showSubtitle className="mb-cozy" />
            {/* `initial={false}` keeps this out of the first paint — it plays only
                when the user switches view, so it never double-animates with the
                entrance above. */}
            <AnimatePresence mode="wait" initial={false}>
              <m.div
                key={view}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={swap}
                className="flex flex-col items-center"
              >
                <h1 className="font-display type-heading sm:type-display text-oct-text tracking-tight mb-cozy mt-comfy">
                  {heading.title}
                </h1>
                <p className="font-mono type-label sm:type-body font-normal text-oct-muted text-center leading-relaxed">
                  {heading.blurb}
                </p>
              </m.div>
            </AnimatePresence>
          </m.div>

          <m.div variants={fadeInUp} transition={enter} className="oct-card p-section">
            {view !== 'forgot' && (
              <>
                <button
                  onClick={handleDiscordOAuth}
                  disabled={loading}
                  className="w-full py-cozy rounded-oct border border-[#5865F2]/50 bg-[#5865F2] hover:bg-[#4752c4] disabled:opacity-50 disabled:cursor-not-allowed shadow-oct-soft hover:shadow-oct-soft-lg transition-all duration-fast type-body font-bold uppercase tracking-wide text-white flex items-center justify-center gap-cozy mb-roomy"
                >
                  <svg width="20" height="20" viewBox="0 0 71 55" fill="white">
                    <path d="M60.1 4.9A58.5 58.5 0 0045.4.2a.2.2 0 00-.2.1 40.7 40.7 0 00-1.8 3.7 54 54 0 00-16.2 0A26.4 26.4 0 0025.4.3a.2.2 0 00-.2-.1 58.4 58.4 0 00-14.7 4.6.2.2 0 00-.1 0A59.7 59.7 0 00.2 43.6a.2.2 0 000 .2 58.8 58.8 0 0017.7 9 .2.2 0 00.3-.1 42 42 0 003.6-5.9.2.2 0 00-.1-.3 38.8 38.8 0 01-5.5-2.6.2.2 0 010-.4l1.1-.9a.2.2 0 01.2 0 42 42 0 0035.6 0 .2.2 0 01.2 0l1.1.9a.2.2 0 010 .3 36.4 36.4 0 01-5.5 2.7.2.2 0 00-.1.3 47.2 47.2 0 003.6 5.9.2.2 0 00.3 0A58.6 58.6 0 0070.6 43.8a.2.2 0 000-.2A59.2 59.2 0 0060.2 5a.2.2 0 00-.1 0zM23.7 35.8c-3.4 0-6.2-3.1-6.2-7s2.7-7 6.2-7 6.3 3.2 6.2 7-2.8 7-6.2 7zm22.9 0c-3.4 0-6.2-3.1-6.2-7s2.7-7 6.2-7 6.3 3.2 6.2 7-2.7 7-6.2 7z" />
                  </svg>
                  Continue with Discord
                </button>

                <div className="relative my-section">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-oct-border" />
                  </div>
                  <div className="relative flex justify-center">
                    <span className="bg-oct-elevated px-comfy text-oct-muted uppercase tracking-wider font-mono type-label">
                      or
                    </span>
                  </div>
                </div>
              </>
            )}

            <form onSubmit={handleEmailAuth} className="space-y-roomy">
              <div>
                <label htmlFor="email" className="type-label block text-oct-muted mb-cozy uppercase tracking-wide">
                  Email
                </label>
                <div className="relative">
                  <Mail size={16} className="absolute left-comfy top-1/2 -translate-y-1/2 text-oct-muted" />
                  <input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    autoComplete="email"
                    autoFocus
                    disabled={loading}
                    className={FIELD_CLASS}
                  />
                </div>
              </div>

              {view !== 'forgot' && (
                <div>
                  <label htmlFor="password" className="type-label block text-oct-muted mb-cozy uppercase tracking-wide">
                    Password
                  </label>
                  <div className="relative">
                    <Lock size={16} className="absolute left-comfy top-1/2 -translate-y-1/2 text-oct-muted" />
                    <input
                      id="password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={view === 'signup' ? 'Create a password (min 6 chars)' : 'Enter your password'}
                      autoComplete={view === 'signup' ? 'new-password' : 'current-password'}
                      disabled={loading}
                      className={FIELD_CLASS}
                    />
                  </div>
                </div>
              )}

              {/* Status blocks. `oct-critical` / `oct-good` rather than the accent —
                  the accent is a red in this theme, so an error styled with it was
                  indistinguishable from branded chrome. */}
              <AnimatePresence initial={false}>
                {error && (
                  <m.div key="error" {...collapse} transition={swap} className="overflow-hidden">
                    <div
                      role="alert"
                      className={alertClass('critical')}
                    >
                      <AlertCircle size={16} className="shrink-0 mt-0.5" />
                      <span>{error}</span>
                    </div>
                  </m.div>
                )}

                {message && (
                  <m.div key="message" {...collapse} transition={swap} className="overflow-hidden">
                    <div
                      role="status"
                      className={alertClass('good')}
                    >
                      <span>{message}</span>
                    </div>
                  </m.div>
                )}
              </AnimatePresence>

              <button
                type="submit"
                disabled={loading || !email.trim() || (view !== 'forgot' && !password.trim())}
                className="oct-btn-primary w-full py-cozy type-body"
              >
                {loading ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    {submit.busy}
                  </>
                ) : (
                  submit.idle
                )}
              </button>
            </form>
          </m.div>

          <m.div
            variants={fadeInUp}
            transition={enter}
            className="mt-section text-center type-body text-oct-muted space-y-cozy"
          >
            {view === 'login' && (
              <>
                <button onClick={() => goTo('forgot')} className="hover:text-oct-text transition-colors duration-fast">
                  Forgot password?
                </button>
                <p>
                  Don&apos;t have an account?{' '}
                  <button onClick={() => goTo('signup')} className="text-oct-accent hover:underline">
                    Sign up
                  </button>
                </p>
              </>
            )}
            {view === 'signup' && (
              <p>
                Already have an account?{' '}
                <button onClick={() => goTo('login')} className="text-oct-accent hover:underline">
                  Sign in
                </button>
              </p>
            )}
            {view === 'forgot' && (
              <button
                onClick={() => goTo('login')}
                className="inline-flex items-center gap-tight hover:text-oct-text transition-colors duration-fast"
              >
                <ArrowLeft size={14} />
                Back to sign in
              </button>
            )}
          </m.div>
        </m.div>
      </MotionFeatures>
    </div>
  );
}
