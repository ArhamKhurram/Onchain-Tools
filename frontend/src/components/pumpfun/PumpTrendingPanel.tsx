import { ExternalLink, RefreshCw } from 'lucide-react';
import { usePumpTrending } from '../../hooks/usePumpTrending';
import { truncateAddress, type PumpCommunity, type PumpFeedItem } from '../../types/pumpfun';
import PumpStateNotice from './PumpStateNotice';

const TH = 'px-3 py-2 font-medium';

// Top / Trending: the top-communities board and the public feed slice, side by
// side. Both are KEYED, so an unset key renders each as a "not configured"
// notice. Data is attributed to pump.fun in the section headers.
export default function PumpTrendingPanel({ trending }: { trending: ReturnType<typeof usePumpTrending> }) {
  const { communities, feed, loading, refresh } = trending;

  return (
    <div className="h-full min-h-0 overflow-auto bg-oct-bg">
      <div className="oct-headerbar flex items-center gap-2 px-4 py-3">
        <span className="oct-eyebrow tracking-[0.18em]">Trending on pump.fun</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => void refresh()}
          className="oct-icon-btn flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-bold uppercase"
        >
          <RefreshCw size={12} />
          refresh
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 p-4">
        {/* Top communities. */}
        <section>
          <h3 className="oct-eyebrow mb-2.5">Top communities</h3>
          {communities.disabled || communities.error ? (
            <PumpStateNotice
              disabled={communities.disabled}
              error={communities.error}
              retryable={communities.retryable}
              onRetry={refresh}
              surface="communities"
            />
          ) : communities.data.length === 0 ? (
            <p className="font-mono text-xs text-oct-muted py-2">{loading ? 'Loading…' : 'No communities.'}</p>
          ) : (
            <div className="oct-card oct-card-flush">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse min-w-[420px]">
                  <thead className="oct-thead">
                    <tr className="font-mono text-[11px] font-bold uppercase tracking-wider text-oct-muted">
                      <th className={TH}>Token</th>
                      <th className={`${TH} text-right`}>Members</th>
                      <th className={`${TH} text-right`}>Posts</th>
                      <th className={`${TH} text-right`}>Likes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {communities.data.map((c, i) => (
                      <CommunityRow key={c.tokenAddress ?? `${c.tokenSymbol}-${i}`} c={c} />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>

        {/* Public feed. */}
        <section>
          <h3 className="oct-eyebrow mb-2.5">Feed</h3>
          {feed.disabled || feed.error ? (
            <PumpStateNotice
              disabled={feed.disabled}
              error={feed.error}
              retryable={feed.retryable}
              onRetry={refresh}
              surface="feed"
            />
          ) : feed.data.length === 0 ? (
            <p className="font-mono text-xs text-oct-muted py-2">{loading ? 'Loading…' : 'No feed items.'}</p>
          ) : (
            <div className="oct-card oct-card-flush divide-y divide-oct-border/60">
              {feed.data.map((item) => (
                <FeedRow key={item.id} item={item} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function CommunityRow({ c }: { c: PumpCommunity }) {
  return (
    <tr className="border-b border-oct-border/50 oct-row-hover">
      <td className="px-3 py-2.5 font-mono text-[13px] text-oct-text">
        <span className="font-semibold text-oct-text">{c.tokenSymbol ?? '—'}</span>
        {c.tokenAddress && (
          <span className="block text-[11px] text-oct-muted" title={c.tokenAddress}>
            {truncateAddress(c.tokenAddress)}
          </span>
        )}
      </td>
      <td className="px-3 py-2.5 font-mono text-[13px] text-oct-muted text-right tabular-nums">{num(c.memberCount)}</td>
      <td className="px-3 py-2.5 font-mono text-[13px] text-oct-muted text-right tabular-nums">{num(c.postCount)}</td>
      <td className="px-3 py-2.5 font-mono text-[13px] text-oct-muted text-right tabular-nums">{num(c.totalLikes)}</td>
    </tr>
  );
}

function FeedRow({ item }: { item: PumpFeedItem }) {
  return (
    <div className="px-3.5 py-3 hover:bg-oct-surface-raised/40 transition-colors">
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[13px] font-semibold text-oct-text truncate">
          {item.displayName ?? item.username ?? '—'}
        </span>
        {item.tokenSymbol && (
          <span className="font-mono text-[11px] font-semibold px-1.5 py-0.5 rounded-oct-sm border border-oct-accent/40 bg-oct-accent-dim text-oct-accent">
            {item.tokenSymbol}
          </span>
        )}
        {item.userTwitterUrl && (
          <a href={item.userTwitterUrl} target="_blank" rel="noreferrer noopener" className="text-oct-muted hover:text-oct-accent shrink-0">
            <ExternalLink size={11} />
          </a>
        )}
        <div className="flex-1" />
        <span className="font-mono text-[11px] text-oct-muted whitespace-nowrap">
          {item.createdAt ? new Date(item.createdAt).toLocaleDateString() : ''}
        </span>
      </div>
      {item.content && <p className="mt-1 font-mono text-xs text-oct-muted line-clamp-2 break-words">{item.content}</p>}
      <div className="mt-1.5 flex items-center gap-3 font-mono text-[11px] text-oct-muted">
        <span>♥ {num(item.likeCount)}</span>
        <span>↺ {num(item.replyCount)}</span>
        {item.tokenAddress && <span title={item.tokenAddress}>{truncateAddress(item.tokenAddress)}</span>}
      </div>
    </div>
  );
}

function num(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '0';
  return n.toLocaleString();
}
