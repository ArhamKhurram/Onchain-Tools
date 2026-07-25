import type { FrontendMessage } from '../../types';

function TelegramExtras({ message }: { message: FrontendMessage }) {
  if (message.source !== 'telegram') return null;

  return (
    <>
      {message.forwardFrom && (
        <div className="text-xs text-[#2AABEE] italic mt-0.5 mb-1">
          Forwarded from {message.forwardFrom.name}
          {message.forwardFrom.chatTitle && message.forwardFrom.chatTitle !== message.forwardFrom.name
            ? ` in ${message.forwardFrom.chatTitle}`
            : ''}
        </div>
      )}

      {message.sticker && (
        <div className="mt-1">
          {message.sticker.url ? (
            <img
              src={message.sticker.url}
              alt={message.sticker.emoji ?? 'sticker'}
              loading="lazy"
              decoding="async"
              className="w-32 h-32 object-contain"
            />
          ) : (
            <span className="text-4xl">{message.sticker.emoji ?? '🏷️'}</span>
          )}
        </div>
      )}

      {message.poll && (
        <div className="mt-1 border border-discord-divider rounded p-3 max-w-sm">
          <div className="text-sm font-semibold text-white mb-2">📊 {message.poll.question}</div>
          <div className="space-y-1.5">
            {message.poll.options.map((opt, i) => {
              const total = message.poll!.options.reduce((s, o) => s + o.voters, 0);
              const pct = total > 0 ? Math.round((opt.voters / total) * 100) : 0;
              return (
                <div key={i} className="relative">
                  <div
                    className="absolute inset-0 bg-[#2AABEE]/15 rounded"
                    style={{ width: `${pct}%` }}
                  />
                  <div className="relative flex items-center justify-between px-2 py-1.5 text-sm">
                    <span className="text-discord-text">{opt.text}</span>
                    <span className="text-discord-text-muted text-xs">{pct}%</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {message.buttons && message.buttons.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-1">
          {message.buttons.map((btn, i) => (
            <a
              key={i}
              href={btn.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center px-2.5 py-1 rounded bg-[#2AABEE]/10 text-[#2AABEE] text-xs font-medium hover:bg-[#2AABEE]/20 transition-colors"
              title={btn.url}
            >
              {btn.text}
            </a>
          ))}
        </div>
      )}
    </>
  );
}

export { TelegramExtras };
