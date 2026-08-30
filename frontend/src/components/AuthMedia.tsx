import { useEffect, useState } from 'react';
import { isHostedMode, getAccessToken } from '../lib/supabase';

const API_ORIGIN = import.meta.env.VITE_API_URL ?? '';

function resolveMediaUrl(src: string): string {
  if (src.startsWith('http://') || src.startsWith('https://')) return src;
  if (src.startsWith('/api/') && API_ORIGIN) return `${API_ORIGIN}${src}`;
  return src;
}

function needsAuthenticatedFetch(src: string): boolean {
  return isHostedMode && src.includes('/api/telegram/');
}

/** Fetch Telegram media/avatars with Bearer auth (img tags cannot send headers). */
function useAuthenticatedMediaUrl(src: string | undefined): string | undefined {
  const [blobUrl, setBlobUrl] = useState<string | undefined>();

  useEffect(() => {
    if (!src) {
      setBlobUrl(undefined);
      return;
    }

    if (!needsAuthenticatedFetch(src)) {
      setBlobUrl(resolveMediaUrl(src));
      return;
    }

    let objectUrl: string | undefined;
    let cancelled = false;

    (async () => {
      try {
        const headers = new Headers();
        const token = await getAccessToken();
        if (token) headers.set('Authorization', `Bearer ${token}`);
        const res = await fetch(resolveMediaUrl(src), { headers, credentials: 'include' });
        if (!res.ok || cancelled) return;
        const blob = await res.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setBlobUrl(objectUrl);
      } catch {
        if (!cancelled) setBlobUrl(undefined);
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src]);

  return blobUrl;
}

interface AuthMediaProps {
  src: string;
  alt?: string;
  className?: string;
  onClick?: () => void;
}

export function AuthImage({ src, alt = '', className, onClick }: AuthMediaProps) {
  const resolved = useAuthenticatedMediaUrl(src);
  if (!resolved) {
    return <span className={`inline-block bg-oct-surface-raised ${className ?? ''}`} aria-hidden />;
  }
  return (
    <img
      src={resolved}
      alt={alt}
      loading="lazy"
      decoding="async"
      className={className}
      onClick={onClick}
    />
  );
}

export function AuthVideo({ src, className }: { src: string; className?: string }) {
  const resolved = useAuthenticatedMediaUrl(src);
  if (!resolved) return null;
  return <video src={resolved} controls preload="none" className={className} />;
}

export function AuthAudio({
  src,
  type,
  className,
}: {
  src: string;
  type?: string;
  className?: string;
}) {
  const resolved = useAuthenticatedMediaUrl(src);
  if (!resolved) return null;
  return (
    <audio controls preload="none" className={className}>
      {type ? <source src={resolved} type={type} /> : null}
    </audio>
  );
}
