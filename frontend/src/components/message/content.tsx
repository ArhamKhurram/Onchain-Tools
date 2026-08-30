import { type ReactNode, Fragment, useState } from 'react';
import { Copy, Check } from 'lucide-react';
import type { ContractLinkTemplates, ContractClickAction } from '../../types';
import { useAppStore } from '../../stores/appStore';
import { buildContractUrl, DEFAULT_LINK_TEMPLATES } from '../../utils/contractUrl';
import { colorWithExtraAlpha } from '../ColorPickerWithAlpha';

export interface AddressColors {
  evm: string;
  sol: string;
}

const URL_REGEX = /(https?:\/\/[^\s<>()[\]]+(?:\([^\s<>()]*\))*[^\s<>()[\],.'\"!?;:]?)/g;
const DISCORD_MENTION_REGEX = /<@!?(\d+)>|<#(\d+)>|<@&(\d+)>/g;
const EMOJI_REGEX = /<a?:(\w+):(\d+)>/g;
const BOLD_REGEX = /\*\*(.+?)\*\*/g;
const MARKDOWN_LINK_REGEX = /\[([^\]]+)\]\(<?(https?:\/\/[^>)\s]+)>?\)/g;
const ANGLE_URL_REGEX = /<(https?:\/\/[^>]+)>/g;
const TIMESTAMP_REGEX = /<t:(\d+)(?::([tTdDfFR]))?>/g;
const CODE_BLOCK_REGEX = /```(?:\w+\n)?([\s\S]*?)```/g;
const INLINE_CODE_REGEX = /`([^`]+)`/g;

function formatDiscordTimestamp(unix: number, style: string): string {
  const d = new Date(unix * 1000);
  switch (style) {
    case 't': return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    case 'T': return d.toLocaleTimeString();
    case 'd': return d.toLocaleDateString();
    case 'D': return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
    case 'f': return d.toLocaleString(undefined, { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    case 'F': return d.toLocaleString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    case 'R': {
      const now = Date.now();
      const diff = now - d.getTime();
      const sec = Math.round(Math.abs(diff) / 1000);
      const past = diff > 0;
      if (sec < 60) return past ? `${sec} seconds ago` : `in ${sec} seconds`;
      const min = Math.round(sec / 60);
      if (min < 60) return past ? `${min} minutes ago` : `in ${min} minutes`;
      const hr = Math.round(min / 60);
      if (hr < 24) return past ? `${hr} hours ago` : `in ${hr} hours`;
      const days = Math.round(hr / 24);
      return past ? `${days} days ago` : `in ${days} days`;
    }
    default: return d.toLocaleString();
  }
}

function linkifyText(text: string, keyPrefix: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  URL_REGEX.lastIndex = 0;
  while ((match = URL_REGEX.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const url = match[1];
    parts.push(
      <a
        key={`${keyPrefix}-url-${match.index}`}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-discord-text-link hover:underline break-all"
      >
        {url.length > 70 ? url.slice(0, 65) + '...' : url}
      </a>
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length > 0 ? parts : [text];
}

function contractClickTitle(action: ContractClickAction, addr: string): string {
  switch (action) {
    case 'copy': return `Click to copy: ${addr}`;
    case 'open': return `Click to open: ${addr}`;
    default: return `Click to copy & open: ${addr}`;
  }
}

function handleContractClick(addr: string, action: ContractClickAction, linkTemplates: ContractLinkTemplates) {
  if (action === 'copy' || action === 'copy_open') {
    navigator.clipboard.writeText(addr);
  }
  if (action === 'open' || action === 'copy_open') {
    // Resolve the chain at click time so a link corrected after the message
    // was rendered (e.g. via a Rick follow-up) opens on the right chain.
    const evmChain = useAppStore.getState().addressChains[addr.toLowerCase()];
    window.open(buildContractUrl(addr, linkTemplates, evmChain), '_blank');
  }
}

/**
 * A detected contract address rendered as a colored pill. The pill body keeps the
 * existing click behavior (`copy_open` by default — copy AND open). The trailing icon
 * is a dedicated copy button that copies WITHOUT opening (`stopPropagation`), which is
 * the affordance the pill lacked: previously the only way to copy also navigated away.
 * Matches the Copy/Check pattern used in the caller radar table.
 */
function ContractPill({
  addr,
  color,
  clickAction,
  linkTemplates,
  showFull,
}: {
  addr: string;
  color: string;
  clickAction: ContractClickAction;
  linkTemplates: ContractLinkTemplates;
  showFull: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const copyOnly = (e: React.MouseEvent) => {
    e.stopPropagation(); // never trigger the pill's open action
    navigator.clipboard.writeText(addr);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <span
      className="pl-1 pr-0.5 rounded text-[13px] font-mono inline-flex items-center gap-1 transition-opacity hover:opacity-80"
      style={{ backgroundColor: colorWithExtraAlpha(color, 0.125), color }}
    >
      <span
        className="cursor-pointer"
        title={contractClickTitle(clickAction, addr)}
        onClick={() => handleContractClick(addr, clickAction, linkTemplates)}
      >
        {showFull ? addr : `${addr.slice(0, 6)}...${addr.slice(-4)}`}
      </span>
      <button
        type="button"
        className="shrink-0 opacity-70 hover:opacity-100 leading-none"
        title={copied ? 'Copied!' : 'Copy address'}
        aria-label="Copy contract address"
        onClick={copyOnly}
      >
        {copied ? <Check size={12} className="text-oct-green" /> : <Copy size={12} />}
      </button>
    </span>
  );
}

function applyInlineFormatting(
  parts: (string | ReactNode)[],
  contractAddresses: string[],
  mentions: Record<string, string>,
  addressColors?: AddressColors,
  linkTemplates: ContractLinkTemplates = DEFAULT_LINK_TEMPLATES,
  clickAction: ContractClickAction = 'copy_open',
  showFull: boolean = false,
): (string | ReactNode)[] {
  // Markdown links [text](url)
  parts = splitByRegex(parts, MARKDOWN_LINK_REGEX, (m, i) => (
    <a
      key={`mdlink-${i}`}
      href={m[2]}
      target="_blank"
      rel="noopener noreferrer"
      className="text-discord-text-link hover:underline"
    >
      {m[1]}
    </a>
  ));

  // Angle-bracket URLs <https://...>
  parts = splitByRegex(parts, ANGLE_URL_REGEX, (m, i) => (
    <a
      key={`angurl-${i}`}
      href={m[1]}
      target="_blank"
      rel="noopener noreferrer"
      className="text-discord-text-link hover:underline break-all"
    >
      {m[1].length > 70 ? m[1].slice(0, 65) + '...' : m[1]}
    </a>
  ));

  // Discord timestamps <t:123456:R>
  parts = splitByRegex(parts, TIMESTAMP_REGEX, (m, i) => {
    const unix = parseInt(m[1]);
    const style = m[2] || 'f';
    const formatted = formatDiscordTimestamp(unix, style);
    const fullDate = new Date(unix * 1000).toLocaleString();
    return (
      <span
        key={`ts-${i}`}
        className="bg-discord-embed-bg px-1 py-0.5 rounded text-discord-text cursor-default"
        title={fullDate}
      >
        {formatted}
      </span>
    );
  });

  // Discord custom emojis
  parts = splitByRegex(parts, EMOJI_REGEX, (m, i) => (
    <img
      key={`emoji-${i}`}
      src={`https://cdn.discordapp.com/emojis/${m[2]}.${m[0].startsWith('<a:') ? 'gif' : 'webp'}?size=20`}
      alt={`:${m[1]}:`}
      title={`:${m[1]}:`}
      loading="lazy"
      decoding="async"
      className="inline-block w-5 h-5 align-text-bottom mx-0.5"
    />
  ));

  // Discord mentions
  parts = splitByRegex(parts, DISCORD_MENTION_REGEX, (m, i) => {
    let label: string;
    if (m[1]) {
      label = `@${mentions[m[1]] ?? 'user'}`;
    } else if (m[2]) {
      label = `#${mentions[`ch:${m[2]}`] ?? 'channel'}`;
    } else if (m[3]) {
      label = `@${mentions[`role:${m[3]}`] ?? 'role'}`;
    } else {
      label = `@unknown`;
    }
    return (
      <span key={`mention-${i}`} className="bg-discord-blurple/20 text-discord-blurple px-0.5 rounded font-medium">
        {label}
      </span>
    );
  });

  // Plain-text URLs
  {
    const urlified: (string | ReactNode)[] = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (typeof part !== 'string') { urlified.push(part); continue; }
      urlified.push(...linkifyText(part, `p${i}`));
    }
    parts = urlified;
  }

  // Contract addresses -- AFTER all URL processing
  for (const addr of contractAddresses) {
    const isEvm = addr.startsWith('0x');
    const color = isEvm ? (addressColors?.evm ?? '#fee75c') : (addressColors?.sol ?? '#14f195');
    const newParts: (string | ReactNode)[] = [];
    for (const part of parts) {
      if (typeof part !== 'string') { newParts.push(part); continue; }
      const splits = part.split(addr);
      for (let i = 0; i < splits.length; i++) {
        if (splits[i]) newParts.push(splits[i]);
        if (i < splits.length - 1) {
          newParts.push(
            <ContractPill
              key={`contract-${addr}-${i}`}
              addr={addr}
              color={color}
              clickAction={clickAction}
              linkTemplates={linkTemplates}
              showFull={showFull}
            />
          );
        }
      }
    }
    parts = newParts;
  }

  return parts;
}

