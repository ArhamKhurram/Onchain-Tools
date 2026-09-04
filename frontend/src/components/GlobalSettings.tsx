import { lazy, Suspense } from 'react';
import { routes } from '../lib/routes';
import { cn } from '../lib/utils';
import { AnimatePresence, fadeIn, fadeInUp, m, MotionFeatures, useTransition } from '../lib/motion';
import { ArrowLeft, PanelLeftOpen } from 'lucide-react';
import { SECTIONS } from './settings/constants';
import { useSettingsForm } from './settings/useSettingsForm';
import TokensSection from './settings/sections/TokensSection';
import GeneralSection from './settings/sections/GeneralSection';
import ContractsSection from './settings/sections/ContractsSection';
import SoundsSection from './settings/sections/SoundsSection';
import PushoverSection from './settings/sections/PushoverSection';
import DiscordBotSection from './settings/sections/DiscordBotSection';
import KeywordsSection from './settings/sections/KeywordsSection';
import MentionsSection from './settings/sections/MentionsSection';
import UsersSection from './settings/sections/UsersSection';
import GuildsSection from './settings/sections/GuildsSection';
import FullPageSpinner from './common/FullPageSpinner';

// Two sections split out of the GlobalSettings chunk. Help is ~340 lines of
// static prose that most visits never open; Caller Quality pulls in the
// scoring hook and `@oct/shared`. Both are self-contained (they take `form`
// like every other section) so the split costs one Suspense boundary and
// nothing else. The rest are small enough that a split would cost more in
// request overhead than it saves.
const CallerQualitySection = lazy(() => import('./settings/sections/CallerQualitySection'));
const HelpSection = lazy(() => import('./settings/sections/HelpSection'));

