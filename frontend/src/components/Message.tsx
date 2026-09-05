import { useState, memo } from 'react';
import { Eye, MessageSquareReply } from 'lucide-react';
import type { FrontendMessage, ContractLinkTemplates, ContractClickAction, BadgeClickAction, HighlightMode, MessageDisplay, CallerTier } from '../types';
import type { CallerQuality } from '../hooks/useCallerQuality';
import { BAND_NAME_COLOR, BAND_BADGE_CLASS, BAND_TITLE, bandIsNotable } from '../utils/callerBandStyle';
import { BAND_LABELS } from '@oct/shared';
import { useAppStore } from '../stores/appStore';
import { AuthImage } from './AuthMedia';
import ImageLightbox from './ImageLightbox';
import UserContextMenu from './UserContextMenu';
import { buildContractUrl, DEFAULT_LINK_TEMPLATES } from '../utils/contractUrl';
import { requestMessageJump } from '../utils/messageListWindow';
import { colorWithExtraAlpha } from './ColorPickerWithAlpha';
import { getAvatarUrl, formatTimestamp } from './message/avatar';
import { type AddressColors, renderContent, renderInlineMarkdown } from './message/content';
import { ReactionPills } from './message/reactions';
import { TelegramExtras } from './message/TelegramExtras';
import { DeletedBadge, EditedIndicator } from './message/badges';
import { MessageAttachments } from './message/MessageAttachments';
import { MessageEmbeds } from './message/MessageEmbeds';
import { DEFAULT_FEED_ROW_DENSITY, FEED_ROW_DENSITY_STYLE, type FeedRowDensity } from './feed/feedChromeContract';

interface MessageProps {
  message: FrontendMessage;
  isCompact: boolean;
  messageDisplay?: MessageDisplay;
  compactModeAvatars?: boolean;
  guildColor?: string;
  highlightMode?: HighlightMode;
  highlightColor?: string;
  disableEmbeds?: boolean;
  evmAddressColor?: string;
  solAddressColor?: string;
  contractLinkTemplates?: ContractLinkTemplates;
  contractClickAction?: ContractClickAction;
  showFullContractAddress?: boolean;
  openInDiscordApp?: boolean;
  openInTelegramApp?: boolean;
  badgeClickAction?: BadgeClickAction;
  onHideUser?: (guildId: string | null, channelId: string, userId: string, displayName: string) => void;
  onHideUserEverywhere?: (userId: string, displayName: string) => void;
  onToggleHighlight?: (userId: string, displayName: string) => void;
  isUserHighlighted?: boolean;
  onFocus?: (guildId: string | null, channelId: string, guildName: string | null, channelName: string) => void;
  isFocused?: boolean;
  onQuickReply?: (channelId: string) => void;
  chattingEnabled?: boolean;
  roleColors?: boolean;
  /** Caller quality for this author, if scoring is available. */
  callerQuality?: CallerQuality;
  onSetCallerTier?: (key: string, displayName: string, tier: CallerTier) => void;
  /**
   * Row packing chosen by the Feed chrome preset. Resolved ONCE by the pane
   * and passed down — never read from context here, because this row renders
   * per WebSocket frame inside a virtualised list.
   */
  density?: FeedRowDensity;
}

