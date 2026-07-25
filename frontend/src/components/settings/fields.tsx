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

export   const Toggle = ({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) => (
    <label className="flex items-start gap-3 cursor-pointer">
      <div
        className={`w-10 h-5 rounded-full transition-colors relative shrink-0 mt-0.5 ${value ? 'bg-discord-green' : 'bg-discord-input'}`}
        onClick={() => onChange(!value)}
      >
        <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform ${value ? 'translate-x-5' : 'translate-x-0.5'}`} />
      </div>
      <span className="text-xs sm:text-sm text-discord-text leading-snug">{label}</span>
    </label>
  );
