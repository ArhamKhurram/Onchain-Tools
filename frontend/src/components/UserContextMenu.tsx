import { useEffect, useRef } from 'react';
import { EyeOff, UserX, Copy, MessageSquare, Star, StarOff, VolumeX, Volume2, TrendingUp } from 'lucide-react';
import type { CallerTier } from '../types';
import { BAND_LABELS } from '@oct/shared';
import type { CallerQuality } from '../hooks/useCallerQuality';
import { formatMultiple, formatRate } from '../utils/callerBandStyle';

interface UserContextMenuProps {
  userId: string;
  displayName: string;
  guildId: string | null;
  channelId: string;
  channelName: string;
  guildName: string | null;
  openInDiscordApp: boolean;
  position: { x: number; y: number };
  isHighlighted?: boolean;
  onToggleHighlight?: () => void;
  callerQuality?: CallerQuality;
  onSetCallerTier?: (tier: CallerTier) => void;
  onHide: () => void;
  onHideEverywhere: () => void;
  onCopyId: () => void;
  onClose: () => void;
}

export default function UserContextMenu({
  userId,
  displayName,
  guildName,
  channelName,
  openInDiscordApp,
  position,
  isHighlighted,
  onToggleHighlight,
  callerQuality,
  onSetCallerTier,
  onHide,
  onHideEverywhere,
  onCopyId,
  onClose,
}: UserContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handle = (e: MouseEvent | TouchEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handle);
    document.addEventListener('touchstart', handle);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handle);
      document.removeEventListener('touchstart', handle);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  useEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const pad = 8;
    let x = position.x;
    let y = position.y;
    if (rect.right > window.innerWidth - pad) {
      x = Math.max(pad, window.innerWidth - rect.width - pad);
    }
    if (rect.bottom > window.innerHeight - pad) {
      y = Math.max(pad, window.innerHeight - rect.height - pad);
    }
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
  }, [position]);

  const channelLabel = guildName ? `${guildName} / #${channelName}` : `#${channelName}`;

  return (
    <div
      ref={menuRef}
      className="fixed z-[100] bg-discord-darker rounded-md shadow-[0_8px_16px_rgba(0,0,0,0.24)] py-[6px] px-[6px] min-w-[220px]"
      style={{ left: position.x, top: position.y }}
    >
      <div className="px-2 py-1.5 text-xs text-discord-text-muted truncate border-b border-white/[0.06] mb-1">
        {displayName}
      </div>

      {callerQuality && (
        <>
          {/* The numbers behind the band, so a mute is an informed decision
              rather than a vibe. Only shown once there's a real sample. */}
          {callerQuality.score && callerQuality.score.rated > 0 && (
            <div className="px-2 py-1 text-[10px] text-discord-text-muted leading-relaxed">
              <div className="flex items-center gap-1">
                <TrendingUp size={11} className="shrink-0" />
                <span>
                  {BAND_LABELS[callerQuality.band]} · {callerQuality.score.rated} rated
                  {/* Say which record this is — an in-room band and a global
                      band can legitimately disagree, and an unlabeled number
                      would read as a contradiction. */}
                  {callerQuality.scoreScope === 'room' ? ' · this room' : ''}
                </span>
              </div>
              <div className="pl-4">
                med {formatMultiple(callerQuality.score.medianMultiple)} · 2x{' '}
                {formatRate(callerQuality.score.hitRate2x)} · slop{' '}
                {formatRate(callerQuality.score.slopRate)}
              </div>
            </div>
          )}

          {onSetCallerTier && (
            <div className="flex gap-1 px-2 py-1">
              {([
                { tier: 'muted' as const, label: 'Mute', Icon: VolumeX },
                { tier: 'normal' as const, label: 'Normal', Icon: Volume2 },
                { tier: 'trusted' as const, label: 'Trust', Icon: Star },
              ]).map(({ tier, label, Icon }) => (
                <button
                  key={tier}
                  onClick={() => { onSetCallerTier(tier); onClose(); }}
                  className={`flex-1 flex items-center justify-center gap-1 px-1.5 py-1 text-[11px] rounded-sm transition-colors ${
                    callerQuality.tier === tier
                      ? 'bg-discord-blurple text-white'
                      : 'text-discord-header-secondary hover:bg-discord-blurple/40 hover:text-white'
                  }`}
                  title={`Set ${displayName} to ${label.toLowerCase()}`}
                >
                  <Icon size={12} className="shrink-0" />
                  {label}
                </button>
              ))}
            </div>
          )}
          <div className="border-t border-white/[0.06] my-1 mx-[-2px]" />
        </>
      )}

      <button
        onClick={() => { onHide(); onClose(); }}
        className="w-full flex items-center gap-2 px-2 py-[6px] text-sm text-discord-header-secondary hover:bg-discord-blurple hover:text-white rounded-sm transition-colors text-left"
      >
        <EyeOff size={16} className="shrink-0" />
        <div className="min-w-0">
          <div>Hide User From Channel</div>
          <div className="text-[10px] text-discord-text-muted truncate">{channelLabel}</div>
        </div>
      </button>

      <button
        onClick={() => { onHideEverywhere(); onClose(); }}
        className="w-full flex items-center gap-2 px-2 py-[6px] text-sm text-discord-header-secondary hover:bg-discord-blurple hover:text-white rounded-sm transition-colors text-left"
      >
        <UserX size={16} className="shrink-0" />
        <div className="min-w-0">
          <div>Hide User Everywhere</div>
          <div className="text-[10px] text-discord-text-muted truncate">every channel</div>
        </div>
      </button>

      {onToggleHighlight && (
        <button
          onClick={() => { onToggleHighlight(); onClose(); }}
          className="w-full flex items-center gap-2 px-2 py-[6px] text-sm text-discord-header-secondary hover:bg-discord-blurple hover:text-white rounded-sm transition-colors text-left"
        >
          {isHighlighted ? <StarOff size={16} className="shrink-0" /> : <Star size={16} className="shrink-0" />}
          <span>{isHighlighted ? 'Remove Highlight' : 'Highlight User'}</span>
        </button>
      )}

      <button
        onClick={() => { onCopyId(); onClose(); }}
        className="w-full flex items-center gap-2 px-2 py-[6px] text-sm text-discord-header-secondary hover:bg-discord-blurple hover:text-white rounded-sm transition-colors text-left"
      >
        <Copy size={16} className="shrink-0" />
        <span>Copy User ID</span>
      </button>

      <div className="border-t border-white/[0.06] my-1 mx-[-2px]" />

      <button
        onClick={() => {
          const dmPath = `discord.com/users/${userId}`;
          const url = openInDiscordApp ? `discord://${dmPath}` : `https://${dmPath}`;
          if (openInDiscordApp) {
            window.location.href = url;
          } else {
            window.open(url, '_blank', 'noopener,noreferrer');
          }
          onClose();
        }}
        className="w-full flex items-center gap-2 px-2 py-[6px] text-sm text-discord-header-secondary hover:bg-discord-blurple hover:text-white rounded-sm transition-colors text-left"
      >
        <MessageSquare size={16} className="shrink-0" />
        <span>DM User</span>
      </button>
    </div>
  );
}
