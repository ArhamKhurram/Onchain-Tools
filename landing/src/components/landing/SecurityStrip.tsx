import { motion } from 'framer-motion';

const points = [
  {
    num: '01',
    title: 'BROWSER-ONLY TOKENS',
    body: 'Discord tokens live in your browser localStorage and connect directly to Discord. They are never sent to or stored on our servers.',
  },
  {
    num: '02',
    title: 'ENCRYPTED SETTINGS',
    body: 'Rooms, config, and Telegram sessions are encrypted at rest with AES-256-GCM. Row-level security isolates every account.',
  },
  {
    num: '03',
    title: 'OPEN SOURCE',
    body: 'Inspect the encryption, gateway, and client-side token flow yourself. Don\'t trust — verify.',
  },
];

export function SecurityStrip() {
  return (
    <section
      id="security"
      className="relative snap-start snap-always min-h-screen flex flex-col justify-center bg-oct-flame text-black px-6 sm:px-10 py-24"
    >
      <div className="max-w-6xl mx-auto w-full">
        <motion.p
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          className="font-mono text-xs tracking-[0.2em] mb-6"
        >
          [ SECURITY ]
        </motion.p>

        <motion.h2
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="font-display text-[clamp(2rem,7vw,4.5rem)] leading-[0.95] tracking-tight mb-12 sm:mb-16 max-w-2xl"
        >
          YOUR KEYS. YOUR MACHINE.
        </motion.h2>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-10 md:gap-8">
          {points.map((p, i) => (
            <motion.div
              key={p.title}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.08 }}
              className="border-t-2 border-black pt-6"
            >
              <span className="font-mono text-xs tracking-[0.15em]">[ {p.num} ]</span>
              <h3 className="font-display text-2xl sm:text-3xl mt-4 mb-3">{p.title}</h3>
              <p className="font-mono text-xs sm:text-sm leading-relaxed opacity-80">{p.body}</p>
            </motion.div>
          ))}
        </div>

        <motion.p
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          className="font-mono text-[10px] sm:text-xs text-black/55 mt-16 max-w-2xl leading-relaxed"
        >
          OCT is an independent project and is not affiliated with Discord Inc. Using self-bots
          violates Discord&apos;s Terms of Service. For personal and educational use only — use at your own risk.
        </motion.p>
      </div>
    </section>
  );
}
