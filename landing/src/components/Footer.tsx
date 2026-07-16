import { ArrowRight } from 'lucide-react';
import { OctLogo } from './OctLogo';
import { APP_CONSOLE_PATH } from '../constants';

export function Footer() {
  return (
    <footer className="border-t border-dc-divider bg-dc-sidebar py-8 px-6">
      <div className="mx-auto max-w-6xl flex flex-col sm:flex-row items-center justify-between gap-4">
        <OctLogo size="sm" showSubtitle />
        <p className="text-[11px] text-dc-text-faint text-center max-w-md leading-relaxed">
          Onchain Tools (OCT) is an independent project and is not affiliated with Discord Inc.
          Using self-bots is against Discord&apos;s Terms of Service. This tool is for personal
          and educational use only. Use at your own risk.
        </p>
        <div className="flex items-center gap-3">
          <a
            href={APP_CONSOLE_PATH}
            className="text-dc-text-muted hover:text-oct-accent transition-colors flex items-center gap-1.5 text-xs font-medium"
          >
            <ArrowRight size={14} />
            Launch Console
          </a>
        </div>
      </div>
    </footer>
  );
}
