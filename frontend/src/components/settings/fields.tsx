import { isHostedMode, getAccessToken } from '../../lib/supabase';

export   const apiBase = import.meta.env.VITE_API_URL
    ? `${import.meta.env.VITE_API_URL}/api`
    : '/api';

export   const authedFetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (isHostedMode) {
      const token = await getAccessToken();
      if (token) headers.set('Authorization', `Bearer ${token}`);
    }
    return fetch(input, { ...init, headers });
  };

/* Premium pill toggle — accent-tinted track, soft knob shadow. Shared across
   every settings section and the sniper rule form. */
export   const Toggle = ({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) => (
    <label className="flex items-start gap-3 cursor-pointer group">
      <div
        className={`w-10 h-5 rounded-full border transition-colors duration-150 relative shrink-0 mt-0.5 ${value ? 'bg-oct-green border-oct-green/60' : 'bg-oct-surface-raised border-oct-border group-hover:border-oct-border-bright'}`}
        onClick={() => onChange(!value)}
      >
        <div className={`absolute top-0.5 w-3.5 h-3.5 rounded-full transition-transform duration-150 shadow-sm ${value ? 'translate-x-[22px] bg-white' : 'translate-x-0.5 bg-oct-text'}`} />
      </div>
      <span className="text-sm text-oct-text leading-snug">{label}</span>
    </label>
  );
