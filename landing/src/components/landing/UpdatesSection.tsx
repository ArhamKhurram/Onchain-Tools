import { motion } from 'framer-motion';
import { UPDATES, formatUpdateDate } from '../../data/updates';

function renderBold(text: string) {
  const parts = text.split(/\*\*(.+?)\*\*/);
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <strong key={i} className="text-white font-semibold">
        {part}
      </strong>
    ) : (
      part
    ),
  );
}

export function UpdatesSection() {
  return (
    <section
      id="updates"
      className="relative snap-start snap-always min-h-[100dvh] flex flex-col bg-black text-white px-6 sm:px-10 pr-12 sm:pr-14 pt-24 pb-32"
    >
      <div className="max-w-3xl mx-auto w-full flex-1">
        <motion.p
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          className="font-mono text-xs tracking-[0.2em] text-white/60 mb-6"
        >
          [ UPDATES ]
        </motion.p>

        <motion.h2
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="font-display text-[clamp(2rem,7vw,4rem)] leading-[0.95] tracking-tight mb-4"
        >
          WHAT&apos;S NEW.
        </motion.h2>

        <motion.p
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          className="font-mono text-xs sm:text-sm text-white/55 mb-12 max-w-lg"
        >
          Recent changes to the console, contract feed, and landing experience.
        </motion.p>

        <div className="relative">
          <div className="absolute left-[5px] top-2 bottom-2 w-px bg-white/15" aria-hidden />

          {UPDATES.map((entry, idx) => (
            <motion.article
              key={entry.date}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-40px' }}
              transition={{ delay: idx * 0.05 }}
              className={`relative pl-8 sm:pl-10 ${idx < UPDATES.length - 1 ? 'pb-10' : 'pb-0'}`}
            >
              <div
                className="absolute left-0 top-1.5 w-[11px] h-[11px] border-2 border-oct-accent bg-black"
                aria-hidden
              />

              <div className="border border-white/15 bg-white/[0.02] p-5 sm:p-6">
                <time className="font-mono text-[10px] sm:text-xs tracking-[0.12em] text-oct-accent uppercase">
                  {formatUpdateDate(entry.date)}
                </time>

                {entry.added && entry.added.length > 0 && (
                  <div className="mt-4">
                    <span className="font-mono text-[10px] tracking-[0.15em] text-emerald-400/90 uppercase">
                      + Added
                    </span>
                    <ul className="mt-2 space-y-2">
                      {entry.added.map((item, i) => (
                        <li
                          key={i}
                          className="font-mono text-xs sm:text-sm leading-relaxed text-white/70 flex gap-2"
                        >
                          <span className="text-emerald-400/80 shrink-0">·</span>
                          <span>{renderBold(item)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {entry.fixed && entry.fixed.length > 0 && (
                  <div className="mt-4">
                    <span className="font-mono text-[10px] tracking-[0.15em] text-amber-400/90 uppercase">
                      ~ Fixed
                    </span>
                    <ul className="mt-2 space-y-2">
                      {entry.fixed.map((item, i) => (
                        <li
                          key={i}
                          className="font-mono text-xs sm:text-sm leading-relaxed text-white/70 flex gap-2"
                        >
                          <span className="text-amber-400/80 shrink-0">·</span>
                          <span>{renderBold(item)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </motion.article>
          ))}
        </div>
      </div>
    </section>
  );
}
