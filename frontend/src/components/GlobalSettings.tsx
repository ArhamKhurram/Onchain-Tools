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
      <div className="md:hidden shrink-0 oct-headerbar">
        <div className="px-3 pt-3 pb-2 flex items-center gap-2">
          {sidebarCollapsed && (
            <button
              onClick={toggleSidebar}
              className="oct-icon-btn p-1.5"
              title="Show sidebar"
            >
              <PanelLeftOpen size={16} />
            </button>
          )}
          <button
            onClick={() => guardNavigation(() => navigate(routes.feed))}
            className="oct-icon-btn p-1.5"
            title="Back to feed"
          >
            <ArrowLeft size={16} />
          </button>
          <h2 className="oct-eyebrow text-oct-text">Settings</h2>
        </div>
        <nav className="flex overflow-x-auto px-2 pb-2 gap-1 scrollbar-none">
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => { if (id !== section) setSection(id); }}
              data-active={section === id}
              className="oct-subnav-tab flex items-center gap-1.5 px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.1em] whitespace-nowrap shrink-0"
            >
              <Icon size={13} className="shrink-0" />
              {label}
            </button>
          ))}
        </nav>
      </div>

      {/* Desktop sidebar nav */}
      <div className="hidden md:flex w-60 bg-oct-panel border-r border-oct-border flex-col shrink-0">
        <div className="px-4 pt-5 pb-3 flex items-center gap-2 oct-headerbar">
          {sidebarCollapsed && (
            <button
              onClick={toggleSidebar}
              className="oct-icon-btn p-1.5"
              title="Show sidebar"
            >
              <PanelLeftOpen size={16} />
            </button>
          )}
          <button
            onClick={() => guardNavigation(() => navigate(routes.feed))}
            className="oct-icon-btn p-1.5"
            title="Back to feed"
          >
            <ArrowLeft size={16} />
          </button>
          <h2 className="oct-eyebrow text-oct-text">Settings</h2>
        </div>
        <nav className="flex-1 px-2 py-3 space-y-0.5">
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => { if (id !== section) setSection(id); }}
              data-active={section === id}
              className="oct-subnav-tab w-full flex items-center gap-2.5 px-3 py-2 font-mono text-xs text-left uppercase tracking-[0.08em] font-semibold"
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
        <div className={`border-t px-3 sm:px-8 py-2.5 sm:py-3 flex items-center justify-between gap-2 sm:gap-3 shrink-0 transition-colors duration-150 ${
          hasUnsavedChanges ? 'border-oct-yellow/60 bg-oct-yellow/10' : 'border-oct-border bg-oct-panel'
        }`}>
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <span className="font-mono text-[11px] uppercase tracking-wide text-oct-muted select-text whitespace-nowrap">
              OCT v{__APP_VERSION__}
            </span>
            <span className={`font-mono text-[11px] sm:text-xs uppercase tracking-wide transition-opacity ${hasUnsavedChanges ? 'opacity-100 text-oct-yellow' : 'opacity-0'}`}>
              Unsaved changes
            </span>
            {saveError && (
              <span className="font-mono text-[11px] sm:text-xs text-oct-flame truncate" title={saveError}>
                {saveError}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            {hasUnsavedChanges && (
              <button
                onClick={() => { if (config) fetchConfig(); }}
                className="oct-icon-btn px-3 sm:px-4 py-1.5 sm:py-2 text-xs sm:text-sm"
              >
                Reset
              </button>
            )}
            <button
              onClick={handleSave}
              disabled={saving || !hasUnsavedChanges}
              className="oct-btn-primary px-4 sm:px-5 py-1.5 sm:py-2 text-xs sm:text-sm"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
