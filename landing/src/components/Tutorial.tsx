import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Package, ArrowRight, KeyRound, Play, AlertTriangle, Send } from 'lucide-react';
import { AnimatedSection } from './AnimatedSection';
import { APP_CONSOLE_PATH } from '../constants';

const tabs = [
  { id: 'requirements', label: 'Requirements', icon: Package },
  { id: 'getting-started', label: 'Getting Started', icon: ArrowRight },
  { id: 'token', label: 'Discord Token', icon: KeyRound },
  { id: 'telegram', label: 'Telegram', icon: Send },
  { id: 'running', label: 'Running', icon: Play },
] as const;

type TabId = (typeof tabs)[number]['id'];

function RequirementsContent() {
  return (
    <div className="space-y-4">
      <p className="text-dc-text-muted text-sm">Make sure you have the following installed:</p>
      <div className="space-y-2">
        {[
          { name: 'Node.js', version: 'v18 or higher', link: 'https://nodejs.org' },
          { name: 'npm', version: 'Comes with Node.js', link: null },
          { name: 'Git', version: 'Any recent version', link: 'https://git-scm.com' },
        ].map((req) => (
          <div key={req.name} className="bg-dc-main rounded-lg p-4 flex items-center justify-between border border-dc-divider/50">
            <div>
              <span className="text-dc-text font-medium text-sm">{req.name}</span>
              <span className="text-dc-text-faint text-xs ml-2">{req.version}</span>
            </div>
            {req.link && (
              <a
                href={req.link}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-dc-text hover:text-white hover:underline"
              >
                Download
              </a>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function GettingStartedContent() {
  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3 rounded-lg border border-oct-accent/30 bg-oct-accent-dim p-4">
        <ArrowRight size={18} className="text-oct-accent shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-semibold text-oct-accent">Ready to go?</p>
          <p className="text-xs text-dc-text-muted mt-1">
            OCT is a web-only console — no downloads or local setup required.{' '}
            <a href={APP_CONSOLE_PATH} className="text-oct-accent hover:underline">
              Launch the console
            </a>{' '}
            and sign in to get started. The steps below cover connecting Discord and Telegram.
          </p>
        </div>
      </div>

      <p className="text-dc-text-muted text-sm">Quick start checklist:</p>

      <div className="space-y-2">
        {[
          { step: '1', text: 'Create an OCT account at the web console' },
          { step: '2', text: 'Connect your Discord token in Settings' },
          { step: '3', text: 'Configure rooms for your alpha channels' },
          { step: '4', text: 'Optionally connect Telegram for unified feeds' },
        ].map((item) => (
          <div key={item.step} className="bg-dc-main rounded-lg p-4 flex items-center gap-3 border border-dc-divider/50">
            <div className="shrink-0 w-6 h-6 rounded bg-dc-dark border border-dc-divider flex items-center justify-center">
              <span className="text-[11px] font-bold text-oct-accent">{item.step}</span>
            </div>
            <span className="text-dc-text text-sm">{item.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TokenContent() {
  const steps = [
    'Open Discord in your browser at discord.com/app',
    'Open Developer Tools (F12 or Ctrl+Shift+I)',
    'Go to the Network tab',
    'Refresh the page (Ctrl+R)',
    'Search for @me in the network filter',
    'Click the request, go to Headers',
    'Find authorization in Request Headers — that\'s your token',
  ];

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3 rounded-lg border border-dc-yellow/30 bg-dc-yellow/5 p-4">
        <AlertTriangle size={18} className="text-dc-yellow shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-semibold text-dc-yellow">Keep your token safe</p>
          <p className="text-xs text-dc-text-muted mt-1">
            Never share your Discord token with anyone. Using self-bots is against Discord's Terms
            of Service — use at your own risk and for personal use only.
          </p>
        </div>
      </div>

      <div className="space-y-2.5">
        {steps.map((step, i) => (
          <div key={i} className="flex items-start gap-3">
            <div className="shrink-0 w-6 h-6 rounded bg-dc-dark border border-dc-divider flex items-center justify-center">
              <span className="text-[11px] font-bold text-dc-text">{i + 1}</span>
            </div>
            <div className="pt-0.5">
              <p className="text-sm text-dc-text-muted">{step}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="space-y-2">
        <p className="text-xs text-dc-text-faint">Once you have your token, paste it into the setup screen on first launch:</p>
        <img
          src="/discord_token.png"
          alt="OCT token setup screen"
          className="rounded-lg border border-dc-divider shadow-lg shadow-black/30"
        />
      </div>
    </div>
  );
}

function TelegramContent() {
  const steps = [
    { title: 'Go to my.telegram.org', desc: 'Open my.telegram.org in your browser and log in with your phone number.' },
    { title: 'Navigate to API Development Tools', desc: 'Click "API development tools" on the main page after logging in.' },
    { title: 'Create a new application', desc: 'Fill in the app title (e.g. "Onchain Tools") and short name. Platform can be left as "Desktop".' },
    { title: 'Copy your API ID and API Hash', desc: 'After creating the app, you\'ll see your api_id (a number) and api_hash (a long string). Copy both.' },
    { title: 'Connect in OCT', desc: 'Open the OCT console, go to Settings, and click "Connect Telegram". Paste your API ID and API Hash, then enter your phone number.' },
    { title: 'Verify with code', desc: 'Telegram will send a verification code to your Telegram app. Enter it in OCT. If you have 2FA enabled, you\'ll also be prompted for your password.' },
  ];

  return (
    <div className="space-y-5">
      <p className="text-dc-text-muted text-sm">
        Telegram integration lets you monitor groups, channels, and DMs alongside Discord — all in the same rooms.
      </p>

      <div className="flex items-start gap-3 rounded-lg border border-dc-blurple/30 bg-dc-blurple/5 p-4">
        <AlertTriangle size={18} className="text-dc-blurple shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-semibold text-dc-blurple">Your credentials are safe</p>
          <p className="text-xs text-dc-text-muted mt-1">
            Your API ID, API hash, and session are encrypted at rest with AES-256-GCM. Your phone number and 2FA password are never stored or logged — they're used only during the auth handshake.
          </p>
        </div>
      </div>

      <div>
        <span className="text-[10px] font-bold tracking-widest text-dc-text-faint uppercase">
          Getting your Telegram API credentials
        </span>
        <div className="space-y-2.5 mt-3">
          {steps.map((step, i) => (
            <div key={i} className="flex items-start gap-3">
              <div className="shrink-0 w-6 h-6 rounded bg-dc-dark border border-dc-divider flex items-center justify-center">
                <span className="text-[11px] font-bold text-dc-text">{i + 1}</span>
              </div>
              <div className="pt-0.5">
                <p className="text-sm text-dc-text font-medium">{step.title}</p>
                <p className="text-xs text-dc-text-muted mt-0.5">{step.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-dc-main rounded-lg p-3 mt-2 border border-dc-divider/50">
        <p className="text-xs text-dc-text-faint">
          Once connected, you can add Telegram chats to any room alongside Discord channels. Messages from both platforms appear in a unified feed.
        </p>
      </div>
    </div>
  );
}

function RunningContent() {
  return (
    <div className="space-y-4">
      <p className="text-dc-text-muted text-sm">Access the OCT web console:</p>
      <div>
        <span className="text-[10px] font-bold tracking-widest text-dc-text-faint uppercase">
          Launch Console
        </span>
        <div className="code-block mt-1.5">
          <a href={APP_CONSOLE_PATH} className="text-oct-accent hover:underline">{APP_CONSOLE_PATH}</a>
        </div>
      </div>
      <p className="text-dc-text-muted text-sm">
        Sign in with your OCT account, then connect your Discord token in Settings.
        You&apos;ll be guided through room setup on first launch.
      </p>
      <div className="bg-dc-main rounded-lg p-3 mt-2 border border-dc-divider/50">
        <p className="text-xs text-dc-text-faint">
          For development with hot-reload, use{' '}
          <span className="text-dc-text-muted font-mono">npm run dev</span>{' '}
          instead.
        </p>
      </div>
    </div>
  );
}

const tabContent: Record<TabId, React.FC> = {
  requirements: RequirementsContent,
  'getting-started': GettingStartedContent,
  token: TokenContent,
  telegram: TelegramContent,
  running: RunningContent,
};

export function Tutorial() {
  const [activeTab, setActiveTab] = useState<TabId>('requirements');

  const Content = tabContent[activeTab];

  return (
    <section id="setup" className="relative py-20 px-6 scroll-mt-14 pb-28">
      <div className="mx-auto max-w-3xl">
        <AnimatedSection className="text-center mb-10">
          <h2 className="text-2xl sm:text-4xl font-bold text-white">
            Setup Guide
          </h2>
          <p className="mt-3 text-dc-text-muted max-w-md mx-auto text-sm">
            From zero to monitoring in under 5 minutes.
          </p>
        </AnimatedSection>

        <AnimatedSection delay={0.15}>
          <div className="bg-dc-sidebar rounded-lg border border-dc-divider overflow-hidden">
            {/* Tab bar */}
            <div className="flex border-b border-dc-divider">
              {tabs.map((tab) => {
                const Icon = tab.icon;
                const isActive = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 text-xs font-medium transition-colors relative ${
                      isActive
                        ? 'text-white'
                        : 'text-dc-text-muted hover:text-dc-text hover:bg-dc-hover/30'
                    } ${
                      (tab.id === 'token' || tab.id === 'telegram') && !isActive
                        ? 'text-dc-yellow/60 hover:text-dc-yellow/80'
                        : ''
                    }`}
                  >
                    <Icon size={14} />
                    <span className="hidden sm:inline">{tab.label}</span>
                    {isActive && (
                      <motion.div
                        layoutId="tab-indicator"
                        className="absolute bottom-0 left-0 right-0 h-0.5 bg-oct-accent"
                      />
                    )}
                  </button>
                );
              })}
            </div>

            <div className="p-6 min-h-[300px]">
              <AnimatePresence mode="wait">
                <motion.div
                  key={activeTab}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.15 }}
                >
                  <Content />
                </motion.div>
              </AnimatePresence>
            </div>
          </div>
        </AnimatedSection>
      </div>
    </section>
  );
}
