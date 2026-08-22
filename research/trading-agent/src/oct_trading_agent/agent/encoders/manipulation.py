"""The mandatory manipulation-suspicion channel (paper §4.4, §9.10) — pure numpy.

Wash trading manufactures the *exact* clustered, self-exciting tape the Hawkes backbone reads as
attention (Cong, Li, Tang & Yang estimate wash volume has averaged >70% of reported volume on
unregulated venues). So a high ``λ`` cannot be taken at face value: the attention state **never
ships without this channel**, and the pipeline *refuses* to emit an :class:`AttentionState` absent
a manipulation score (paper §9.10 — "we must never ship an attention signal without its
manipulation-suspicion companion").

This is a *suspicion* score, not a detector: per §9.10 the identification limit is fundamental —
a single actor splitting orders (Lillo & Farmer, 2004) is genuinely hard to distinguish from many
independent buyers — so these heuristics **reduce, they do not eliminate**, the risk. The score is
a corroboration signal that *down-weights* apparent attention, never a proof of fakeness.

The channel is a weighted blend of five pure-flow heuristics, each in ``[0, 1]`` (higher = more
suspect):

1. **Benford / first-significant-digit divergence** of trade sizes (Cong et al.). Organic size
   distributions track Benford's law; synthetic/scripted sizes deviate.
2. **Round-number concentration** — a glut of suspiciously round sizes (0.1/0.5/1.0 SOL, many
   trailing zeros) is a bot-volume signature.
3. **Breadth deficit** — unique buyers vs buy count: heavy repeat trading by the same wallets
   (low distinct-buyer ratio) is wash-like. Unique-buyer growth is the least-fakeable attention
   feature (paper §4.4), so its *absence* under high volume is the strongest single red flag.
4. **Buyer concentration** — Gini/Herfindahl of buy volume across wallets; one wallet dominating
   the buy flow is "one actor, i.e. suspect attention" (paper §4.4).
5. **Creator / sniper activity** — the deployer and first-hour ring's share of volume, a direct
   down-weight on apparent attention (paper §4.4 covariate).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

_EPS = 1e-12

# Benford's law expected first-significant-digit frequencies for digits 1..9.
_BENFORD = np.log10(1.0 + 1.0 / np.arange(1, 10))

# Default blend weights. Breadth deficit and concentration carry the most mass: they are the
# hardest to fake and the most directly tied to the "one actor vs a crowd" question (§4.4).
DEFAULT_WEIGHTS: dict[str, float] = {
    "benford": 0.15,
    "round_number": 0.15,
    "breadth_deficit": 0.30,
    "concentration": 0.25,
    "creator_activity": 0.15,
}


@dataclass(frozen=True)
class ManipulationReport:
    """The manipulation channel's output: the aggregate score plus its interpretable components.

    ``suspicion`` is the single ``[0, 1]`` value that becomes ``AttentionState.manipulation_suspicion``.
    The component scores and the raw ``unique_buyers`` / ``concentration`` are kept so the standalone
    alert and the human-legible rationale can explain *why* attention was or was not discounted.
    """

    suspicion: float
    benford: float
    round_number: float
    breadth_deficit: float
    concentration: float
    creator_activity: float
    unique_buyers: int
    n_buys: int


def first_significant_digits(values: np.ndarray) -> np.ndarray:
    """First significant decimal digit (1..9) of each positive value; non-positives dropped."""
    v = np.asarray(values, dtype=float).ravel()
    v = np.abs(v)
    v = v[v > 0]
    if v.shape[0] == 0:
        return np.empty(0, dtype=int)
    # scale each value into [1, 10) and take the integer part
    exponent = np.floor(np.log10(v))
    lead = v / np.power(10.0, exponent)
    digits = np.floor(lead).astype(int)
    return np.clip(digits, 1, 9)


def benford_suspicion(sizes: np.ndarray, *, min_samples: int = 20) -> float:
    """Divergence of trade-size first digits from Benford's law, mapped to ``[0, 1]``.

    Uses total-variation distance between the empirical and Benford first-digit distributions.
    Below ``min_samples`` the test is unreliable (paper §8.6 cold-start), so it abstains at a
    neutral 0.0 rather than manufacturing a reading from noise.
    """
    digits = first_significant_digits(sizes)
    if digits.shape[0] < min_samples:
        return 0.0
    counts = np.bincount(digits, minlength=10)[1:10].astype(float)
    emp = counts / counts.sum()
    tv = 0.5 * float(np.sum(np.abs(emp - _BENFORD)))  # total variation in [0, 1]
    # TV for organic data is small (well under ~0.1); scale so a clear deviation saturates.
    return float(np.clip(tv / 0.30, 0.0, 1.0))


def round_number_suspicion(sizes: np.ndarray) -> float:
    """Share of trade sizes that are suspiciously round (bot/scripted volume signature)."""
    v = np.asarray(sizes, dtype=float).ravel()
    v = v[v > 0]
    if v.shape[0] == 0:
        return 0.0
    # "round" = close to a 1/2/5 x 10^k grid at ~1% relative tolerance.
    exponent = np.floor(np.log10(v))
    scale = np.power(10.0, exponent)
    norm = v / scale  # in [1, 10)
    targets = np.array([1.0, 2.0, 2.5, 5.0])
    rel = np.min(np.abs(norm[:, None] - targets[None, :]) / targets[None, :], axis=1)
    is_round = rel < 0.01
    return float(np.mean(is_round))


def _gini(x: np.ndarray) -> float:
    """Gini coefficient of a non-negative vector in ``[0, 1]`` (0 = uniform, 1 = one actor)."""
    v = np.asarray(x, dtype=float).ravel()
    v = v[v >= 0]
    if v.shape[0] == 0 or float(np.sum(v)) <= 0:
        return 0.0
    v = np.sort(v)
    n = v.shape[0]
    if n == 1:
        return 1.0
    idx = np.arange(1, n + 1)
    return float((np.sum((2 * idx - n - 1) * v)) / (n * np.sum(v)))


def herfindahl(x: np.ndarray) -> float:
    """Herfindahl–Hirschman index (sum of squared shares) of a non-negative vector, in ``[0, 1]``."""
    v = np.asarray(x, dtype=float).ravel()
    v = v[v >= 0]
    total = float(np.sum(v))
    if total <= 0:
        return 0.0
    shares = v / total
    return float(np.sum(shares * shares))


def buyer_concentration(buyer_volumes: np.ndarray) -> float:
    """Concentration of buy volume across buyer wallets (Gini), in ``[0, 1]``.

    This is the value carried in ``AttentionState.concentration``: low concentration with many
    buyers = broad attention; high concentration = one actor = suspect (paper §4.4).
    """
    return _gini(buyer_volumes)


def breadth_deficit_suspicion(unique_buyers: int, n_buys: int) -> float:
    """Suspicion from a low distinct-buyer ratio under non-trivial buy count.

    ``1 − unique/​n_buys`` is the repeat-trading fraction; it only counts as suspicious once there
    are enough buys to matter (few trades from few wallets is just a cold-start, §8.6).
    """
    if n_buys < 5:
        return 0.0
    ratio = unique_buyers / max(n_buys, 1)
    return float(np.clip(1.0 - ratio, 0.0, 1.0))


def assess_manipulation(
    *,
    buy_sizes: np.ndarray,
    buyer_ids: np.ndarray,
    all_sizes: np.ndarray | None = None,
    creator_volume_share: float = 0.0,
    weights: dict[str, float] | None = None,
) -> ManipulationReport:
    """Compute the manipulation-suspicion channel from pure flow.

    Parameters
    ----------
    buy_sizes
        Quote (SOL) sizes of the BUY swaps in the window.
    buyer_ids
        Integer-coded buyer wallet id per buy swap (same length as ``buy_sizes``). Used for the
        breadth and concentration heuristics.
    all_sizes
        Sizes of *all* swaps (buys and sells) for the Benford / round-number tests; defaults to
        ``buy_sizes`` when not given.
    creator_volume_share
        Share of window volume attributable to creator / sniper / first-ring wallets, in ``[0, 1]``.
        A direct down-weight covariate (paper §4.4).
    weights
        Optional override of the component blend weights.

    Returns
    -------
    ManipulationReport
        The aggregate ``suspicion`` plus every component — the mandatory authenticity companion.
    """
    w = dict(DEFAULT_WEIGHTS if weights is None else weights)
    buy_sizes = np.asarray(buy_sizes, dtype=float).ravel()
    buyer_ids = np.asarray(buyer_ids).ravel()
    sizes_for_shape = buy_sizes if all_sizes is None else np.asarray(all_sizes, dtype=float).ravel()

    n_buys = int(buy_sizes.shape[0])
    unique_buyers = int(np.unique(buyer_ids).shape[0]) if buyer_ids.shape[0] else 0

    # Per-wallet buy volume for concentration.
    if n_buys > 0 and buyer_ids.shape[0] == n_buys:
        uniq, inv = np.unique(buyer_ids, return_inverse=True)
        vol = np.zeros(uniq.shape[0], dtype=float)
        np.add.at(vol, inv, buy_sizes)
    else:
        vol = np.empty(0, dtype=float)

    benford = benford_suspicion(sizes_for_shape)
    round_num = round_number_suspicion(sizes_for_shape)
    breadth = breadth_deficit_suspicion(unique_buyers, n_buys)
    concentration = buyer_concentration(vol)
    creator = float(np.clip(creator_volume_share, 0.0, 1.0))

    components = {
        "benford": benford,
        "round_number": round_num,
        "breadth_deficit": breadth,
        "concentration": concentration,
        "creator_activity": creator,
    }
    wsum = sum(w.get(k, 0.0) for k in components)
    if wsum <= _EPS:
        suspicion = 0.0
    else:
        suspicion = sum(w.get(k, 0.0) * v for k, v in components.items()) / wsum
    suspicion = float(np.clip(suspicion, 0.0, 1.0))

    return ManipulationReport(
        suspicion=suspicion,
        benford=benford,
        round_number=round_num,
        breadth_deficit=breadth,
        concentration=concentration,
        creator_activity=creator,
        unique_buyers=unique_buyers,
        n_buys=n_buys,
    )
