import { motion } from 'framer-motion';
import {
  MessagesSquare,
  Wallet,
  ScanSearch,
  UserCheck,
  MousePointerClick,
  Bell,
  Radio,
  Volume2,
  Zap,
  Link2,
  Send,
} from 'lucide-react';
import { StaggerContainer, fadeUpVariant } from './AnimatedSection';
import { AnimatedSection } from './AnimatedSection';

const primaryFeatures = [
  {
    icon: MessagesSquare,
    title: 'Feed',
    desc: 'Live Discord and Telegram chat aggregated into unified rooms. Monitor alpha channels, DMs, and contract drops in real time.',
    span: 'md:col-span-2',
    primary: true,
  },
  {
    icon: Wallet,
    title: 'Wallets',
    desc: 'Privately track wallets you care about. Get alerts when tracked addresses move — your watchlist stays yours.',
    span: 'md:col-span-2',
    primary: true,
  },
  {
    icon: ScanSearch,
    title: 'Callers',
    desc: 'Contract radar that catches Solana and EVM addresses the moment they appear in chat. One click to trade on Axiom, GMGN, and more.',
    span: 'md:col-span-2',
    primary: true,
  },
];

const supportingFeatures = [
  {
    icon: UserCheck,
    title: 'User Highlighting',
    desc: 'Track key callers across all channels with visual alerts.',
    span: '',
  },
  {
    icon: MousePointerClick,
    title: 'One-Click Trading',
    desc: 'Click contracts to open Axiom, GMGN, Bloom, Padre and more.',
    span: '',
  },
  {
    icon: Bell,
    title: 'Push Notifications',
    desc: 'Pushover alerts when highlighted users post contracts.',
    span: '',
  },
  {
    icon: Send,
    title: 'Quick Reply & Chat',
    desc: 'Send messages and files directly from the console.',
    span: '',
  },
  {
    icon: Radio,
    title: 'Real-time Streaming',
    desc: 'Live message updates via Discord Gateway.',
    span: '',
  },
  {
    icon: Volume2,
    title: 'Sound Alerts',
    desc: 'Audio notifications for highlighted messages.',
    span: '',
  },
  {
    icon: Zap,
    title: 'Auto-Open Contracts',
    desc: 'Automatically open links when highlighted users post contracts.',
    span: '',
  },
  {
    icon: Link2,
    title: 'Custom Link Templates',
    desc: 'Configure which trading platform links generate for contracts.',
    span: '',
  },
];

const features = [...primaryFeatures, ...supportingFeatures];

export function Features() {
  return (
    <section id="features" className="relative py-20 px-6 bg-dc-sidebar scroll-mt-14 border-y border-dc-divider">
      <div className="mx-auto max-w-6xl">
        <AnimatedSection className="text-center mb-12">
          <h2 className="text-2xl sm:text-4xl font-bold text-white">
            Built for Onchain Alpha
          </h2>
          <p className="mt-3 text-dc-text-muted max-w-xl mx-auto text-sm">
            Feed, Wallets, and Callers — the three pillars of your crypto terminal, plus everything
            you need to move fast.
          </p>
        </AnimatedSection>

        <StaggerContainer
          className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3"
          staggerDelay={0.04}
        >
          {features.map((f) => {
            const Icon = f.icon;
            const isPrimary = 'primary' in f && f.primary;

            return (
              <motion.div
                key={f.title}
                variants={fadeUpVariant}
                className={`rounded-lg p-5 flex flex-col gap-3 border transition-colors ${f.span} ${
                  isPrimary
                    ? 'bg-dc-main border-oct-accent/30 hover:border-oct-accent/50 shadow-oct-glow-sm'
                    : 'bg-dc-main border-dc-divider/50 hover:border-dc-divider'
                }`}
              >
                <div
                  className={`w-9 h-9 rounded-lg flex items-center justify-center ${
                    isPrimary
                      ? 'bg-oct-accent-dim text-oct-accent'
                      : 'bg-dc-dark text-dc-text'
                  }`}
                >
                  <Icon size={18} />
                </div>
                <h3 className={`font-semibold text-sm ${isPrimary ? 'text-white' : 'text-dc-text'}`}>
                  {f.title}
                </h3>
                <p className="text-xs text-dc-text-muted leading-relaxed">
                  {f.desc}
                </p>
              </motion.div>
            );
          })}
        </StaggerContainer>
      </div>
    </section>
  );
}
