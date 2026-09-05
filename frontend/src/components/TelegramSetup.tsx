import { useState, type ReactNode } from 'react';
import { useAppStore } from '../stores/appStore';
import { Loader2, AlertCircle, CheckCircle2, ExternalLink, ArrowLeft } from 'lucide-react';
import { cn } from '../lib/utils';
import { ExtLink, Field, INPUT_CLASS, INPUT_MONO_CLASS, StatusBox } from './settings/fields';

type Step = 'credentials' | 'phone' | 'code' | '2fa' | 'success';

// Telegram's own brand blue for the primary action — the one place a literal
// hex is deliberate, since it is the platform's colour rather than ours.
const TG_BUTTON_CLASS =
  'w-full py-cozy bg-[#2AABEE] hover:bg-[#229ED9] disabled:opacity-50 disabled:cursor-not-allowed rounded-oct-sm type-body font-medium text-white transition-colors flex items-center justify-center gap-cozy';

/** Step header: optional back arrow + title. */
function StepHeader({ onBack, children }: { onBack?: () => void; children: ReactNode }) {
  return (
    <div className="flex items-center gap-cozy">
      {onBack && (
        <button type="button" onClick={onBack} className="text-oct-muted hover:text-oct-text p-tight">
          <ArrowLeft size={18} />
        </button>
      )}
      <h2 className="type-title text-oct-text">{children}</h2>
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <StatusBox tone="critical" className="flex items-start gap-cozy type-body">
      <AlertCircle size={16} className="shrink-0 mt-hair" />
      <span>{message}</span>
    </StatusBox>
  );
}

function BusyLabel({ busy, idle, children }: { busy: boolean; idle: string; children: string }) {
  return busy ? (
    <>
      <Loader2 size={16} className="animate-spin" />
      {children}
    </>
  ) : (
    <>{idle}</>
  );
}

export default function TelegramSetup({ onClose }: { onClose?: () => void }) {
  const telegramAuthStart = useAppStore((s) => s.telegramAuthStart);
  const telegramAuthVerify = useAppStore((s) => s.telegramAuthVerify);
  const telegramAuth2FA = useAppStore((s) => s.telegramAuth2FA);

  const [step, setStep] = useState<Step>('credentials');
  const [apiId, setApiId] = useState('');
  const [apiHash, setApiHash] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCredentialsSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiId.trim() || !apiHash.trim() || !phone.trim()) return;
    setLoading(true);
    setError(null);

    const result = await telegramAuthStart(apiId.trim(), apiHash.trim(), phone.trim());
    if (result.success) {
      setStep('code');
    } else {
      setError(result.error ?? 'Failed to start authentication.');
    }
    setLoading(false);
  };

  const handleCodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    setLoading(true);
    setError(null);

    const result = await telegramAuthVerify(code.trim());
    if (result.success) {
      setStep('success');
    } else if (result.needs2FA) {
      setStep('2fa');
    } else {
      setError(result.error ?? 'Invalid verification code.');
    }
    setLoading(false);
  };

  const handle2FASubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) return;
    setLoading(true);
    setError(null);

    const result = await telegramAuth2FA(password.trim());
    if (result.success) {
      setStep('success');
    } else {
      setError(result.error ?? 'Invalid password.');
    }
    setLoading(false);
  };

  return (
    <div className="w-full max-w-md">
      {step === 'credentials' && (
        <form onSubmit={handleCredentialsSubmit} className="space-y-comfy">
          <StepHeader onBack={onClose}>Connect Telegram</StepHeader>

          <p className="type-body text-oct-muted">
            To connect your Telegram account, you need an API ID and API Hash from{' '}
            <ExtLink href="https://my.telegram.org/apps" className="inline-flex items-center gap-tight">
              my.telegram.org <ExternalLink size={12} />
            </ExtLink>
          </p>

          <Field label="API ID">
            <input
              type="text"
              value={apiId}
              onChange={(e) => setApiId(e.target.value)}
              placeholder="12345678"
              disabled={loading}
              className={INPUT_MONO_CLASS}
            />
          </Field>

          <Field label="API Hash">
            <input
              type="password"
              value={apiHash}
              onChange={(e) => setApiHash(e.target.value)}
              placeholder="Your API hash"
              disabled={loading}
              className={INPUT_MONO_CLASS}
            />
          </Field>

          <Field label="Phone Number">
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+1234567890"
              disabled={loading}
              className={INPUT_MONO_CLASS}
            />
          </Field>

          {error && <ErrorBox message={error} />}

          <button
            type="submit"
            disabled={loading || !apiId.trim() || !apiHash.trim() || !phone.trim()}
            className={TG_BUTTON_CLASS}
          >
            <BusyLabel busy={loading} idle="Send Verification Code">Sending code...</BusyLabel>
          </button>
        </form>
      )}

      {step === 'code' && (
        <form onSubmit={handleCodeSubmit} className="space-y-comfy">
          <StepHeader onBack={() => { setStep('credentials'); setError(null); }}>Enter Verification Code</StepHeader>

          <p className="type-body text-oct-muted">
            A verification code has been sent to your Telegram app. Enter it below.
          </p>

          <Field label="Verification Code">
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="12345"
              autoFocus
              disabled={loading}
              className={cn(INPUT_CLASS, 'type-data text-center text-lg tracking-[0.3em]')}
            />
          </Field>

          {error && <ErrorBox message={error} />}

          <button type="submit" disabled={loading || !code.trim()} className={TG_BUTTON_CLASS}>
            <BusyLabel busy={loading} idle="Verify Code">Verifying...</BusyLabel>
          </button>
        </form>
      )}

      {step === '2fa' && (
        <form onSubmit={handle2FASubmit} className="space-y-comfy">
          <StepHeader onBack={() => { setStep('code'); setError(null); }}>Two-Factor Authentication</StepHeader>

          <p className="type-body text-oct-muted">
            Your account has two-factor authentication enabled. Enter your password to continue.
          </p>

          <Field label="Password">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Your 2FA password"
              autoFocus
              disabled={loading}
              className={INPUT_CLASS}
            />
          </Field>

          {error && <ErrorBox message={error} />}

          <button type="submit" disabled={loading || !password.trim()} className={TG_BUTTON_CLASS}>
            <BusyLabel busy={loading} idle="Submit Password">Verifying...</BusyLabel>
          </button>
        </form>
      )}

      {step === 'success' && (
        <div className="text-center space-y-comfy">
          <div className="w-14 h-14 rounded-full bg-oct-good-dim flex items-center justify-center mx-auto">
            <CheckCircle2 size={28} className="text-oct-good" />
          </div>
          <h2 className="type-title text-oct-text">Telegram Connected</h2>
          <p className="type-body text-oct-muted">
            Your Telegram account has been connected. You can now add Telegram chats to your rooms.
          </p>
          {onClose && (
            <button onClick={onClose} className="oct-btn-primary px-roomy py-cozy text-sm">
              Done
            </button>
          )}
        </div>
      )}
    </div>
  );
}