function Message({ message, isCompact, messageDisplay = 'default', compactModeAvatars = true, guildColor, highlightMode = 'background', highlightColor, disableEmbeds, evmAddressColor, solAddressColor, contractLinkTemplates, contractClickAction, showFullContractAddress = false, openInDiscordApp, openInTelegramApp, badgeClickAction, onHideUser, onHideUserEverywhere, onToggleHighlight, isUserHighlighted, onFocus, isFocused, onQuickReply, chattingEnabled, roleColors = true, callerQuality, onSetCallerTier, density = DEFAULT_FEED_ROW_DENSITY }: MessageProps) {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  // One static-table lookup per render; the fragments are prebuilt strings.
  const d = FEED_ROW_DENSITY_STYLE[density];
  const addrColors: AddressColors = { evm: evmAddressColor ?? '#fee75c', sol: solAddressColor ?? '#14f195' };
  const templates: ContractLinkTemplates = contractLinkTemplates ?? DEFAULT_LINK_TEMPLATES;
  const clickAct: ContractClickAction = contractClickAction ?? 'copy_open';
  const showFull = showFullContractAddress;
  const [copied, setCopied] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  const copyUserId = () => {
    navigator.clipboard.writeText(message.author.id);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Bound to BOTH onClick and onContextMenu: left-click is the long-standing
  // affordance, but "right-click a name" is what people reach for first, and
  // without this they got the browser's own menu instead. preventDefault is
  // what suppresses that native menu.
  const handleNameClick = (e: React.MouseEvent) => {
    e.preventDefault();
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    setContextMenu({ x: rect.left, y: rect.bottom + 4 });
  };

  const useUsernameHighlight = highlightMode === 'username';
  const hasKeywordMatch = (message.matchedKeywords?.length ?? 0) > 0;
  const resolvedHighlightColor = highlightColor || '#5865f2';
  const hasCustomColor = !!highlightColor;
  const effectiveHighlighted = message.isHighlighted || isUserHighlighted;

  // An explicit highlight is a deliberate choice and outranks the earned band;
  // the band only colours names the user hasn't already claimed.
  const bandNameColor = callerQuality ? BAND_NAME_COLOR[callerQuality.band] : null;
  const authorNameColor = effectiveHighlighted
    ? resolvedHighlightColor
    : (bandNameColor ?? (roleColors && message.author.roleColor ? message.author.roleColor : 'rgb(var(--oct-text))'));

  const highlightClass = effectiveHighlighted
    ? useUsernameHighlight
      ? hasCustomColor ? 'border-l-2' : 'border-l-2 border-oct-accent'
      : hasCustomColor ? 'border-l-2' : 'border-l-2 border-oct-accent bg-oct-accent-dim'
    : hasKeywordMatch
      ? 'border-l-2 border-oct-accent bg-oct-accent-dim'
      : '';

  const highlightInlineStyle: React.CSSProperties = {};
  if (effectiveHighlighted && hasCustomColor) {
    highlightInlineStyle.borderColor = resolvedHighlightColor;
    if (!useUsernameHighlight) {
      highlightInlineStyle.backgroundColor = colorWithExtraAlpha(resolvedHighlightColor, 0.082);
    }
  }

  const bgStyle = guildColor ? { backgroundColor: guildColor, ...highlightInlineStyle } : highlightInlineStyle;

  const isTelegram = message.source === 'telegram';

  const discordPath = `discord.com/channels/${message.guildId ?? '@me'}/${message.channelId}/${message.id}`;
  const discordUrl = openInDiscordApp ? `discord://${discordPath}` : `https://${discordPath}`;
  const webTelegramUrl = message.platformUrl ?? null;
  const telegramUrl = (() => {
    if (!webTelegramUrl) return null;
    if (!openInTelegramApp) return webTelegramUrl;
    const inviteMatch = webTelegramUrl.match(/^https:\/\/t\.me\/(?:joinchat\/|\+)(.+)$/);
    if (inviteMatch) return `tg://join?invite=${inviteMatch[1]}`;
    const privateMatch = webTelegramUrl.match(/^https:\/\/t\.me\/c\/(\d+)\/(\d+)$/);
    if (privateMatch) return `tg://privatepost?channel=${privateMatch[1]}&post=${privateMatch[2]}`;
    const publicMatch = webTelegramUrl.match(/^https:\/\/t\.me\/([^/]+)\/(\d+)$/);
    if (publicMatch) return `tg://resolve?domain=${publicMatch[1]}&post=${publicMatch[2]}`;
    return webTelegramUrl;
  })();
  const badgeAct: BadgeClickAction = badgeClickAction ?? 'discord';

  const openSourcePlatform = () => {
    if (isTelegram && telegramUrl) {
      if (openInTelegramApp) {
        window.location.href = telegramUrl;
      } else {
        window.open(telegramUrl, '_blank', 'noopener,noreferrer');
      }
    } else if (!isTelegram) {
      if (openInDiscordApp) {
        window.location.href = discordUrl;
      } else {
        window.open(discordUrl, '_blank', 'noopener,noreferrer');
      }
    }
  };

  const handleBadgeClick = () => {
    const hasContract = message.hasContractAddress && message.contractAddresses.length > 0;
    // Only ever invoked from a call site already guarded by `hasContract`.
    const openPlatform = () => {
      const addr = message.contractAddresses[0];
      const evmChain = useAppStore.getState().addressChains[addr.toLowerCase()];
      const url = buildContractUrl(addr, templates, evmChain);
      window.open(url, '_blank', 'noopener,noreferrer');
    };

    switch (badgeAct) {
      case 'platform':
        if (hasContract) openPlatform();
        else openSourcePlatform();
        break;
      case 'both':
        openSourcePlatform();
        if (hasContract) openPlatform();
        break;
      case 'discord':
      default:
        openSourcePlatform();
        break;
    }
  };

  const channelLabel = isTelegram
    ? message.channelName
    : `${message.guildName ? `${message.guildName} / ` : ''}#${message.channelName}`;

  const channelBadge = isTelegram ? (
    <span
      onClick={telegramUrl ? openSourcePlatform : undefined}
      className={`font-mono text-[0.6875rem] px-1.5 py-0.5 rounded-cockpit bg-oct-accent-dim text-oct-accent font-medium shrink-0${telegramUrl ? ' cursor-pointer hover:bg-oct-surface-raised transition-colors' : ''}`}
      title={telegramUrl ? 'Open in Telegram' : 'Telegram'}
    >
      TG &middot; {channelLabel}
    </span>
  ) : openInDiscordApp ? (
    <span
      onClick={() => { window.location.href = discordUrl; }}
      className="font-mono text-[0.6875rem] px-1.5 py-0.5 rounded-cockpit bg-oct-surface text-oct-muted font-medium shrink-0 hover:text-oct-text hover:bg-oct-surface-raised transition-colors cursor-pointer"
      title="Open in Discord app"
    >
      {channelLabel}
    </span>
  ) : (
    <a
      href={discordUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="font-mono text-[0.6875rem] px-1.5 py-0.5 rounded-cockpit bg-oct-surface text-oct-muted font-medium shrink-0 hover:text-oct-text hover:bg-oct-surface-raised transition-colors cursor-pointer"
      title="Open in Discord"
    >
      {channelLabel}
    </a>
  );

  if (messageDisplay === 'compact') {
    return (
      <div className={`group/compact relative hover:bg-oct-surface-raised ${d.compactPad} pr-2 sm:pr-[48px] pl-[52px] sm:pl-[72px] ${highlightClass} ${message.isDeleted ? 'opacity-60' : ''} ${d.minH}`} style={bgStyle}>
        <span className={`absolute left-0 w-[52px] sm:w-[72px] font-mono text-[0.6875rem] text-oct-muted text-right pr-2 sm:pr-4 pt-[1px] select-none ${d.lead} ${isCompact ? 'opacity-0 group-hover/compact:opacity-100' : ''}`}>
          {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
        <div className="min-w-0">
          {message.referencedMessage && (
            <div
              className="flex items-center gap-1 text-xs text-oct-muted mb-0.5 cursor-pointer hover:text-oct-text max-w-full overflow-hidden"
              onClick={(e) => requestMessageJump(e.currentTarget, message.referencedMessage!.id)}
            >
              <div className="w-8 h-3 border-l-2 border-t-2 border-oct-border-bright rounded-cockpit ml-1 shrink-0" />
              <span className="font-medium text-oct-muted shrink-0">{message.referencedMessage.author}</span>
              <span className="truncate opacity-70">
                {renderInlineMarkdown(message.referencedMessage.content, [], message.referencedMessage.mentions ?? {}, addrColors)}
              </span>
            </div>
          )}

          <div className={`${d.compactText} text-oct-text ${d.lead} break-words`}>
            {!isCompact && compactModeAvatars && (
              <AuthImage
                src={getAvatarUrl(message.author.id, message.author.avatar)}
                alt=""
                className="inline-block w-5 h-5 rounded-full mr-1 align-text-bottom"
              />
            )}
            <span
              className={`font-medium ${d.compactText} hover:underline cursor-pointer mr-1`}
              style={{ color: authorNameColor }}
              onClick={handleNameClick}
              onContextMenu={handleNameClick}
              title={`${message.author.username} (${message.author.id})`}
            >
              {message.author.displayName}
              {copied && (
                <span className="absolute -top-6 left-0 font-mono text-[10px] rounded-cockpit border-2 border-oct-border bg-oct-surface-raised text-oct-green px-1.5 py-0.5 shadow-oct-hard whitespace-nowrap pointer-events-none">
                  ID copied!
                </span>
              )}
            </span>
            {callerQuality && bandIsNotable(callerQuality.band) && (
              <span
                className={`font-mono text-[9px] font-bold uppercase tracking-wide px-1 py-0.5 rounded-cockpit mr-1 ${BAND_BADGE_CLASS[callerQuality.band]}`}
                title={BAND_TITLE[callerQuality.band]}
              >
                {BAND_LABELS[callerQuality.band]}
              </span>
            )}
            {channelBadge}
            <span className={`hidden sm:inline-flex items-center gap-0.5 align-middle transition-opacity ${isFocused ? 'opacity-100' : 'opacity-0 group-hover/compact:opacity-100'}`}>
              <button
                onClick={() => onFocus?.(message.guildId, message.channelId, message.guildName, message.channelName)}
                className={`p-0.5 rounded-cockpit transition-colors ${
                  isFocused
                    ? 'text-oct-accent'
                    : 'text-oct-muted hover:text-oct-text hover:bg-oct-surface-raised'
                }`}
                title={isFocused ? 'Focused on this channel' : 'Focus on this channel'}
              >
                <Eye size={13} />
              </button>
              {chattingEnabled && (
                <button
                  onClick={() => onQuickReply?.(message.channelId)}
                  className="p-0.5 rounded-cockpit text-oct-muted hover:text-oct-green hover:bg-oct-surface-raised transition-colors"
                  title="Quick reply to this channel"
                >
                  <MessageSquareReply size={13} />
                </button>
              )}
            </span>
            {' '}
            {message.hasContractAddress && (
              <>
                <span
                  onClick={handleBadgeClick}
                  className="inline-flex items-center rounded-cockpit border-2 border-oct-yellow bg-oct-yellow/15 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide text-oct-yellow shrink-0 cursor-pointer hover:bg-oct-yellow/25 transition-colors"
                  title={badgeAct === 'platform' ? 'Open in trading platform' : badgeAct === 'both' ? 'Open in Discord + platform' : 'Open in Discord'}
                >
                  CONTRACT
                </span>
                {' '}
              </>
            )}
            {hasKeywordMatch && (
              <>
                <span
                  onClick={handleBadgeClick}
                  className="inline-flex items-center rounded-cockpit border-2 border-oct-accent bg-oct-accent-dim px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide text-oct-accent shrink-0 cursor-pointer hover:bg-oct-surface-raised transition-colors"
                  title={badgeAct === 'platform' && message.hasContractAddress ? 'Open in trading platform' : badgeAct === 'both' && message.hasContractAddress ? 'Open in Discord + platform' : 'Open in Discord'}
                >
                  {message.matchedKeywords!.join(', ')}
                </span>
                {' '}
              </>
            )}
            {message.isDeleted && (
              <>
                <DeletedBadge />
                {' '}
              </>
            )}
            {renderContent(message.content, message.contractAddresses, message.mentions, addrColors, templates, clickAct, showFull)}
            <EditedIndicator message={message} addrColors={addrColors} templates={templates} clickAct={clickAct} showFull={showFull} />
          </div>

          <MessageAttachments attachments={message.attachments} onImageClick={setLightboxSrc} />

          <MessageEmbeds embeds={message.embeds} disableEmbeds={disableEmbeds} showFull={showFull} onImageClick={setLightboxSrc} />

          <TelegramExtras message={message} />
          <ReactionPills message={message} />
        </div>

        {lightboxSrc && (
          <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
        )}

        {contextMenu && (
          <UserContextMenu
            userId={message.author.id}
            displayName={message.author.displayName}
            guildId={message.guildId}
            channelId={message.channelId}
            channelName={message.channelName}
            guildName={message.guildName}
            openInDiscordApp={openInDiscordApp ?? false}
            position={contextMenu}
            isHighlighted={isUserHighlighted}
            onToggleHighlight={onToggleHighlight ? () => {
              const highlightKey = isTelegram && message.author.username ? `@${message.author.username}` : message.author.id;
              onToggleHighlight(highlightKey, message.author.displayName);
            } : undefined}
            callerQuality={callerQuality}
            onSetCallerTier={onSetCallerTier && callerQuality
              ? (tier) => onSetCallerTier(callerQuality.key, message.author.displayName, tier)
              : undefined}
            onHide={() => onHideUser?.(message.guildId, message.channelId, message.author.id, message.author.displayName)}
            onHideEverywhere={() => onHideUserEverywhere?.(message.author.id, message.author.displayName)}
            onCopyId={copyUserId}
            onClose={() => setContextMenu(null)}
          />
        )}
      </div>
    );
  }

  if (isCompact) {
    return (
      <div className={`group/compact relative hover:bg-oct-surface-raised ${d.contPad} pr-2 sm:pr-[48px] pl-[52px] sm:pl-[72px] ${highlightClass} ${message.isDeleted ? 'opacity-60' : ''} ${d.minH}`} style={bgStyle}>
        <span className={`absolute left-0 w-[52px] sm:w-[72px] font-mono text-[0.6875rem] text-oct-muted text-right pr-2 sm:pr-4 pt-[2px] opacity-0 group-hover/compact:opacity-100 select-none ${d.lead}`}>
          {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
        <div className="min-w-0">
          {message.referencedMessage && (
            <div
              className="flex items-center gap-1 text-xs text-oct-muted mb-0.5 cursor-pointer hover:text-oct-text max-w-full overflow-hidden"
              onClick={(e) => requestMessageJump(e.currentTarget, message.referencedMessage!.id)}
            >
              <div className="w-8 h-3 border-l-2 border-t-2 border-oct-border-bright rounded-cockpit ml-1 shrink-0" />
              <span className="font-medium text-oct-muted shrink-0">{message.referencedMessage.author}</span>
              <span className="truncate opacity-70">
                {renderInlineMarkdown(message.referencedMessage.content, [], message.referencedMessage.mentions ?? {}, addrColors)}
              </span>
            </div>
          )}

          <div className={`${d.text} text-oct-text ${d.lead} break-words`}>
            {message.isDeleted && (
              <>
                <DeletedBadge />
                {' '}
              </>
            )}
            {renderContent(message.content, message.contractAddresses, message.mentions, addrColors, templates, clickAct, showFull)}
            <EditedIndicator message={message} addrColors={addrColors} templates={templates} clickAct={clickAct} showFull={showFull} />
          </div>

          <MessageAttachments attachments={message.attachments} onImageClick={setLightboxSrc} />

          <MessageEmbeds embeds={message.embeds} disableEmbeds={disableEmbeds} showFull={showFull} onImageClick={setLightboxSrc} />

          <TelegramExtras message={message} />
          <ReactionPills message={message} />
        </div>

        {lightboxSrc && (
          <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
        )}
      </div>
    );
  }

  return (
    <div className={`relative hover:bg-oct-surface-raised ${d.firstPad} pr-2 sm:pr-[48px] pl-[52px] sm:pl-[72px] ${highlightClass} ${message.isDeleted ? 'opacity-60' : ''} group`} style={bgStyle}>
      <div className={`absolute right-0 top-0.5 flex items-center gap-0.5 rounded-cockpit px-0.5 py-0.5 z-10 sm:hidden ${isFocused ? 'opacity-100' : ''}`}>
        <button
          onClick={() => onFocus?.(message.guildId, message.channelId, message.guildName, message.channelName)}
          className={`p-0.5 rounded-cockpit transition-colors ${
            isFocused
              ? 'text-oct-accent'
              : 'text-oct-muted/60 hover:text-oct-text'
          }`}
          title={isFocused ? 'Focused on this channel' : 'Focus on this channel'}
        >
          <Eye size={13} />
        </button>
        {chattingEnabled && (
          <button
            onClick={() => onQuickReply?.(message.channelId)}
            className="p-0.5 rounded-cockpit text-oct-muted/60 hover:text-oct-green transition-colors"
            title="Quick reply to this channel"
          >
            <MessageSquareReply size={13} />
          </button>
        )}
      </div>
      <AuthImage
        src={getAvatarUrl(message.author.id, message.author.avatar)}
        alt=""
        className={`absolute left-2 sm:left-4 ${d.avatarTop} w-8 h-8 sm:w-10 sm:h-10 rounded-full`}
      />
      <div className="min-w-0">
        <div className={`flex items-baseline gap-1 flex-wrap ${d.lead}`}>
          <span
            className={`font-medium ${d.text} hover:underline cursor-pointer relative mr-1`}
            style={{ color: authorNameColor }}
            onClick={handleNameClick}
            onContextMenu={handleNameClick}
            title={`${message.author.username} (${message.author.id})`}
          >
            {message.author.displayName}
            {copied && (
              <span className="absolute -top-6 left-0 font-mono text-[10px] rounded-cockpit border-2 border-oct-border bg-oct-surface-raised text-oct-green px-1.5 py-0.5 shadow-oct-hard whitespace-nowrap pointer-events-none">
                ID copied!
              </span>
            )}
          </span>
          {callerQuality && bandIsNotable(callerQuality.band) && (
            <span
              className={`font-mono text-[9px] font-bold uppercase tracking-wide px-1 py-0.5 rounded-cockpit ${BAND_BADGE_CLASS[callerQuality.band]}`}
              title={BAND_TITLE[callerQuality.band]}
            >
              {BAND_LABELS[callerQuality.band]}
            </span>
          )}
          <span className={`font-mono text-xs text-oct-muted ${d.lead} ml-1 sm:hidden`}>
            {formatTimestamp(message.timestamp, true)}
          </span>
          <span className={`font-mono text-xs text-oct-muted ${d.lead} ml-1 hidden sm:inline`}>
            {formatTimestamp(message.timestamp)}
          </span>
          {channelBadge}
          <span className={`hidden sm:inline-flex items-center gap-0.5 align-middle transition-opacity ${isFocused ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
            <button
              onClick={() => onFocus?.(message.guildId, message.channelId, message.guildName, message.channelName)}
              className={`p-0.5 rounded-cockpit transition-colors ${
                isFocused
                  ? 'text-oct-accent'
                  : 'text-oct-muted hover:text-oct-text hover:bg-oct-surface-raised'
              }`}
              title={isFocused ? 'Focused on this channel' : 'Focus on this channel'}
            >
              <Eye size={14} />
            </button>
            {chattingEnabled && (
              <button
                onClick={() => onQuickReply?.(message.channelId)}
                className="p-0.5 rounded-cockpit text-oct-muted hover:text-oct-green hover:bg-oct-surface-raised transition-colors"
                title="Quick reply to this channel"
              >
                <MessageSquareReply size={14} />
              </button>
            )}
          </span>
          {message.hasContractAddress && (
            <span
              onClick={handleBadgeClick}
              className="inline-flex items-center rounded-cockpit border-2 border-oct-yellow bg-oct-yellow/15 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide text-oct-yellow shrink-0 cursor-pointer hover:bg-oct-yellow/25 transition-colors"
              title={badgeAct === 'platform' ? 'Open in trading platform' : badgeAct === 'both' ? 'Open in Discord + platform' : 'Open in Discord'}
            >
              CONTRACT
            </span>
          )}
          {hasKeywordMatch && (
            <span
              onClick={handleBadgeClick}
              className="inline-flex items-center rounded-cockpit border-2 border-oct-accent bg-oct-accent-dim px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide text-oct-accent shrink-0 cursor-pointer hover:bg-oct-surface-raised transition-colors"
              title={badgeAct === 'platform' && message.hasContractAddress ? 'Open in trading platform' : badgeAct === 'both' && message.hasContractAddress ? 'Open in Discord + platform' : 'Open in Discord'}
            >
              {message.matchedKeywords!.join(', ')}
            </span>
          )}
          {message.isDeleted && <DeletedBadge />}
        </div>

        {message.referencedMessage && (
          <div
            className="flex items-center gap-1.5 text-sm text-oct-muted mt-0.5 mb-0.5 cursor-pointer hover:text-oct-text transition-colors"
            onClick={(e) => requestMessageJump(e.currentTarget, message.referencedMessage!.id)}
          >
            <div className="w-8 h-3 border-l-2 border-t-2 border-oct-border-bright rounded-cockpit ml-1 shrink-0" />
            <span className="font-medium text-oct-muted shrink-0">{message.referencedMessage.author}</span>
            <span className="truncate opacity-70">
              {renderInlineMarkdown(message.referencedMessage.content, [], message.referencedMessage.mentions ?? {}, addrColors)}
            </span>
          </div>
        )}

        <div className={`${d.text} text-oct-text ${d.lead} break-words whitespace-pre-wrap`}>
          {renderContent(message.content, message.contractAddresses, message.mentions, addrColors, templates, clickAct, showFull)}
          <EditedIndicator message={message} addrColors={addrColors} templates={templates} clickAct={clickAct} showFull={showFull} />
        </div>

        <MessageAttachments attachments={message.attachments} onImageClick={setLightboxSrc} />

        <MessageEmbeds embeds={message.embeds} disableEmbeds={disableEmbeds} showFull={showFull} onImageClick={setLightboxSrc} />

        <TelegramExtras message={message} />
        <ReactionPills message={message} />
      </div>

      {lightboxSrc && (
        <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
      )}

      {contextMenu && (
        <UserContextMenu
          userId={message.author.id}
          displayName={message.author.displayName}
          guildId={message.guildId}
          channelId={message.channelId}
          channelName={message.channelName}
          guildName={message.guildName}
          openInDiscordApp={openInDiscordApp ?? false}
          position={contextMenu}
          isHighlighted={isUserHighlighted}
          onToggleHighlight={onToggleHighlight ? () => {
            const highlightKey = isTelegram && message.author.username ? `@${message.author.username}` : message.author.id;
            onToggleHighlight(highlightKey, message.author.displayName);
          } : undefined}
          onHide={() => onHideUser?.(message.guildId, message.channelId, message.author.id, message.author.displayName)}
          onHideEverywhere={() => onHideUserEverywhere?.(message.author.id, message.author.displayName)}
          onCopyId={copyUserId}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

export default memo(Message);