function renderInlineMarkdown(content: string, contractAddresses: string[], mentions: Record<string, string> = {}, addressColors?: AddressColors, linkTemplates: ContractLinkTemplates = DEFAULT_LINK_TEMPLATES, clickAction: ContractClickAction = 'copy_open', showFull: boolean = false): ReactNode[] {
  let parts: (string | ReactNode)[] = [content];

  // 1. Inline code (protect from other formatting)
  //    If the code content is a known contract address, render it as a clickable pill instead.
  parts = splitByRegex(parts, INLINE_CODE_REGEX, (m, i) => {
    const codeText = m[1];
    const matchedAddr = contractAddresses.find(a => codeText.trim() === a);
    if (matchedAddr) {
      const isEvm = matchedAddr.startsWith('0x');
      const color = isEvm ? (addressColors?.evm ?? '#fee75c') : (addressColors?.sol ?? '#14f195');
      return (
        <ContractPill
          key={`code-contract-${i}`}
          addr={matchedAddr}
          color={color}
          clickAction={clickAction}
          linkTemplates={linkTemplates}
          showFull={showFull}
        />
      );
    }
    return (
      <code key={`code-${i}`} className="bg-discord-embed-bg px-1 py-0.5 rounded text-[0.85em] font-mono">
        {codeText}
      </code>
    );
  });

  // 2. Bold — processed before links so **[text](url) stuff** works.
  //    Inner content is recursively formatted for links, emojis, etc.
  parts = splitByRegex(parts, BOLD_REGEX, (m, i) => (
    <strong key={`bold-${i}`} className="font-semibold text-white">
      {applyInlineFormatting([m[1]], contractAddresses, mentions, addressColors, linkTemplates, clickAction, showFull)}
    </strong>
  ));

  // 3. Everything else on non-bold text
  parts = applyInlineFormatting(parts, contractAddresses, mentions, addressColors, linkTemplates, clickAction, showFull);

  return parts as ReactNode[];
}