export default function GlobalSettings() {
  const form = useSettingsForm();
  const {
    section, setSection, sidebarCollapsed, toggleSidebar, guardNavigation, navigate,
    hasUnsavedChanges, saveError, config, fetchConfig, handleSave, saving,
  } = form;

  // Chrome-only motion: the page rises in once, and the content column
  // crossfades when the active section changes. Nothing inside a section
  // animates — settings forms are static, but the rule is the same one the
  // feed follows (see lib/motion.ts). Motion arrives with this lazily-loaded
  // chunk, so it stays off the boot path.
  const enter = useTransition('snappy');
  const swap = useTransition('fade');

  return (
    <MotionFeatures>
      <m.div
        variants={fadeInUp}
        initial="hidden"
        animate="visible"
        transition={enter}
        className="flex-1 flex flex-col md:flex-row h-full w-full min-w-0 bg-oct-bg"
      >
        {/* Mobile header + horizontal nav */}
        <div className="md:hidden shrink-0 oct-headerbar">
          <div className="px-comfy pt-comfy pb-cozy flex items-center gap-cozy">
            {sidebarCollapsed && (
              <button
                onClick={toggleSidebar}
                className="oct-icon-btn p-snug"
                title="Show sidebar"
              >
                <PanelLeftOpen size={16} />
              </button>
            )}
            <button
              onClick={() => guardNavigation(() => navigate(routes.feed))}
              className="oct-icon-btn p-snug"
              title="Back to feed"
            >
              <ArrowLeft size={16} />
            </button>
            <h2 className="type-caption font-mono uppercase tracking-[0.14em] text-oct-text">Settings</h2>
          </div>
          <nav className="flex overflow-x-auto px-cozy pb-cozy gap-tight scrollbar-none">
            {SECTIONS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => { if (id !== section) setSection(id); }}
                data-active={section === id}
                className="oct-subnav-tab flex items-center gap-snug px-comfy py-snug font-mono text-2xs font-bold uppercase tracking-[0.1em] whitespace-nowrap shrink-0"
              >
                <Icon size={13} className="shrink-0" />
                {label}
              </button>
            ))}
          </nav>
        </div>

        {/* Desktop sidebar nav */}
        <div className="hidden md:flex w-56 bg-oct-panel border-r border-oct-border flex-col shrink-0">
          <div className="px-comfy pt-roomy pb-cozy flex items-center gap-cozy oct-headerbar">
            {sidebarCollapsed && (
              <button
                onClick={toggleSidebar}
                className="oct-icon-btn p-snug"
                title="Show sidebar"
              >
                <PanelLeftOpen size={16} />
              </button>
            )}
            <button
              onClick={() => guardNavigation(() => navigate(routes.feed))}
              className="oct-icon-btn p-snug"
              title="Back to feed"
            >
              <ArrowLeft size={16} />
            </button>
            <h2 className="type-caption font-mono uppercase tracking-[0.14em] text-oct-text">Settings</h2>
          </div>
          <nav className="flex-1 px-cozy py-cozy space-y-hair">
            {SECTIONS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => { if (id !== section) setSection(id); }}
                data-active={section === id}
                className="oct-subnav-tab w-full flex items-center gap-cozy px-comfy py-snug font-mono text-xs text-left uppercase tracking-[0.08em] font-semibold"
              >
                <Icon size={15} className="shrink-0" />
                <span className="truncate">{label}</span>
              </button>
            ))}
          </nav>
        </div>

        {/* Content area */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <div className="flex-1 overflow-y-auto overflow-x-hidden">
            {/* `mode="wait"` lets the outgoing section fade before the next
                mounts, so two forms never overlap mid-swap. `initial={false}`
                keeps the first section from double-animating under the page
                entrance above. */}
            <AnimatePresence mode="wait" initial={false}>
              <m.div
                key={section}
                variants={fadeIn}
                initial="hidden"
                animate="visible"
                exit="hidden"
                transition={swap}
                className="w-full max-w-3xl mx-auto px-comfy sm:px-section py-comfy sm:py-roomy space-y-roomy"
                data-form-type="other"
                data-lpignore="true"
                data-1p-ignore
              >
                {section === 'tokens' && <TokensSection form={form} />}
                {section === 'general' && <GeneralSection form={form} />}
                {section === 'contracts' && <ContractsSection form={form} />}
                {section === 'sounds' && <SoundsSection form={form} />}
                {section === 'pushover' && <PushoverSection form={form} />}
                {section === 'discordbot' && <DiscordBotSection form={form} />}
                {section === 'keywords' && <KeywordsSection form={form} />}
                {section === 'mentions' && <MentionsSection form={form} />}
                {section === 'users' && <UsersSection form={form} />}
                {section === 'guilds' && <GuildsSection form={form} />}
                {(section === 'callerquality' || section === 'help') && (
                  <Suspense fallback={<FullPageSpinner className="w-full py-gutter" />}>
                    {section === 'callerquality' && <CallerQualitySection form={form} />}
                    {section === 'help' && <HelpSection form={form} />}
                  </Suspense>
                )}
              </m.div>
            </AnimatePresence>
          </div>

          {/* Save bar. Unsaved state is a caution, so it reads in `oct-warn`;
              a failed save is `oct-critical`. Neither borrows the accent. */}
          <div
            className={cn(
              'border-t px-comfy sm:px-section py-cozy sm:py-comfy flex items-center justify-between gap-cozy sm:gap-comfy shrink-0 transition-colors duration-150',
              hasUnsavedChanges ? 'border-oct-warn/60 bg-oct-warn-dim' : 'border-oct-border bg-oct-panel',
            )}
          >
            <div className="flex items-center gap-cozy sm:gap-comfy min-w-0">
              <span className="type-data uppercase tracking-wide text-oct-muted select-text whitespace-nowrap">
                OCT v{__APP_VERSION__}
              </span>
              <span
                className={cn(
                  'type-caption font-mono uppercase tracking-wide transition-opacity',
                  hasUnsavedChanges ? 'opacity-100 text-oct-warn' : 'opacity-0',
                )}
              >
                Unsaved changes
              </span>
              {saveError && (
                <span className="type-caption font-mono text-oct-critical truncate" title={saveError}>
                  {saveError}
                </span>
              )}
            </div>
            <div className="flex items-center gap-cozy">
              {hasUnsavedChanges && (
                <button
                  onClick={() => { if (config) fetchConfig(); }}
                  className="oct-icon-btn px-comfy py-snug text-xs sm:text-sm"
                >
                  Reset
                </button>
              )}
              <button
                onClick={handleSave}
                disabled={saving || !hasUnsavedChanges}
                className="oct-btn-primary px-roomy py-snug text-xs sm:text-sm"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      </m.div>
    </MotionFeatures>
  );
}
