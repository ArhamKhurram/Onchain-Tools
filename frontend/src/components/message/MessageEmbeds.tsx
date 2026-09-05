import type { DiscordEmbed } from '@oct/shared';
import { renderInlineMarkdown, renderEmbedDescription } from './content';

interface MessageEmbedsProps {
  embeds: DiscordEmbed[];
  /** When true, embeds are hidden entirely (per the room's display settings). */
  disableEmbeds?: boolean;
  /** Passed through to embed description/field rendering to control address truncation. */
  showFull: boolean;
  /** Called with the image src when an embed image/thumbnail is clicked (opens the lightbox). */
  onImageClick: (src: string) => void;
}

/**
 * Renders a message's Discord embeds (author, title, description, fields,
 * thumbnail/image, footer). Extracted verbatim from Message.tsx, where the same
 * markup was triplicated across the compact-display, compact, and default
 * render branches.
 */
export function MessageEmbeds({ embeds, disableEmbeds, showFull, onImageClick }: MessageEmbedsProps) {
  if (embeds.length === 0 || disableEmbeds) return null;

  return (
    <div className="flex flex-col gap-2 mt-1">
      {embeds.map((embed, i) => (
        <div
          key={i}
          className="rounded-cockpit border-2 border-oct-border border-l-4 bg-oct-surface-raised p-2 sm:p-3 max-w-full sm:max-w-[520px]"
          style={{ borderLeftColor: embed.color ? `#${embed.color.toString(16).padStart(6, '0')}` : 'rgb(var(--oct-border-bright))' }}
        >
          {embed.author?.name && (
            <div className="flex items-center gap-2 mb-1">
              {embed.author.icon_url && (
                <img src={embed.author.icon_url} alt="" loading="lazy" decoding="async" className="w-6 h-6 rounded-full" />
              )}
              {embed.author.url ? (
                <a href={embed.author.url} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-oct-text hover:underline">
                  {renderInlineMarkdown(embed.author.name, [], {})}
                </a>
              ) : (
                <span className="text-sm font-medium text-oct-text">
                  {renderInlineMarkdown(embed.author.name, [], {})}
                </span>
              )}
            </div>
          )}
          {embed.title && (
            <div className="font-semibold text-sm">
              {embed.url ? (
                <a href={embed.url} target="_blank" rel="noopener noreferrer" className="hover:underline text-oct-accent">
                  {renderInlineMarkdown(embed.title, [], {})}
                </a>
              ) : <span className="text-oct-text">{renderInlineMarkdown(embed.title, [], {})}</span>}
            </div>
          )}
          {embed.description && (
            <div className="text-[13px] text-oct-text mt-1 leading-[1.125rem]">
              {renderEmbedDescription(embed.description, showFull)}
            </div>
          )}
          {embed.fields && embed.fields.length > 0 && (
            <div className="grid gap-y-1 gap-x-2 mt-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}>
              {embed.fields.map((field, fi) => (
                <div key={fi} className={field.inline ? '' : 'col-span-full'}>
                  <div className="font-mono text-xs font-semibold text-oct-text mb-0.5">
                    {renderInlineMarkdown(field.name, [], {})}
                  </div>
                  <div className="text-[13px] text-oct-text leading-[1.125rem]">
                    {renderEmbedDescription(field.value, showFull)}
                  </div>
                </div>
              ))}
            </div>
          )}
          {embed.thumbnail && !embed.image && (
            <img
              src={embed.thumbnail.url}
              alt=""
              loading="lazy"
              decoding="async"
              className="max-w-[80px] max-h-[80px] rounded-cockpit border-2 border-oct-border mt-2 cursor-pointer hover:opacity-90 transition-opacity"
              onClick={() => onImageClick(embed.thumbnail!.url)}
            />
          )}
          {embed.image && (
            <img
              src={embed.image.url}
              alt=""
              loading="lazy"
              decoding="async"
              className="max-w-full sm:max-w-[400px] max-h-[300px] rounded-cockpit border-2 border-oct-border mt-2 cursor-pointer hover:opacity-90 transition-opacity"
              onClick={() => onImageClick(embed.image!.url)}
            />
          )}
          {embed.footer?.text && (
            <div className="flex items-center gap-2 mt-2 font-mono text-xs text-oct-muted">
              {embed.footer.icon_url && (
                <img src={embed.footer.icon_url} alt="" loading="lazy" decoding="async" className="w-5 h-5 rounded-full" />
              )}
              <span>{embed.footer.text}</span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
