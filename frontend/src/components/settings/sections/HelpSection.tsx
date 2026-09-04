import { useState, type ReactNode } from 'react';
import { Eye, Upload, Download, BookOpen, ExternalLink } from 'lucide-react';
import { isHostedMode } from '../../../lib/supabase';
import { USER_DOCS_URL } from '../../../lib/links';
import { cn } from '../../../lib/utils';
import { Help, Kicker, SectionHeader, StatusBox, StatusText } from '../fields';
import type { SettingsForm } from '../useSettingsForm';

// ── Manual building blocks ────────────────────────────────────────────────────
// The manual is prose, so it gets four shapes and nothing else: a panel, a
// panel sub-heading, an inline kicker (`Enter:`, `Global:`) and the numbered
// step. All sit on the 12px floor; the old 10px kickers are gone.

const panelClass = 'rounded-oct border border-oct-border bg-oct-surface-raised px-comfy py-cozy';

function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn(panelClass, 'space-y-tight', className)}>{children}</div>;
}

function SubHeading({ children }: { children: ReactNode }) {
  return <p className="type-label font-mono uppercase tracking-[0.15em] text-oct-text">{children}</p>;
}

/** `Kicker: body` line inside a panel. */
function Line({ kicker, children }: { kicker?: ReactNode; children: ReactNode }) {
  return (
    <p className="type-caption text-oct-muted">
      {kicker && <span className="type-caption font-mono font-bold uppercase tracking-[0.15em] text-oct-accent mr-tight">{kicker}</span>}
      {children}
    </p>
  );
}

function Step({ n, children }: { n: string; children: ReactNode }) {
  return (
    <div className="flex gap-comfy items-start">
      <span className="type-data font-bold uppercase tracking-[0.15em] text-oct-accent mt-hair shrink-0">[ {n} ]</span>
      <span>{children}</span>
    </div>
  );
}

/** Literal SOL/EVM pills as they appear in the feed — hue-named on purpose. */
const pillClass = (hue: 'green' | 'yellow') =>
  cn(
    'inline-flex items-center rounded-oct-sm border px-snug py-hair type-caption font-mono font-bold uppercase tracking-wide mr-tight',
    hue === 'green' ? 'border-oct-green/60 bg-oct-green/15 text-oct-green' : 'border-oct-yellow/60 bg-oct-yellow/15 text-oct-yellow',
  );

const Strong = ({ children }: { children: ReactNode }) => <strong className="text-oct-text">{children}</strong>;

