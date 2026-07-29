import { routes } from '../lib/routes';
import { ArrowLeft, PanelLeftOpen } from 'lucide-react';
import { SECTIONS } from './settings/constants';
import { useSettingsForm } from './settings/useSettingsForm';
import TokensSection from './settings/sections/TokensSection';
import GeneralSection from './settings/sections/GeneralSection';
import ContractsSection from './settings/sections/ContractsSection';
import CallerQualitySection from './settings/sections/CallerQualitySection';
import SoundsSection from './settings/sections/SoundsSection';
import PushoverSection from './settings/sections/PushoverSection';
import DiscordBotSection from './settings/sections/DiscordBotSection';
import KeywordsSection from './settings/sections/KeywordsSection';
import MentionsSection from './settings/sections/MentionsSection';
import UsersSection from './settings/sections/UsersSection';
import HelpSection from './settings/sections/HelpSection';
import GuildsSection from './settings/sections/GuildsSection';

export default function GlobalSettings() {
  const form = useSettingsForm();
  const {
    section, setSection, sidebarCollapsed, toggleSidebar, guardNavigation, navigate,
    hasUnsavedChanges, saveError, config, fetchConfig, handleSave, saving,
  } = form;

  return (
    <div className="flex-1 flex flex-col md:flex-row h-full w-full min-w-0 bg-oct-bg">
      {/* Mobile header + horizontal nav */}
      <div className="md:hidden shrink-0 border-b-2 border-black bg-black">
        <div className="px-3 pt-3 pb-2 flex items-center gap-2">
          {sidebarCollapsed && (
            <button
              onClick={toggleSidebar}
              className="p-1 text-oct-muted hover:text-oct-text transition-colors"
              title="Show sidebar"
            >
              <PanelLeftOpen size={16} />
            </button>
          )}
          <button
            onClick={() => guardNavigation(() => navigate(routes.feed))}
            className="p-1 text-oct-muted hover:text-oct-text transition-colors"
            title="Back to feed"
          >
            <ArrowLeft size={16} />
          </button>
          <h2 className="font-mono text-xs uppercase tracking-[0.15em] text-oct-text">Settings</h2>
        </div>
        <nav className="flex overflow-x-auto px-2 pb-2 gap-1 scrollbar-none">
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => { if (id !== section) setSection(id); }}
              className={`flex items-center gap-1.5 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.1em] whitespace-nowrap shrink-0 transition-colors border-2 ${
                section === id
                  ? 'border-oct-accent text-oct-accent bg-oct-accent/10'
                  : 'border-transparent text-oct-muted hover:text-oct-text'
              }`}
            >
              <Icon size={13} className="shrink-0" />
              {label}
            </button>
          ))}
        </nav>
      </div>

      {/* Desktop sidebar nav */}
      <div className="hidden md:flex w-60 bg-black border-r-2 border-black flex-col shrink-0">
        <div className="px-4 pt-5 pb-3 flex items-center gap-2 border-b border-oct-border">
          {sidebarCollapsed && (
            <button
              onClick={toggleSidebar}
              className="p-1 text-oct-muted hover:text-oct-text transition-colors"
              title="Show sidebar"
            >
              <PanelLeftOpen size={16} />
            </button>
          )}
          <button
            onClick={() => guardNavigation(() => navigate(routes.feed))}
            className="p-1 text-oct-muted hover:text-oct-text transition-colors"
            title="Back to feed"
          >
            <ArrowLeft size={16} />
          </button>
          <h2 className="font-mono text-xs uppercase tracking-[0.15em] text-oct-text">Settings</h2>
        </div>
        <nav className="flex-1 px-2 py-3 space-y-0.5">
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => { if (id !== section) setSection(id); }}
              className={`w-full flex items-center gap-2.5 px-3 py-2 font-mono text-xs text-left uppercase tracking-[0.08em] transition-colors border-l-2 ${
                section === id
                  ? 'border-oct-accent text-oct-accent bg-oct-accent/5'
                  : 'border-transparent text-oct-muted hover:text-oct-text hover:bg-oct-surface'
              }`}
            >
              <Icon size={16} className="shrink-0" />
              <span className="truncate">{label}</span>
            </button>
          ))}
        </nav>
      </div>

      {/* Content area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <div className="flex-1 overflow-y-auto overflow-x-hidden">
          <div className="w-full max-w-2xl mx-auto px-3 sm:px-6 md:px-8 py-3 sm:py-6 space-y-5 sm:space-y-6" data-form-type="other" data-lpignore="true" data-1p-ignore>

            {section === 'tokens' && <TokensSection form={form} />}
            {section === 'general' && <GeneralSection form={form} />}
            {section === 'contracts' && <ContractsSection form={form} />}
            {section === 'callerquality' && <CallerQualitySection form={form} />}
            {section === 'sounds' && <SoundsSection form={form} />}
            {section === 'pushover' && <PushoverSection form={form} />}
          {section === 'discordbot' && <DiscordBotSection form={form} />}
            {section === 'keywords' && <KeywordsSection form={form} />}
            {section === 'mentions' && <MentionsSection form={form} />}
            {section === 'users' && <UsersSection form={form} />}
            {section === 'help' && <HelpSection form={form} />}
            {section === 'guilds' && <GuildsSection form={form} />}
          </div>
        </div>

        {/* Save bar */}
        <div className={`border-t px-3 sm:px-8 py-2.5 sm:py-3 flex items-center justify-between gap-2 sm:gap-3 shrink-0 transition-colors ${
          hasUnsavedChanges ? 'border-discord-yellow/30 bg-discord-yellow/5' : 'border-discord-divider bg-discord-dark'
        }`}>
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <span className="text-[11px] text-discord-text-muted select-text whitespace-nowrap">
              OCT v{__APP_VERSION__}
            </span>
            <span className={`text-[11px] sm:text-sm transition-opacity ${hasUnsavedChanges ? 'opacity-100 text-discord-yellow' : 'opacity-0'}`}>
              Unsaved changes
            </span>
            {saveError && (
              <span className="text-[11px] sm:text-sm text-red-400 truncate" title={saveError}>
                {saveError}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            {hasUnsavedChanges && (
              <button
                onClick={() => { if (config) fetchConfig(); }}
                className="px-3 sm:px-4 py-1.5 sm:py-2 rounded text-xs sm:text-sm text-discord-text-muted hover:text-white font-medium transition-colors"
              >
                Reset
              </button>
            )}
            <button
              onClick={handleSave}
              disabled={saving || !hasUnsavedChanges}
              className={`px-4 sm:px-5 py-1.5 sm:py-2 rounded text-xs sm:text-sm text-white font-medium transition-colors ${
                hasUnsavedChanges
                  ? 'bg-discord-green hover:bg-discord-green/80'
                  : 'bg-discord-blurple hover:bg-discord-blurple-hover disabled:opacity-50 disabled:cursor-not-allowed'
              }`}
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