function renderContent(content: string, contractAddresses: string[], mentions: Record<string, string> = {}, addressColors?: AddressColors, linkTemplates: ContractLinkTemplates = DEFAULT_LINK_TEMPLATES, clickAction: ContractClickAction = 'copy_open', showFull: boolean = false) {
  if (!content) return null;

  // Extract code blocks first, replace with placeholders
  const codeBlocks: ReactNode[] = [];
  const withoutCodeBlocks = content.replace(CODE_BLOCK_REGEX, (_match, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(
      <pre key={`codeblock-${idx}`} className="bg-discord-embed-bg border border-discord-dark/50 rounded p-2 my-1 text-sm font-mono overflow-x-auto whitespace-pre-wrap">
        <code>{code}</code>
      </pre>
    );
    return `\x00CODEBLOCK_${idx}\x00`;
  });

  // Split into lines and group into quote blocks vs normal
  const lines = withoutCodeBlocks.split('\n');
  const result: ReactNode[] = [];
  let quoteBuffer: string[] = [];
  let lineKey = 0;

  function flushQuotes() {
    if (quoteBuffer.length === 0) return;
    const quoteContent = quoteBuffer.join('\n');
    result.push(
      <div key={`quote-${lineKey++}`} className="border-l-[3px] border-discord-text-muted/40 pl-3 my-1">
        {renderLineGroup(quoteContent, contractAddresses)}
      </div>
    );
    quoteBuffer = [];
  }

  function renderLineGroup(text: string, contracts: string[]): ReactNode {
    const groupLines = text.split('\n');
    const parts: ReactNode[] = [];
    for (let i = 0; i < groupLines.length; i++) {
      if (i > 0) parts.push(<br key={`lbr-${lineKey}-${i}`} />);
      const placeholderMatch = groupLines[i].match(/\x00CODEBLOCK_(\d+)\x00/);
      if (placeholderMatch) {
        parts.push(codeBlocks[parseInt(placeholderMatch[1])]);
      } else {
        parts.push(...renderInlineMarkdown(groupLines[i], contracts, mentions, addressColors, linkTemplates, clickAction, showFull));
      }
    }
    return <>{parts}</>;
  }

  for (const line of lines) {
    if (line.startsWith('> ') || line === '>') {
      quoteBuffer.push(line.slice(2));
    } else {
      flushQuotes();
      // Check for code block placeholder
      const placeholderMatch = line.match(/\x00CODEBLOCK_(\d+)\x00/);
      if (placeholderMatch) {
        result.push(codeBlocks[parseInt(placeholderMatch[1])]);
      } else {
        if (result.length > 0) result.push(<br key={`br-${lineKey++}`} />);
        result.push(
          <Fragment key={`line-${lineKey++}`}>
            {renderInlineMarkdown(line, contractAddresses, mentions, addressColors, linkTemplates, clickAction, showFull)}
          </Fragment>
        );
      }
    }
  }
  flushQuotes();

  return <span>{result}</span>;
}

