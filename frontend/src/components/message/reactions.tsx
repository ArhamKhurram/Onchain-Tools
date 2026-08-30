import { useState, useEffect, useRef } from 'react';
import type { FrontendMessage, FrontendReaction, ReactionUser } from '../../types';
import { useAppStore } from '../../stores/appStore';
import { getAvatarUrl } from './avatar';

function ReactionUserList({ users, loading, error }: { users: ReactionUser[]; loading: boolean; error: boolean }) {
  if (loading) return <div className="px-2 py-1.5 text-discord-text-muted">Loading…</div>;
  if (error) return <div className="px-2 py-1.5 text-red-400">Failed to load</div>;
  if (users.length === 0) return <div className="px-2 py-1.5 text-discord-text-muted">No users</div>;
  return (
    <div className="max-h-48 overflow-y-auto">
      {users.map((u) => (
        <div key={u.id} className="flex items-center gap-2 px-2 py-1">
          <img
            src={getAvatarUrl(u.id, u.avatar, u.discriminator)}
            alt=""
            loading="lazy"
            decoding="async"
            className="w-5 h-5 rounded-full flex-shrink-0"
          />
          <span className="truncate text-discord-text">{u.displayName}</span>
        </div>
      ))}
    </div>
  );
}

function ReactionPills({ message }: { message: FrontendMessage }) {
  const reactions = message.reactions;
  // Only Discord exposes a per-user reaction list via the REST API.
  const clickable = message.source !== 'telegram';
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [users, setUsers] = useState<ReactionUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (openIndex === null) return;
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpenIndex(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [openIndex]);

  if (!reactions || reactions.length === 0) return null;

  const handleClick = async (index: number, emoji: FrontendReaction['emoji']) => {
    if (openIndex === index) {
      setOpenIndex(null);
      return;
    }
    setOpenIndex(index);
    setLoading(true);
    setError(false);
    setUsers([]);
    try {
      const result = await useAppStore.getState().fetchReactionUsers(message.channelId, message.id, emoji);
      setUsers(result);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div ref={containerRef} className="flex flex-wrap gap-1 mt-0.5">
      {reactions.map((r, i) => {
        const emojiContent = r.emoji.id ? (
          <img
            src={`https://cdn.discordapp.com/emojis/${r.emoji.id}.${r.emoji.animated ? 'gif' : 'webp'}?size=16`}
            alt={r.emoji.name}
            loading="lazy"
            decoding="async"
            className="w-4 h-4"
          />
        ) : (
          <span className="text-sm leading-none">{r.emoji.name}</span>
        );
        const pillInner = (
          <>
            {emojiContent}
            <span>{r.count}</span>
          </>
        );
        const pillClass = 'inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-discord-embed-bg text-discord-text-muted text-xs border border-transparent transition-colors';
        if (!clickable) {
          return (
            <span key={`${r.emoji.id ?? r.emoji.name}-${i}`} className={pillClass} title={r.emoji.name}>
              {pillInner}
            </span>
          );
        }
        return (
          <span key={`${r.emoji.id ?? r.emoji.name}-${i}`} className="relative">
            <button
              type="button"
              onClick={() => handleClick(i, r.emoji)}
              className={`${pillClass} cursor-pointer hover:border-discord-text-muted/30 ${openIndex === i ? 'border-discord-text-muted/50' : ''}`}
              title={`See who reacted with ${r.emoji.name}`}
            >
              {pillInner}
            </button>
            {openIndex === i && (
              <div className="absolute z-50 bottom-full mb-1 left-0 min-w-[10rem] max-w-[16rem] rounded-md border border-discord-border bg-discord-dark shadow-lg py-1 text-xs">
                <div className="px-2 pb-1 mb-1 border-b border-discord-border text-discord-text-muted flex items-center gap-1">
                  <span>Reacted with</span>
                  {emojiContent}
                </div>
                <ReactionUserList users={users} loading={loading} error={error} />
              </div>
            )}
          </span>
        );
      })}
    </div>
  );
}

export { ReactionPills };