export default function HelpSection({ form }: { form: SettingsForm }) {
  const { exporting, importing, importError, importSuccess, importFileRef, handleExport, handleImportFile } = form;

  const [activeSection, setActiveSection] = useState('getting-started');

  const sections = [
    {
      id: 'getting-started',
      title: 'Getting Started',
      body: (
        <div className="space-y-cozy type-body text-oct-text">
          <Step n="01">Go to <Strong>Settings &gt; Guilds</Strong> and enable the Discord servers you want to monitor.</Step>
          <Step n="02">Click the <Strong>+</Strong> button next to "Rooms" in the sidebar to create a room.</Step>
          <Step n="03">Add channels from your enabled guilds into the room. A single room can aggregate channels from multiple servers.</Step>
          <Step n="04">Messages from all added channels will stream into the room in real time.</Step>
        </div>
      ),
    },
    {
      id: 'message-interactions',
      title: 'Message Interactions',
      body: (
        <div className="space-y-cozy">
          <Panel>
            <SubHeading>Channel Badge</SubHeading>
            <Line>Click the <Strong>server / #channel</Strong> badge on any message to jump to the original message in Discord. Configure whether it opens in the Discord app or browser in Settings &gt; General.</Line>
          </Panel>
          <Panel>
            <SubHeading>Badge Click Action</SubHeading>
            <Line>In Settings &gt; General, choose what badge clicks do: open in <Strong>Discord</Strong>, open in your <Strong>trading platform</Strong> (if a contract is detected), or <Strong>both</Strong>.</Line>
          </Panel>
          <Panel>
            <SubHeading>Image Lightbox</SubHeading>
            <Line>Click any image in a message to view it fullscreen. Press <Strong>ESC</Strong> to close.</Line>
          </Panel>
          <Panel>
            <SubHeading>Compact Messages</SubHeading>
            <Line>Messages from the same author within 5 minutes are grouped together. Hover over a compact message to see its timestamp.</Line>
          </Panel>
          <Panel>
            <SubHeading>Right-Click Users</SubHeading>
            <Line>Right-click a username to access the context menu where you can hide that user from the channel.</Line>
          </Panel>
        </div>
      ),
    },
    {
      id: 'focus-mode',
      title: 'Focus Mode',
      body: (
        <div className="space-y-cozy">
          <p className="type-body text-oct-muted">When a room has multiple channels, you can temporarily filter to a single channel:</p>
          <Panel>
            <Line kicker="Enter:">Click the <Eye size={13} className="inline text-oct-muted mx-hair" /> eye icon on any message to focus on that message's channel.</Line>
            <Line kicker="Active:">A "Focus Mode" badge appears in the channel header showing which channel you're filtering to. Only messages from that channel are displayed.</Line>
            <Line kicker="Exit:">Click the <span className="text-oct-text font-bold mx-hair">&times;</span> on the badge to return to the full room view.</Line>
          </Panel>
        </div>
      ),
    },
    {
      id: 'chat-quick-reply',
      title: 'Chat / Quick Reply',
      body: (
        <div className="space-y-cozy">
          <p className="type-body text-oct-muted">Send messages directly from the OCT dashboard without switching to Discord.</p>
          <Panel>
            <Line kicker="Enable:">Go to Settings &gt; General and turn on <Strong>Chat / Send Messages</Strong> (disabled by default).</Line>
            <Line kicker="Channel Selector:">Use the <Strong>#</Strong> icon in the message bar to pick which channel to send to.</Line>
            <Line kicker="Quick Reply:">Click the reply icon on any message to instantly select that channel in the input bar.</Line>
            <Line kicker="Focus Mode:">When focus mode is active, the chat input automatically targets the focused channel.</Line>
            <Line kicker="Attachments:">Attach images and files via the <Strong>+</Strong> button or paste from clipboard (up to 10 files).</Line>
          </Panel>
          <StatusBox tone="critical">
            <p className="type-caption font-mono font-bold uppercase tracking-[0.15em] mb-tight">Detection Risk</p>
            <p className="type-caption text-oct-muted">Sending messages through a third-party client increases the risk of Discord detecting and flagging your account. Read-only monitoring is passive and much safer.</p>
          </StatusBox>
        </div>
      ),
    },
    {
      id: 'contract-detection',
      title: 'Contract Detection',
      body: (
        <div className="space-y-cozy">
          <p className="type-body text-oct-muted">OCT automatically detects Solana and EVM contract addresses in messages.</p>
          <Panel>
            <Line><span className={pillClass('green')}>SOL</span> Solana addresses appear as green pills.</Line>
            <Line><span className={pillClass('yellow')}>EVM</span> EVM addresses (0x...) appear as yellow pills.</Line>
            <Line>Click a contract to <Strong>copy</Strong> and/or <Strong>open</Strong> it in your configured trading platform (configurable in Settings &gt; Contracts).</Line>
          </Panel>
          <Panel>
            <SubHeading>Contracts Dashboard</SubHeading>
            <Line>Click <Strong>Contracts</Strong> in the sidebar to see a live feed of all detected contracts, searchable and filterable by chain.</Line>
          </Panel>
          <Panel>
            <SubHeading>Auto-Open</SubHeading>
            <Line>Enable "Auto-Open Highlighted Contracts" in Settings &gt; Contracts to automatically open a new tab when a highlighted user posts a contract.</Line>
          </Panel>
        </div>
      ),
    },
    {
      id: 'user-highlighting',
      title: 'User Highlighting',
      body: (
        <div className="space-y-cozy">
          <p className="type-body text-oct-muted">Track specific Discord users to never miss their messages.</p>
          <Panel>
            <Line kicker="Global:">Add user IDs in Settings &gt; Highlighted Users. These users are highlighted in all rooms.</Line>
            <Line kicker="Per-Room:">Edit a room (hover &gt; gear icon) &gt; Users tab to add room-specific highlights.</Line>
            <Line>Highlighted messages appear with a <span className="text-oct-text font-medium">coloured border</span> — pick the colour per user above. Toast alerts pop up in the corner when they send a message.</Line>
          </Panel>
        </div>
      ),
    },
    {
      id: 'keyword-alerts',
      title: 'Keyword Alerts',
      body: (
        <div className="space-y-cozy">
          <p className="type-body text-oct-muted">Get alerted when messages match your keyword patterns.</p>
          <Panel>
            <Line kicker="Global:">Settings &gt; Keywords — matched in all rooms.</Line>
            <Line kicker="Per-Room:">Room config &gt; Keywords tab — only matched in that room.</Line>
            <Line>Three match modes: <Strong>Contains</Strong> (substring), <Strong>Exact</Strong> (whole word), and <Strong>Regex</Strong> (advanced patterns).</Line>
            <Line>Matched messages appear with an <span className="text-oct-yellow font-medium">orange border</span>.</Line>
          </Panel>
        </div>
      ),
    },
    {
      id: 'room-configuration',
      title: 'Room Configuration',
      body: (
        <Panel>
          <Line kicker="Edit/Delete:">Hover over a room in the sidebar to reveal the gear (edit) and trash (delete) icons.</Line>
          <Line kicker="Room Color:">Set a custom background color for the room in the config modal.</Line>
          <Line kicker="Disable Embeds:">Toggle embeds off for specific channels in the Channels tab of room config.</Line>
          <Line kicker="User Filter:">In the Filter tab, add user IDs to only show messages from those users in the room.</Line>
        </Panel>
      ),
    },
    {
      id: 'hiding-users',
      title: 'Hiding Users',
      body: (
        <Panel>
          <Line kicker="Hide:">Right-click any username &gt; "Hide user" to hide them from that specific channel.</Line>
          <Line kicker="Manage:">Click the hidden users icon in the channel header to view and unhide users.</Line>
        </Panel>
      ),
    },
    {
      id: 'sounds-notifications',
      title: 'Sounds & Notifications',
      body: (
        <div className="space-y-cozy">
          <Panel>
            <Line>Three independent sound channels with individual volume controls:</Line>
            <Line kicker="Highlighted User:">Plays when a highlighted user sends a message.</Line>
            <Line kicker="Contract Alert:">Plays when a contract address is detected.</Line>
            <Line kicker="Keyword Match:">Plays when a keyword pattern matches.</Line>
            <Line>Upload custom sounds (MP3, WAV, OGG) or use built-in tones. Configure in Settings &gt; Sounds.</Line>
          </Panel>
          <Panel>
            <SubHeading>Desktop Notifications</SubHeading>
            <Line>Enable in Settings &gt; Sounds &amp; Notifications. Browser notifications appear when the tab is not focused and a highlighted user or keyword match is detected.</Line>
          </Panel>
          <Panel>
            <SubHeading>Pushover</SubHeading>
            <Line>Push notifications to your phone via Pushover when highlighted users post contracts. Configure in Settings &gt; Pushover.</Line>
          </Panel>
        </div>
      ),
    },
    {
      id: 'guild-colors',
      title: 'Guild Colors',
      body: (
        <Panel>
          <Line>In Settings &gt; Guilds, assign a background color to each server. In rooms with multiple guilds, messages are color-coded so you can instantly tell which server a message came from.</Line>
        </Panel>
      ),
    },
    {
      id: 'direct-messages',
      title: 'Direct Messages',
      body: (
        <Panel>
          <Line>DMs automatically appear in the sidebar under "Direct Messages" when you receive new messages. Click one to view the conversation.</Line>
        </Panel>
      ),
    },
    {
      id: 'multiple-accounts',
      title: 'Multiple Accounts',
      body: (
        <Panel>
          <Line>Add multiple Discord tokens in Settings &gt; Tokens to monitor channels across different accounts simultaneously. All guilds and channels from all tokens are available when creating rooms.</Line>
        </Panel>
      ),
    },
  ];

  return (
    <>
      <SectionHeader title="Help & Features" blurb="Everything you need to know about using OCT.">
        {/* This in-app manual is the short version. The full guide is
            a separate site and used to be linked from nowhere. */}
        <a
          href={USER_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-cozy mt-cozy rounded-oct border border-oct-accent/40 bg-oct-accent-dim px-comfy py-cozy text-oct-accent transition-colors hover:border-oct-accent hover:bg-oct-accent/15"
        >
          <BookOpen size={15} className="shrink-0" />
          <span className="type-caption font-mono font-semibold uppercase tracking-[0.14em]">
            Full user guide
          </span>
          <ExternalLink size={13} className="shrink-0 opacity-70" />
        </a>
      </SectionHeader>

      <div className="flex flex-col lg:flex-row gap-comfy">
        <nav className="shrink-0 lg:w-52 rounded-oct border border-oct-border bg-oct-surface overflow-hidden">
          <Kicker className="px-comfy py-cozy border-b border-oct-border tracking-[0.2em]">[ Manual ]</Kicker>
          <div className="flex lg:flex-col overflow-x-auto">
            {sections.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setActiveSection(s.id)}
                className={cn(
                  'shrink-0 lg:w-full text-left px-comfy py-snug border-l-2 type-caption font-mono uppercase tracking-[0.12em] whitespace-nowrap transition-colors duration-100',
                  activeSection === s.id
                    ? 'border-oct-accent bg-oct-accent-dim text-oct-accent'
                    : 'border-transparent text-oct-muted hover:bg-oct-surface-raised hover:text-oct-text',
                )}
              >
                {s.title}
              </button>
            ))}
          </div>
        </nav>

        <div className="flex-1 min-w-0 oct-card p-comfy sm:p-roomy">
          {sections.map((s) => (
            activeSection === s.id ? (
              <div key={s.id}>
                <h4 className="type-title text-oct-text mb-comfy">{s.title}</h4>
                {s.body}
              </div>
            ) : null
          ))}
        </div>
      </div>

      <div className="pt-roomy border-t border-oct-border">
        <h4 className="type-title text-oct-text mb-tight">Backup &amp; Restore</h4>
        <Help className="mb-comfy">
          Export your settings and rooms to a file, or import from a previous backup.{' '}
          {isHostedMode
            ? 'Sensitive keys (Discord tokens, Telegram credentials, Pushover keys) are never included in exports.'
            : 'This includes your Discord tokens and Telegram credentials (API ID, hash, and session), so keep the file somewhere safe. Pushover keys are not included.'}
        </Help>
        <div className="flex flex-wrap gap-cozy">
          <button
            onClick={handleExport}
            disabled={exporting}
            className="oct-btn-primary inline-flex items-center gap-cozy px-comfy py-snug text-sm"
          >
            <Download size={15} />
            {exporting ? 'Exporting...' : 'Export Settings'}
          </button>
          <button
            onClick={() => importFileRef.current?.click()}
            disabled={importing}
            className="oct-icon-btn inline-flex items-center gap-cozy px-comfy py-snug text-sm"
          >
            <Upload size={15} />
            {importing ? 'Importing...' : 'Import Settings'}
          </button>
          <input
            ref={importFileRef}
            type="file"
            accept=".json"
            onChange={handleImportFile}
            className="hidden"
          />
        </div>
        {importError && <StatusText tone="critical" className="mt-cozy">{importError}</StatusText>}
        {importSuccess && <StatusText tone="good" className="mt-cozy">Settings imported successfully.</StatusText>}
      </div>
    </>
  );
}
