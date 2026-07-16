import { useEffect, useState } from 'react';
import { isHostedMode, getSupabase } from '../lib/supabase';
import type { Session, User } from '@supabase/supabase-js';

export function useAuthSession() {
  const [ready, setReady] = useState(!isHostedMode);
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    if (!isHostedMode) {
      setReady(true);
      return;
    }

    const supabase = getSupabase();
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setUser(data.session?.user ?? null);
      setReady(true);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setUser(next?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  return {
    ready,
    session,
    user,
    userId: user?.id,
    isAuthenticated: isHostedMode ? !!session : true,
  };
}
