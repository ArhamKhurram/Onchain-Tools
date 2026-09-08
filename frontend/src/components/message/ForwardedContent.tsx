import { Forward } from 'lucide-react';
import type { ForwardedMessage, ContractLinkTemplates, ContractClickAction } from '../../types';
import { type AddressColors, renderContent } from './content';
import { MessageAttachments } from './MessageAttachments';
import { MessageEmbeds } from './MessageEmbeds';

interface ForwardedContentProps {
  forwarded: ForwardedMessage | null | undefined;
  contractAddresses: string[];
  mentions: Record<string, string>;
  addrColors: AddressColors;
  templates: ContractLinkTemplates;
  clickAct: ContractClickAction;
  showFull: boolean;
  disableEmbeds?: boolean;
  onImageClick: (src: string) => void;
  /** Text sizing/leading fragments from the row's density preset, so the quoted body matches the feed. */
  textClass: string;
  leadClass: string;
}

/**
 * The forwarded half of a Discord forward, rendered as a quoted card.
 *
 * Discord puts a forwarded message's body in `message_snapshots` rather than
 * `content`, so before this existed a forward rendered as an empty row — the
 * author and chrome, no text. The body goes through the same `renderContent`
 * as any other message so a forwarded contract address is still a clickable
 * pill, and the same embed/attachment components so a forwarded scanner card
 * still looks like one.
 *
 * There is deliberately no author line: a snapshot carries no author, and
 * inventing one (the forwarder, say) would mislabel whose call it was.
 */
export function ForwardedContent({
  forwarded,
  contractAddresses,
  mentions,
  addrColors,
  templates,
  clickAct,
  showFull,
  disableEmbeds,
  onImageClick,
  textClass,
  leadClass,
}: ForwardedContentProps) {
  if (!forwarded) return null;

  return (
    <div className="mt-1 max-w-full sm:max-w-[520px] rounded-cockpit border-2 border-oct-border border-l-4 border-l-oct-border-bright bg-oct-surface-raised px-2 py-1.5">
      <div className="flex items-center gap-1 font-mono text-[10px] font-bold uppercase tracking-wide text-oct-muted">
        <Forward size={11} className="shrink-0" />
        <span>Forwarded</span>
        {forwarded.origin && <span className="truncate opacity-80">&middot; {forwarded.origin}</span>}
      </div>

      {forwarded.content && (
        <div className={`${textClass} text-oct-text ${leadClass} break-words whitespace-pre-wrap mt-1`}>
          {renderContent(forwarded.content, contractAddresses, mentions, addrColors, templates, clickAct, showFull)}
        </div>
      )}

      <MessageAttachments attachments={forwarded.attachments} onImageClick={onImageClick} />

      <MessageEmbeds
        embeds={forwarded.embeds}
        disableEmbeds={disableEmbeds}
        showFull={showFull}
        onImageClick={onImageClick}
      />
    </div>
  );
}
