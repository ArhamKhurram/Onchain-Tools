import {
  AlertTriangle,
  Flame,
  Megaphone,
  Rocket,
  Search,
  TrendingUp,
  User,
  UserPlus,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { Alert } from '../types';

export function alertBorderClass(type: Alert['type']): string {
  switch (type) {
    case 'missed_runner':
      return 'border-l-oct-accent';
    case 'signal_convergence':
      return 'border-l-oct-green';
    case 'highlighted_user':
      return 'border-l-oct-accent';
    case 'keyword_match':
      return 'border-l-orange-400';
    case 'pump_callout':
      return 'border-l-purple-400';
    case 'fomo_join':
      return 'border-l-teal-400';
    case 'revival':
      return 'border-l-red-500';
    case 'breakout':
      // Amber/gold — one tier quieter than revival's red by design.
      return 'border-l-oct-accent-2';
    default:
      return 'border-l-oct-yellow';
  }
}

export function alertIcon(type: Alert['type']): LucideIcon {
  switch (type) {
    case 'missed_runner':
      return TrendingUp;
    case 'signal_convergence':
      return Zap;
    case 'highlighted_user':
      return User;
    case 'keyword_match':
      return Search;
    case 'pump_callout':
      return Megaphone;
    case 'fomo_join':
      return UserPlus;
    case 'revival':
      return Flame;
    case 'breakout':
      return Rocket;
    default:
      return AlertTriangle;
  }
}

export function alertIconClass(type: Alert['type']): string {
  switch (type) {
    case 'missed_runner':
      return 'text-oct-accent';
    case 'signal_convergence':
      return 'text-oct-green';
    case 'highlighted_user':
      return 'text-discord-blurple';
    case 'keyword_match':
      return 'text-orange-400';
    case 'pump_callout':
      return 'text-purple-400';
    case 'fomo_join':
      return 'text-teal-400';
    case 'revival':
      return 'text-red-500';
    case 'breakout':
      return 'text-oct-accent-2';
    default:
      return 'text-discord-yellow';
  }
}

export function alertPreview(alert: Alert): string {
  const content = alert.message.content?.trim();
  if (content) {
    return content.length > 120 ? `${content.slice(0, 120)}…` : content;
  }
  const channel = alert.message.channelName;
  if (channel) return `#${channel}`;
  return '';
}

export function alertTimeAgo(timestamp: number): string {
  const sec = Math.floor((Date.now() - timestamp) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export function openAlertTarget(alert: Alert): void {
  const url = alert.message.platformUrl;
  if (url) {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
