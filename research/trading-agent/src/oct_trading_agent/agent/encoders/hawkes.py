"""Multivariate Hawkes intensity estimator — the interpretable *teacher* backbone (paper §4.4).

This is Part I of the trade-flow attention model: a multivariate self-exciting point process fit
to a token's swap tape. The fitted conditional intensity ``λ_k(t)`` **is** the attention chart
(``λ_buy`` the buy-intensity, ``λ_sell`` the exit-intensity), and the **branching ratio** ``n`` —
the spectral radius of the excitation's integral — is the attention-momentum scalar
(Filimonov & Sornette, 2012, repurposed): n→0 = discovery-only, n→1 = near-critical (a run is
dynamically possible), n≥1 = explosive/unstable.

Design choices, stated plainly:

* **Pure numpy, no torch, no scipy.** The teacher must be fully testable in a lean install
  (the encoder's gate is that the numpy path is green with torch absent). Only ``numpy`` is used.
* **Exponential kernels with a shared decay ``β``.** ``φ_{kℓ}(τ) = α_{kℓ} · e^{-β τ}``. A single
  decay across kernels is the standard small-sample stabilization (paper §4.5 "tiny samples") and
  makes both the log-likelihood and the EM sufficient statistics computable by an **O(N·K)
  recursion** (Ogata's exponential recursion) rather than the naive O(N²). The branching matrix is
  ``G[k,ℓ] = α_{kℓ} / β`` and the branching ratio ``n`` is its spectral radius.
* **EM fitting.** Non-negativity of ``μ`` and ``α`` is guaranteed by construction and the
  likelihood increases monotonically — the right properties for an interpretable teacher whose
  correctness must be trustworthy. ``β`` is fixed by default (a data-driven heuristic) and can be
  profiled over a grid when requested.
* **We do NOT force stationarity.** ``n ≥ 1`` (explosive) is a real, reportable state (paper §4.2),
  and — per §8 — a high ``n`` is a *hypothesis to be corroborated*, never a standalone trigger; the
  manipulation channel and unique-buyer breadth (see ``manipulation.py``) are what corroborate it.

The estimation hazards of §4.5 (tiny samples, apparent criticality, non-stationary base rate) and
the identification limit of §9.10 (a rising exogenous ``μ`` and a high ``n`` are near-substitutes in
the likelihood) are real and are NOT solved here — they are the reason the attention state never
ships without its authenticity companion.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

# Buy is dimension 0, sell is dimension 1 by convention across the encoder.
BUY = 0
SELL = 1
_EPS = 1e-12


@dataclass(frozen=True)
class HawkesParams:
    """Fitted parameters of a multivariate exponential-kernel Hawkes process.

    ``alpha[k, ell]`` is the excitation of dimension ``k``'s intensity by a past event of
    dimension ``ell``; ``mu[k]`` is dimension ``k``'s exogenous base rate; ``beta`` is the shared
    kernel decay. ``labels`` names the dimensions (e.g. ``("buy", "sell")``).
    """

    mu: np.ndarray
    alpha: np.ndarray
    beta: float
    labels: tuple[str, ...]

    @property
    def n_dims(self) -> int:
        return int(self.mu.shape[0])

    @property
    def branching_matrix(self) -> np.ndarray:
        """``G[k, ell] = α_{k,ell} / β`` — expected type-k offspring of one type-ell event."""
        return self.alpha / self.beta

    @property
    def branching_ratio(self) -> float:
        """The branching ratio ``n`` — spectral radius of the branching matrix.

        n→0 discovery-only, n→1 near-critical, n≥1 explosive (paper §4.2). For the univariate
        case this is simply ``α / β``.
        """
        eigvals = np.linalg.eigvals(self.branching_matrix)
        return float(np.max(np.abs(eigvals)))


@dataclass(frozen=True)
class HawkesFit:
    """Result of fitting a Hawkes process to one token's tape, with the history retained.

    The history (``event_times``, ``event_dims`` over the window ``[0, T]``) is kept so the
    intensity and compensator can be evaluated causally at any instant, including ``T`` (the
    ``as_of`` the attention state is emitted for).
    """

    params: HawkesParams
    event_times: np.ndarray
    event_dims: np.ndarray
    T: float
    log_likelihood: float
    n_iter: int
    converged: bool

    @property
    def n_events(self) -> int:
        return int(self.event_times.shape[0])

    @property
    def branching_ratio(self) -> float:
        return self.params.branching_ratio

    def intensity(self, t: float) -> np.ndarray:
        """Conditional intensity ``λ_k(t)`` for every dimension, from events strictly before ``t``.

        Causal by construction: only events with ``t_j < t`` contribute.
        """
        mu = self.params.mu
        alpha = self.params.alpha
        beta = self.params.beta
        past = self.event_times < t
        if not np.any(past):
            return mu.astype(float).copy()
        decays = np.exp(-beta * (t - self.event_times[past]))
        dims = self.event_dims[past]
        # per-source-dimension summed decay
        src = np.zeros(self.params.n_dims, dtype=float)
        for ell in range(self.params.n_dims):
            src[ell] = float(np.sum(decays[dims == ell]))
        return mu + alpha @ src

    def intensity_at_end(self) -> np.ndarray:
        """Intensity at the window end ``T`` — the ``λ_buy(T)`` / ``λ_sell(T)`` the state carries.

        Events exactly at ``T`` are included (the window is closed on the right at ``as_of``).
        """
        t = self.T + _EPS
        return self.intensity(t)

    def compensator(self, t: float) -> np.ndarray:
        """Integrated intensity ``Λ_k(t) = ∫_0^t λ_k(s) ds`` per dimension.

        Used for the time-rescaling goodness-of-fit diagnostic (paper §7.4): under a correct fit
        the rescaled inter-event times are unit-rate exponential.
        """
        mu = self.params.mu
        alpha = self.params.alpha
        beta = self.params.beta
        before = self.event_times <= t
        comp = mu * t
        if np.any(before):
            tj = self.event_times[before]
            dj = self.event_dims[before]
            integ = (1.0 - np.exp(-beta * (t - tj))) / beta
            src = np.zeros(self.params.n_dims, dtype=float)
            for ell in range(self.params.n_dims):
                src[ell] = float(np.sum(integ[dj == ell]))
            comp = comp + alpha @ src
        return comp

    def rescaled_interevent_times(self, dim: int) -> np.ndarray:
        """Time-rescaled inter-event intervals for one dimension (should be ~Exp(1) if fit is good).

        Returns ``Λ_k(τ_i) − Λ_k(τ_{i-1})`` over the successive events of dimension ``dim``.
        """
        mask = self.event_dims == dim
        ts = self.event_times[mask]
        if ts.shape[0] < 2:
            return np.empty(0, dtype=float)
        comps = np.array([self.compensator(t)[dim] for t in ts], dtype=float)
        return np.diff(comps)


def _default_beta(times: np.ndarray) -> float:
    """Data-driven default decay: inverse of the median positive inter-event gap.

    Sets the kernel timescale to roughly the typical spacing between trades — a standard,
    scale-free starting point that keeps the fit stable on short tapes.
    """
    if times.shape[0] < 2:
        return 1.0
    gaps = np.diff(np.sort(times))
    gaps = gaps[gaps > 0]
    if gaps.shape[0] == 0:
        return 1.0
    med = float(np.median(gaps))
    return 1.0 / med if med > 0 else 1.0


def _recursion_states(times: np.ndarray, dims: np.ndarray, n_dims: int, beta: float) -> np.ndarray:
    """Ogata exponential recursion: ``A[i, ell]`` = Σ_{j<i, dim ell} e^{-β(t_i − t_j)}.

    This is the O(N·K) core that makes both the intensity at event times and the EM sufficient
    statistics linear in the number of events. ``A[0, :] = 0`` (no prior events).
    """
    n = times.shape[0]
    a = np.zeros((n, n_dims), dtype=float)
    for i in range(1, n):
        dt = times[i] - times[i - 1]
        decay = np.exp(-beta * dt)
        prev = a[i - 1].copy()
        prev[dims[i - 1]] += 1.0
        a[i] = decay * prev
    return a


def _exposure(times: np.ndarray, dims: np.ndarray, n_dims: int, beta: float, T: float) -> np.ndarray:
    """Per-source integrated kernel mass on ``[0, T]``: ``Σ_{j:dim ell} (1 − e^{−β(T−t_j)})/β``.

    The EM denominator — the total offspring "exposure" a source dimension provides.
    """
    expo = np.zeros(n_dims, dtype=float)
    integ = (1.0 - np.exp(-beta * (T - times))) / beta
    for ell in range(n_dims):
        expo[ell] = float(np.sum(integ[dims == ell]))
    return expo


def _fit_em_fixed_beta(
    times: np.ndarray,
    dims: np.ndarray,
    n_dims: int,
    beta: float,
    T: float,
    max_iter: int,
    tol: float,
) -> tuple[np.ndarray, np.ndarray, float, int, bool]:
    """EM for ``μ`` and ``α`` with ``β`` fixed. Returns ``(mu, alpha, loglik, n_iter, converged)``.

    E-step uses the branching-structure responsibilities; the total triggered mass from source
    ``ell`` to event ``i`` is ``α[k_i, ell]·A[i, ell]/λ_i``, so the EM numerators accumulate in
    O(N·K) via the recursion states ``A``.
    """
    n = times.shape[0]
    counts = np.bincount(dims, minlength=n_dims).astype(float)

    # Init: half the mass to background, a modest sub-critical excitation.
    mu = np.maximum(counts / max(T, _EPS) * 0.5, _EPS)
    alpha = np.full((n_dims, n_dims), 0.1 * beta, dtype=float)

    a = _recursion_states(times, dims, n_dims, beta)
    expo = _exposure(times, dims, n_dims, beta, T)

    prev_ll = -np.inf
    converged = False
    it = 0
    for it in range(1, max_iter + 1):  # noqa: B007 — final value is the reported iteration count
        # E-step / sufficient statistics.
        lam = mu[dims] + np.einsum("kl,il->ik", alpha, a)[np.arange(n), dims]
        lam = np.maximum(lam, _EPS)
        s_mu = np.zeros(n_dims, dtype=float)  # expected background events per dim
        trig = np.zeros((n_dims, n_dims), dtype=float)  # expected triggered k<-l
        inv_lam = 1.0 / lam
        for k in range(n_dims):
            sel = dims == k
            if not np.any(sel):
                continue
            s_mu[k] = float(np.sum(mu[k] * inv_lam[sel]))
            # triggered mass into type-k events from each source ell
            trig[k, :] = alpha[k, :] * np.sum(a[sel] * inv_lam[sel, None], axis=0)

        # M-step.
        mu = np.maximum(s_mu / max(T, _EPS), _EPS)
        alpha = np.where(expo[None, :] > _EPS, trig / np.maximum(expo[None, :], _EPS), 0.0)

        # Log-likelihood: Σ_i log λ_i − Σ_k Λ_k(T).
        lam_new = mu[dims] + np.einsum("kl,il->ik", alpha, a)[np.arange(n), dims]
        lam_new = np.maximum(lam_new, _EPS)
        compensator = mu * T + alpha @ expo
        ll = float(np.sum(np.log(lam_new)) - np.sum(compensator))

        if np.isfinite(ll) and abs(ll - prev_ll) < tol * (1.0 + abs(prev_ll)):
            prev_ll = ll
            converged = True
            break
        prev_ll = ll

    return mu, alpha, prev_ll, it, converged


def fit_hawkes(
    event_times: np.ndarray,
    event_dims: np.ndarray,
    *,
    n_dims: int = 2,
    labels: tuple[str, ...] = ("buy", "sell"),
    beta: float | None = None,
    estimate_beta: bool = False,
    beta_grid: np.ndarray | None = None,
    T: float | None = None,
    max_iter: int = 200,
    tol: float = 1e-6,
) -> HawkesFit:
    """Fit a multivariate exponential Hawkes process to a token's event tape.

    Parameters
    ----------
    event_times
        1-D float array of event times (seconds from the window start), non-negative.
    event_dims
        1-D int array, same length, giving each event's dimension (0 = buy, 1 = sell).
    n_dims
        Number of point-process dimensions (2 for buy/sell).
    beta
        Shared kernel decay. If ``None`` a data-driven default (inverse median gap) is used.
    estimate_beta
        If ``True``, profile the likelihood over ``beta_grid`` (or a default log-spaced grid)
        and keep the best. More faithful but slower; off by default for the small-sample regime.
    T
        Observation horizon. Defaults to the last event time (the ``as_of`` instant).

    Raises
    ------
    ValueError
        If there are no events, or the arrays are malformed. A Hawkes intensity is undefined
        with an empty tape — the pipeline handles the empty case explicitly rather than fitting.
    """
    times = np.asarray(event_times, dtype=float).ravel()
    dims = np.asarray(event_dims, dtype=int).ravel()
    if times.shape[0] != dims.shape[0]:
        raise ValueError("event_times and event_dims must have equal length")
    if times.shape[0] == 0:
        raise ValueError("cannot fit a Hawkes process to an empty tape")
    if np.any(times < 0):
        raise ValueError("event_times must be non-negative (seconds from window start)")
    if np.any((dims < 0) | (dims >= n_dims)):
        raise ValueError("event_dims must be in [0, n_dims)")

    order = np.argsort(times, kind="stable")
    times = times[order]
    dims = dims[order]

    horizon = float(times[-1]) if T is None else float(T)
    if horizon < float(times[-1]):
        raise ValueError("T must be >= the last event time")
    horizon = max(horizon, _EPS)

    if estimate_beta:
        grid = beta_grid
        if grid is None:
            b0 = _default_beta(times)
            grid = np.geomspace(b0 / 8.0, b0 * 8.0, num=13)
        best: tuple[np.ndarray, np.ndarray, float, int, bool] | None = None
        best_beta = float(grid[0])
        for b in np.asarray(grid, dtype=float).ravel():
            b = float(b)
            if b <= 0:
                continue
            res = _fit_em_fixed_beta(times, dims, n_dims, b, horizon, max_iter, tol)
            if best is None or res[2] > best[2]:
                best = res
                best_beta = b
        assert best is not None
        mu, alpha, ll, n_iter, converged = best
        beta_used = best_beta
    else:
        beta_used = float(beta) if beta is not None else _default_beta(times)
        if beta_used <= 0:
            raise ValueError("beta must be positive")
        mu, alpha, ll, n_iter, converged = _fit_em_fixed_beta(
            times, dims, n_dims, beta_used, horizon, max_iter, tol
        )

    params = HawkesParams(mu=mu, alpha=alpha, beta=beta_used, labels=labels)
    return HawkesFit(
        params=params,
        event_times=times,
        event_dims=dims,
        T=horizon,
        log_likelihood=ll,
        n_iter=n_iter,
        converged=converged,
    )


def simulate_hawkes(
    mu: np.ndarray,
    alpha: np.ndarray,
    beta: float,
    T: float,
    rng: np.random.Generator,
) -> tuple[np.ndarray, np.ndarray]:
    """Simulate a multivariate exponential Hawkes process on ``[0, T]`` via Ogata's thinning.

    Provided so the estimator can be validated against tapes with a **known** branching ratio
    (the primary correctness test, paper §4.5). Returns sorted ``(times, dims)``.
    """
    mu = np.asarray(mu, dtype=float).ravel()
    alpha = np.asarray(alpha, dtype=float)
    k = mu.shape[0]
    times_list: list[float] = []
    dims_list: list[int] = []

    def intensity(t: float) -> np.ndarray:
        lam = mu.copy()
        if times_list:
            ta = np.asarray(times_list)
            da = np.asarray(dims_list)
            decays = np.exp(-beta * (t - ta))
            src = np.array([np.sum(decays[da == ell]) for ell in range(k)])
            lam = mu + alpha @ src
        return lam

    t = 0.0
    while t < T:
        lam_bar = float(np.sum(intensity(t)))
        if lam_bar <= 0:
            break
        w = rng.exponential(1.0 / lam_bar)
        t = t + w
        if t >= T:
            break
        lam = intensity(t)
        total = float(np.sum(lam))
        if rng.uniform() <= total / lam_bar:
            # accept; assign a dimension proportional to per-dim intensity
            probs = lam / total
            d = int(rng.choice(k, p=probs))
            times_list.append(t)
            dims_list.append(d)

    return np.asarray(times_list, dtype=float), np.asarray(dims_list, dtype=int)
