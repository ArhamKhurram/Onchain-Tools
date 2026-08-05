import { useMemo, useState } from 'react';
import { Trash2, VolumeX, Star, Info, Bot, AlertTriangle } from 'lucide-react';
import { BAND_LABELS, MIN_RATED_CALLS, parseCallerKey, DEFAULT_EXCLUDED_CALLERS } from '@oct/shared';
import { useCallerQuality } from '../../../hooks/useCallerQuality';
import {
  BAND_TEXT_CLASS,
  BAND_TITLE,
  formatMultiple,
  formatMultipleFloor,
  formatRate,
} from '../../../utils/callerBandStyle';
import { Toggle } from '../fields';
import type { SettingsForm } from '../useSettingsForm';

export default function CallerQualitySection({ form }: { form: SettingsForm }) {
  const {
    rooms,
    callerTiers,
    setCallerTiers,
    callerTierShowMuted,
    setCallerTierShowMuted,
    callerQualityRanking,
    setCallerQualityRanking,
    callerScoreExclusions,
    setCallerScoreExclusions,
  } = form;

  const { scores, windowDays, pricedTokens, truncated, coversFrom, loaded } = useCallerQuality();
  const [newExclusion, setNewExclusion] = useState('');

  /** Whole days of history the scores were actually built from, when it falls short. */
  const coveredDays = useMemo(() => {
    if (!coversFrom || !windowDays) return null;
    const days = (Date.now() - new Date(coversFrom).getTime()) / 86_400_000;
    if (!Number.isFinite(days)) return null;
    // A day of slack: the oldest row is rarely the first second of the window.
    return days < windowDays - 1 ? Math.max(1, Math.round(days)) : null;
  }, [coversFrom, windowDays]);

  const addExclusion = () => {
    const value = newExclusion.trim();
    if (!value || callerScoreExclusions.includes(value)) {
      setNewExclusion('');
      return;
    }
    setCallerScoreExclusions([...callerScoreExclusions, value]);
    setNewExclusion('');
  };

  const roomName = useMemo(() => {
    const map = new Map(rooms.map((r) => [r.id, r.name]));
    return (id?: string) => (id ? (map.get(id) ?? id) : 'Everywhere');
  }, [rooms]);

  const scoreByKey = useMemo(() => new Map(scores.map((s) => [s.key, s])), [scores]);

  const ratedScores = useMemo(
    () => scores.filter((s) => s.band !== 'unrated').slice(0, 25),
    [scores],
  );

  return (
    <>
      <div>
        <h3 className="font-display text-xl sm:text-2xl tracking-tight text-oct-text mb-1">Caller Quality</h3>
        <p className="text-sm text-oct-muted">
          Rank contract calls by who sent them. Mute the slop, float the callers worth
          watching. Muted callers are collapsed rather than deleted — a caller you've
          written off can still be first on a runner.
        </p>
      </div>

      <div className="space-y-3">
        <Toggle
          value={callerTierShowMuted}
          onChange={setCallerTierShowMuted}
          label="Keep muted callers reachable"
        />
        <p className="text-xs text-oct-muted -mt-2">
          Collapse muted callers' contracts behind a counter you can expand, instead of
          hiding them completely.
        </p>
        <Toggle
          value={callerQualityRanking}
          onChange={setCallerQualityRanking}
          label="Rank the contract feed by caller quality"
        />
        <p className="text-xs text-oct-muted -mt-2">
          Trusted and high-scoring callers sort to the top. Off = newest first, as before.
        </p>
      </div>

      {/* Manual tiers */}
      <div>
        <label className="block font-mono text-xs uppercase tracking-[0.2em] text-oct-muted mb-2">
          Manual tiers ({callerTiers.length})
        </label>
        <p className="text-xs text-oct-muted mb-3">
          Set these by right-clicking a name in any chat feed. A room-specific tier beats a
          global one, so a caller can be slop in one room and fine elsewhere.
        </p>

        {callerTiers.length === 0 ? (
          <p className="text-sm text-oct-muted text-center py-4 border-2 border-dashed border-oct-border rounded-cockpit">
            No manual tiers yet.
          </p>
        ) : (
          <div className="space-y-1">
            {callerTiers.map((entry) => {
              const parsed = parseCallerKey(entry.key);
              const score = scoreByKey.get(entry.key);
              return (
                <div
                  key={`${entry.key}:${entry.roomId ?? 'global'}`}
                  className="flex items-center justify-between gap-2 px-3 py-2 rounded-cockpit border-2 border-oct-border bg-oct-surface-raised"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {entry.tier === 'muted' ? (
                      <VolumeX size={13} className="text-oct-muted shrink-0" />
                    ) : (
                      <Star size={13} className="text-oct-yellow shrink-0" />
                    )}
                    <div className="min-w-0">
                      <div className="text-sm text-oct-text truncate">
                        {entry.displayName}
                        <span className="ml-2 font-mono text-[10px] uppercase tracking-wide text-oct-muted">
                          {parsed?.platform ?? '?'} · {roomName(entry.roomId)}
                        </span>
                      </div>
                      {score && score.band !== 'unrated' && (
                        <div className={`font-mono text-[10px] ${BAND_TEXT_CLASS[score.band]}`}>
                          scored {BAND_LABELS[score.band]} · med{' '}
                          {formatMultiple(score.medianMultiple)}
                        </div>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() =>
                      setCallerTiers(
                        callerTiers.filter(
                          (e) => !(e.key === entry.key && e.roomId === entry.roomId),
                        ),
                      )
                    }
                    className="text-oct-muted hover:text-oct-flame shrink-0"
                    title="Remove this tier"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Scoring exclusions */}
      <div>
        <label className="block font-mono text-xs uppercase tracking-[0.2em] text-oct-muted mb-2">
          Not scored ({DEFAULT_EXCLUDED_CALLERS.length + callerScoreExclusions.length})
        </label>
        <p className="text-xs text-oct-muted mb-3">
          Enrichment bots repost every contract that crosses the feed, so scoring them
          measures the room rather than a caller. Excluded authors keep posting, keep
          showing up in the feed, and keep enriching — they just don't get a score. Add a
          display name (e.g. <span className="font-mono">Rick</span>) or a caller key
          (e.g. <span className="font-mono">discord:123456</span>).
        </p>

        <div className="space-y-1 mb-2">
          {DEFAULT_EXCLUDED_CALLERS.map((name) => (
            <div
              key={`default:${name}`}
              className="flex items-center gap-2 px-3 py-2 rounded-cockpit border-2 border-dashed border-oct-border bg-oct-surface-raised"
            >
              <Bot size={13} className="text-oct-muted shrink-0" />
              <span className="text-sm text-oct-text truncate">{name}</span>
              <span className="ml-auto font-mono text-[10px] uppercase tracking-wide text-oct-muted shrink-0">
                known bot
              </span>
            </div>
          ))}
          {callerScoreExclusions.map((entry) => (
            <div
              key={entry}
              className="flex items-center gap-2 px-3 py-2 rounded-cockpit border-2 border-oct-border bg-oct-surface-raised"
            >
              <Bot size={13} className="text-oct-muted shrink-0" />
              <span className="text-sm text-oct-text truncate">{entry}</span>
              <button
                onClick={() =>
                  setCallerScoreExclusions(callerScoreExclusions.filter((e) => e !== entry))
                }
                className="ml-auto text-oct-muted hover:text-oct-flame shrink-0"
                title="Score this caller again"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>

        <div className="flex gap-2">
          <input
            value={newExclusion}
            onChange={(e) => setNewExclusion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addExclusion();
              }
            }}
            placeholder="Name or caller key"
            className="flex-1 min-w-0 px-3 py-2 rounded-cockpit border-2 border-oct-border bg-oct-surface text-sm text-oct-text placeholder:text-oct-muted"
          />
          <button
            onClick={addExclusion}
            className="px-3 py-2 rounded-cockpit border-2 border-oct-border bg-oct-surface-raised text-sm text-oct-text hover:border-oct-muted shrink-0"
          >
            Exclude
          </button>
        </div>
      </div>

      {/* Earned scores */}
      <div>
        <label className="block font-mono text-xs uppercase tracking-[0.2em] text-oct-muted mb-2">
          Earned scores
        </label>
        <div className="flex items-start gap-2 text-xs text-oct-muted mb-3">
          <Info size={13} className="shrink-0 mt-0.5" />
          <p>
            Scored from each caller's own calls — their MC at the moment they posted, against
            the highest we've <em>observed</em> that token reach since. Peaks are sampled, so
            a spike between samples is missed: multiples are floors, not exact ATHs. A caller
            stays unrated below {MIN_RATED_CALLS} scored calls rather than showing a number
            built on noise.
            {windowDays ? ` Window: last ${windowDays} days.` : ''}
            {pricedTokens != null ? ` ${pricedTokens} tokens priced.` : ''}
          </p>
        </div>

        {coveredDays != null && (
          <div className="flex items-start gap-2 text-xs text-oct-yellow mb-3">
            <AlertTriangle size={13} className="shrink-0 mt-0.5" />
            <p>
              These scores only reach back{' '}
              <span className="font-bold">
                {coveredDays} {coveredDays === 1 ? 'day' : 'days'}
              </span>
              , not the full {windowDays} — your contract log doesn't hold any more history
              than that right now
              {truncated ? ' (the feed logged more rows than one read covers)' : ''}. Callers
              who only posted before that are missing from the board, and some of the rest
              are short of the calls they need to be rated.
            </p>
          </div>
        )}

        {!loaded ? (
          <p className="text-sm text-oct-muted text-center py-4">Loading scores…</p>
        ) : ratedScores.length === 0 ? (
          <p className="text-sm text-oct-muted text-center py-4 border-2 border-dashed border-oct-border rounded-cockpit">
            Nobody has enough scored calls yet. Peaks are sampled every few minutes, so this
            fills in over the first day or so of running.
          </p>
        ) : (
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2 px-3">
              <span />
              <div className="flex items-center gap-3 shrink-0 font-mono text-[9px] uppercase tracking-wide text-oct-muted">
                <span className="w-10 text-right" title="Median of (observed peak MC since call ÷ MC at call), across their rated calls. Peaks are sampled, so these are floors.">
                  Median
                </span>
                <span className="w-12 text-right" title="Their single best call — highest observed peak ÷ MC at call. An observed floor: a spike between samples is missed, so the true ATH can be higher.">
                  Best
                </span>
                <span className="w-14 text-right" title="Share of their rated calls that went on to 2x from call MC">
                  Hit 2x
                </span>
                <span className="w-12 text-right" title="Overall band, from the median and hit rate together">
                  Band
                </span>
              </div>
            </div>
            {ratedScores.map((score) => (
              <div
                key={score.key}
                className="flex items-center justify-between gap-2 px-3 py-2 rounded-cockpit border-2 border-oct-border bg-oct-surface-raised"
                title={BAND_TITLE[score.band]}
              >
                <div className="min-w-0">
                  <div className="text-sm text-oct-text truncate">{score.displayName}</div>
                  <div className="font-mono text-[10px] text-oct-muted">
                    {score.rated} rated of {score.calls} calls
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0 font-mono text-[11px]">
                  <span
                    className="w-10 text-right text-oct-muted"
                    title="Median multiple: observed peak MC since call ÷ MC at call (a floor — peaks are sampled)"
                  >
                    {formatMultiple(score.medianMultiple)}
                  </span>
                  <span
                    className="w-12 text-right text-oct-muted"
                    title="Best call: highest observed peak ÷ MC at call. At least this — the true ATH can be higher."
                  >
                    {formatMultipleFloor(score.bestMultiple)}
                  </span>
                  <span
                    className="w-14 text-right text-oct-muted"
                    title="Share of rated calls that hit 2x from call MC"
                  >
                    2x {formatRate(score.hitRate2x)}
                  </span>
                  <span
                    className={`w-12 text-right font-bold uppercase ${BAND_TEXT_CLASS[score.band]}`}
                    title={BAND_TITLE[score.band]}
                  >
                    {BAND_LABELS[score.band]}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
