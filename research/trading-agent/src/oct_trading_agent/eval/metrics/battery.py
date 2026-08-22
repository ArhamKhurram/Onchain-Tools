"""The risk-adjusted + distributional metric battery (paper §8.3; 05-evaluation-plan.md).

These are the pre-registered measures every policy is judged on — no single-number headline, because
in a violently fat-tailed market a mean or a hit-rate alone lies (§8.3). The battery is a pure
function of a return series (per-episode realized returns) plus an optional equity curve for
drawdown, so it is trivially testable and identical across baselines and learned policies.

Metrics (all realized, all after costs — the inputs come from the paper ledger):

* **Sharpe / Sortino** — mean over total / downside deviation. Un-annualized (the episode horizon is
  the natural unit here); a caller may scale.
* **CVaR** (tail loss at ``alpha``) — the mean of the worst ``alpha`` fraction of returns. The term
  that catches lottery policies: a rare 100× with frequent ruin has a brutal CVaR.
* **Max drawdown** — deepest peak-to-trough on the equity curve.
* **Hit-rate + expectancy** — never reported alone (§8.3): a low hit-rate can still be +EV via a few
  tail winners, so we carry ``avg_win``/``avg_loss``/``win_rate`` alongside.
* **Distribution shape** — mean, median, std, skew, kurtosis.
* **Cost transparency** — turnover, fees, realized slippage are surfaced by the runner and travel
  with the report so a "works only at zero cost" strategy is visible (§8.3).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class MetricReport:
    """The full metric battery for one policy's run. Every field is realized and after-cost."""

    n_returns: int
    mean_return: float
    median_return: float
    std_return: float
    total_return: float
    sharpe: float
    sortino: float
    cvar: float
    cvar_alpha: float
    max_drawdown: float
    hit_rate: float
    win_rate: float
    avg_win: float
    avg_loss: float
    expectancy: float
    skew: float
    kurtosis: float
    # Cost transparency (aggregate over the run) — populated by the runner, defaulted here.
    total_fees_quote: float = 0.0
    total_mev_quote: float = 0.0
    mean_slippage_bps: float = 0.0
    turnover: float = 0.0


def _skew(x: np.ndarray) -> float:
    if x.size < 3:
        return 0.0
    m = x.mean()
    s = x.std()
    if s <= 1e-18:
        return 0.0
    return float(np.mean(((x - m) / s) ** 3))


def _kurtosis(x: np.ndarray) -> float:
    if x.size < 4:
        return 0.0
    m = x.mean()
    s = x.std()
    if s <= 1e-18:
        return 0.0
    return float(np.mean(((x - m) / s) ** 4) - 3.0)  # excess kurtosis


def sharpe(returns: np.ndarray) -> float:
    """Mean / standard deviation of the return series. 0 if degenerate."""
    if returns.size == 0:
        return 0.0
    s = returns.std()
    if s <= 1e-12:  # treat float-noise variance as zero (returns are O(1) fractions)
        return 0.0
    return float(returns.mean() / s)


def sortino(returns: np.ndarray) -> float:
    """Mean / downside deviation (root-mean-square of the negative returns). 0 if no downside."""
    if returns.size == 0:
        return 0.0
    downside = returns[returns < 0.0]
    if downside.size == 0:
        # No losing episode: Sortino is unbounded — report the mean sign as a large finite proxy.
        return float(np.sign(returns.mean()) * abs(returns.mean()) / 1e-9) if returns.mean() else 0.0
    dd = float(np.sqrt(np.mean(downside**2)))
    if dd <= 1e-12:
        return 0.0
    return float(returns.mean() / dd)


def cvar(returns: np.ndarray, alpha: float = 0.05) -> float:
    """Conditional Value-at-Risk: mean of the worst ``alpha`` fraction of returns (a loss is < 0)."""
    if returns.size == 0:
        return 0.0
    if not 0.0 < alpha <= 1.0:
        raise ValueError("alpha must be in (0, 1]")
    ordered = np.sort(returns)
    k = max(1, int(np.ceil(alpha * ordered.size)))
    return float(ordered[:k].mean())


def max_drawdown(equity_curve: np.ndarray) -> float:
    """Deepest peak-to-trough drawdown as a non-negative fraction of the running peak."""
    if equity_curve.size == 0:
        return 0.0
    running_peak = np.maximum.accumulate(equity_curve)
    # Guard a zero/negative peak (balance can, in principle, be driven to 0).
    safe_peak = np.where(running_peak > 1e-18, running_peak, 1e-18)
    drawdowns = (running_peak - equity_curve) / safe_peak
    return float(np.max(drawdowns))


def compute_metrics(
    returns: np.ndarray,
    *,
    equity_curve: np.ndarray | None = None,
    cvar_alpha: float = 0.05,
) -> MetricReport:
    """Assemble the full :class:`MetricReport` from a per-episode return series (+ optional equity)."""
    r = np.asarray(returns, dtype=np.float64).reshape(-1)
    if r.size == 0:
        return MetricReport(
            n_returns=0, mean_return=0.0, median_return=0.0, std_return=0.0, total_return=0.0,
            sharpe=0.0, sortino=0.0, cvar=0.0, cvar_alpha=cvar_alpha, max_drawdown=0.0,
            hit_rate=0.0, win_rate=0.0, avg_win=0.0, avg_loss=0.0, expectancy=0.0,
            skew=0.0, kurtosis=0.0,
        )
    wins = r[r > 0.0]
    losses = r[r < 0.0]
    win_rate = float(wins.size / r.size)
    avg_win = float(wins.mean()) if wins.size else 0.0
    avg_loss = float(losses.mean()) if losses.size else 0.0  # negative
    expectancy = win_rate * avg_win + (1.0 - win_rate) * avg_loss  # == mean, kept decomposed
    # Default equity path starts at the initial capital (1.0) so drawdown's running peak is defined.
    curve = equity_curve if equity_curve is not None else 1.0 + np.cumsum(r)
    return MetricReport(
        n_returns=int(r.size),
        mean_return=float(r.mean()),
        median_return=float(np.median(r)),
        std_return=float(r.std()),
        total_return=float(r.sum()),
        sharpe=sharpe(r),
        sortino=sortino(r),
        cvar=cvar(r, cvar_alpha),
        cvar_alpha=cvar_alpha,
        max_drawdown=max_drawdown(np.asarray(curve, dtype=np.float64).reshape(-1)),
        hit_rate=win_rate,
        win_rate=win_rate,
        avg_win=avg_win,
        avg_loss=avg_loss,
        expectancy=expectancy,
        skew=_skew(r),
        kurtosis=_kurtosis(r),
    )


__all__ = [
    "MetricReport",
    "compute_metrics",
    "cvar",
    "max_drawdown",
    "sharpe",
    "sortino",
]
