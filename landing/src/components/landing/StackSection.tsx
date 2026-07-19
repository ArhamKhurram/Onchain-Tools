import { motion } from 'framer-motion';
import { APP_CONSOLE_PATH } from '../../constants';

const pillars = [
  {
    num: '01',
    title: 'FEED',
    body: 'Aggregate Discord and Telegram alpha into unified rooms. Live gateway streaming, highlighted users, keyword alerts — all in one feed.',
  },
  {
    num: '02',
    title: 'TRACK',
    body: 'Privately monitor wallets you care about. Your watchlist stays yours — alerts when tracked addresses move on-chain.',
  },
  {
    num: '03',
    title: 'CALL',
    body: 'Contract radar catches Solana and EVM addresses the moment they drop in chat. One click to Axiom, GMGN, Bloom, and more.',
  },
];

export function StackSection() {
  return (
    <section
      id="stack"
      className="relative snap-start snap-always min-h-[100dvh] flex flex-col bg-oct-flame text-black px-6 sm:px-10 pr-12 sm:pr-14 pt-20 pb-24 sm:py-24"
    >
      <div className="flex-1 max-w-6xl mx-auto w-full flex flex-col">
        <motion.p
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          className="font-mono text-xs sm:text-sm tracking-[0.2em] mb-8"
        >
          [ THE STACK ]
        </motion.p>

        <motion.h2
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="font-display text-[clamp(2.5rem,10vw,6.5rem)] leading-[0.92] tracking-tight mb-12 sm:mb-20 max-w-3xl"
        >
          FEED. TRACK. CALL.
        </motion.h2>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-10 md:gap-8 flex-1">
          {pillars.map((p, i) => (
            <motion.a
              key={p.title}
              href={APP_CONSOLE_PATH}
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: i * 0.1 }}
              className="group flex flex-col border-t-2 border-black pt-6 hover:opacity-90 transition-opacity"
            >
              <span className="font-mono text-xs tracking-[0.15em] mb-4">[ {p.num} ]</span>
              <h3 className="font-display text-3xl sm:text-4xl tracking-tight mb-4">{p.title}</h3>
              <p className="font-mono text-xs sm:text-sm leading-relaxed text-black/90 flex-1">{p.body}</p>
              <span className="font-mono text-xs sm:text-sm mt-6 tracking-wide group-hover:translate-x-1 transition-transform inline-block">
                OPEN CONSOLE →
              </span>
            </motion.a>
          ))}
        </div>
      </div>
    </section>
  );
}