function splitByRegex(
  parts: (string | ReactNode)[],
  regex: RegExp,
  render: (match: RegExpExecArray, idx: number) => ReactNode,
): (string | ReactNode)[] {
  let counter = 0;
  const result: (string | ReactNode)[] = [];
  for (const part of parts) {
    if (typeof part !== 'string') { result.push(part); continue; }
    let lastIndex = 0;
    const re = new RegExp(regex.source, regex.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(part)) !== null) {
      if (m.index > lastIndex) result.push(part.slice(lastIndex, m.index));
      result.push(render(m, counter++));
      lastIndex = m.index + m[0].length;
    }
    if (lastIndex < part.length) result.push(part.slice(lastIndex));
  }
  return result;
}

const EVM_ADDR_RE = /\b0x[a-fA-F0-9]{40}\b/g;
const SOL_ADDR_RE = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{40,48}(?![1-9A-HJ-NP-Za-km-z])/g;

function detectAddresses(text: string): string[] {
  // Strip URLs so we don't detect addresses embedded in links
  const stripped = text
    .replace(/https?:\/\/[^\s<>)]+/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  const addrs: string[] = [];
  const evm = stripped.match(EVM_ADDR_RE);
  if (evm) addrs.push(...evm);
  const sol = stripped.match(SOL_ADDR_RE);
  if (sol) {
    for (const m of sol) {
      if (!addrs.includes(m) && /\d/.test(m) && /[a-z]/.test(m) && /[A-Z]/.test(m)) {
        addrs.push(m);
      }
    }
  }
  return addrs;
}

function renderEmbedDescription(text: string, showFull: boolean = false): ReactNode {
  return renderContent(text, detectAddresses(text), {}, undefined, undefined, undefined, showFull);
}

export {
  renderInlineMarkdown,
  renderContent,
  detectAddresses,
  renderEmbedDescription,
};
