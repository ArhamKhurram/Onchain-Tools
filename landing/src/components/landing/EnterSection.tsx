import { motion } from 'framer-motion';
import { APP_CONSOLE_PATH } from '../../constants';

const mockLines = [
  { user: 'alpha_sniper', msg: 'New CA just dropped on pump.fun', tag: null },
  { user: 'whale_tracker', msg: '7xKp…f2Qm', tag: 'SOL' },
  { user: 'degen_carl', msg: '0x1a2b…f3d4 — up 340% in 2h', tag: 'EVM' },
];

export function EnterSection() {
  return (
    <section
      id="enter"
      className="relative snap-start snap-always min-h-screen flex flex-col justify-center bg-black text-white px-6 sm:px-10 py-24"
    >
      <div className="max-w-6xl mx-auto w-full grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-16 items-center">
        <div>
          <motion.p
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            className="font-mono text-xs tracking-[0.2em] text-white/60 mb-6"
          >
            [ LAUNCH ]
          </motion.p>

          <motion.h2
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="font-display text-[clamp(2.5rem,8vw,5rem)] leading-[0.95] tracking-tight mb-6"
          >
            OPEN THE CONSOLE.
          </motion.h2>

          <motion.p
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            transition={{ delay: 0.1 }}
            className="font-mono text-sm leading-relaxed text-white/65 max-w-md mb-10"
          >
            No install. Sign in, paste your Discord token in-browser, and start streaming.
            Your token never touches our servers — it connects directly from your browser.
          </motion.p>

          <motion.a
            href={APP_CONSOLE_PATH}
            initial={{ opacity: 0, y: 8 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: 0.15 }}
            className="inline-block font-mono text-sm sm:text-base tracking-wide border-2 border-white px-8 py-4 hover:bg-white hover:text-black transition-colors"
          >
            [ TAKE ME TO CONSOLE → ]
          </motion.a>
        </div>

        <motion.div
          initial={{ opacity: 0, x: 20 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="border border-white/15 bg-white/[0.03] font-mono text-xs sm:text-sm"
        >
          <div className="border-b border-white/10 px-4 py-2 text-white/40 flex justify-between">
            <span>OCT · feed</span>
            <span className="text-oct-accent">● live</span>
          </div>
          <div className="p-4 space-y-4 min-h-[220px]">
            {mockLines.map((line, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, x: -8 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                transition={{ delay: 0.2 + i * 0.12 }}
                className="flex gap-3"
              >
                <span className="text-oct-accent shrink-0">{line.user}</span>
                <span className="text-white/75 break-all">
                  {line.msg}
                  {line.tag && (
                    <span className={`ml-2 text-[10px] px-1.5 py-0.5 border ${
                      line.tag === 'SOL' ? 'border-emerald-500/50 text-emerald-400' : 'border-amber-500/50 text-amber-400'
                    }`}>
                      {line.tag}
                    </span>
                  )}
                </span>
              </motion.div>
            ))}
          </div>
        </motion.div>
      </div>
    </section>
  );
}
