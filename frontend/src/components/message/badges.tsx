import { useState } from 'react';
import type { FrontendMessage, ContractLinkTemplates, ContractClickAction } from '../../types';
import { type AddressColors, renderContent, detectAddresses } from './content';

function DeletedBadge() {
  return (
    <span
      className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 font-semibold uppercase tracking-wide"
      title="This message was deleted on the platform"
    >
      deleted
    </span>
  );
}

function EditedIndicator({ message, addrColors, templates, clickAct, showFull }: {
  message: FrontendMessage;
  addrColors: AddressColors;
  templates: ContractLinkTemplates;
  clickAct: ContractClickAction;
  showFull: boolean;
}) {
  const [showOriginal, setShowOriginal] = useState(false);
  if (!message.isEdited) return null;
  const hasOriginal = message.originalContent !== undefined && message.originalContent !== '';

  return (
    <>
      <span
        onClick={hasOriginal ? () => setShowOriginal((v) => !v) : undefined}
        className={`text-[10px] text-discord-text-muted ml-1 align-baseline select-none${hasOriginal ? ' cursor-pointer hover:underline' : ''}`}
        title={hasOriginal ? (showOriginal ? 'Hide original message' : 'Show original message') : 'Original message unavailable'}
      >
        (edited)
      </span>
      {showOriginal && hasOriginal && (
        <div className="mt-1 border-l-2 border-discord-text-muted/40 pl-2 text-[13px] text-discord-text-muted">
          <div className="text-[10px] uppercase tracking-wide text-discord-text-muted/70 mb-0.5">Original</div>
          {renderContent(message.originalContent!, detectAddresses(message.originalContent!), message.mentions, addrColors, templates, clickAct, showFull)}
        </div>
      )}
    </>
  );
}

export { DeletedBadge, EditedIndicator };
