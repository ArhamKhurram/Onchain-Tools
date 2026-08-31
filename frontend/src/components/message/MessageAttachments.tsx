import type { DiscordAttachment } from '@oct/shared';
import { AuthImage, AuthVideo, AuthAudio } from '../AuthMedia';

interface MessageAttachmentsProps {
  attachments: DiscordAttachment[];
  /** Called with the image src when an image attachment is clicked (opens the lightbox). */
  onImageClick: (src: string) => void;
}

/**
 * Renders a message's attachment list (images, audio, video, and other files).
 * Extracted verbatim from Message.tsx, where the same markup was triplicated
 * across the compact-display, compact, and default render branches.
 */
export function MessageAttachments({ attachments, onImageClick }: MessageAttachmentsProps) {
  if (attachments.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 mt-1">
      {attachments.map((att) =>
        att.content_type?.startsWith('image/') ? (
          <AuthImage
            key={att.id}
            src={att.proxy_url}
            alt={att.filename}
            className="max-w-full sm:max-w-[400px] max-h-[300px] rounded-cockpit border-2 border-oct-border cursor-pointer hover:opacity-90 transition-opacity"
            onClick={() => onImageClick(att.proxy_url)}
          />
        ) : att.content_type?.startsWith('audio/') ? (
          <div key={att.id} className="flex flex-col gap-1 max-w-full sm:max-w-[400px]">
            <AuthAudio src={att.proxy_url} type={att.content_type} className="h-8 max-w-full" />
            <span className="font-mono text-[11px] text-oct-muted truncate">{att.filename}</span>
          </div>
        ) : att.content_type?.startsWith('video/') ? (
          <AuthVideo
            key={att.id}
            src={att.proxy_url}
            className="max-w-full sm:max-w-[400px] max-h-[300px] rounded-cockpit border-2 border-oct-border"
          />
        ) : (
          <a
            key={att.id}
            href={att.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-oct-accent hover:underline text-sm"
          >
            {att.filename}
          </a>
        )
      )}
    </div>
  );
}
