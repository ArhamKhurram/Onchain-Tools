"""FIFO realized-PnL engine for the wallet census — pure numpy/python, torch-free.

The census ranks wallets by **realized** PnL aggregated **across** tokens (the HALO/satsmonkes
discipline: never a single-token peak, never an unrealized mark — paper §3.5.4, §9.3). This module
is the per-(wallet, token) primitive: walk one wallet's time-ordered buys/sells of one mint and book
PnL on a first-in-first-out lot basis.

The rules, precisely:

* A **BUY** pushes a lot ``(base_amount, unit_cost, timestamp)`` where ``unit_cost = quote/base``.
* A **SELL** consumes the *oldest* lots first at the sell's unit price; each matched quantity ``q``
  books ``q * (sell_price - lot_cost)`` of realized PnL. Partial lots split; the remainder keeps its
  original cost and timestamp.
* A sell (or the portion of one) with **no lot to match** — tokens that arrived by transfer/airdrop,
  not by a recorded buy — is **excluded from realized PnL** and tallied separately as
  ``uncosted_sell_quote``. This deliberately DIVERGES from the BC-demo reconstruction
  (:mod:`oct_trading_agent.data.labeling.reconstruct` books such proceeds as profit, which is honest
  for *behaviour* cloning): for a profitability *ranking*, crediting cost-free proceeds would crown
  wallets that receive tokens from a funder and dump them — exactly the sybil shape the census must
  not reward.
* **Unclosed inventory is never profit.** Lots still open at end-of-data surface only as
  ``residual_base`` / ``residual_cost_quote`` (the holder dimension), never in ``realized_pnl``.
* ``mean_hold_s`` is the matched-base-weighted mean of (sell time − lot buy time) — a hold-behaviour
  fingerprint over the round trips that actually happened.

Float64 throughout: the census is a large-N ranking pass, not an accounting ledger; the
Decimal-exact path for demonstrations stays in ``labeling/reconstruct.py``.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class PairPnL:
    """Realized-only FIFO result for one (wallet, token) pair."""

    n_buys: int
    n_sells: int
    quote_in: float  # total quote spent buying
    quote_out: float  # total quote received selling (matched portion only)
    realized_pnl: float  # FIFO-matched proceeds minus matched cost; never includes inventory
    uncosted_sell_quote: float  # sell proceeds with no cost basis (transfers in) — NOT in PnL
    base_bought: float
    base_sold: float
    residual_base: float  # unclosed inventory (net accumulation, base units)
    residual_cost_quote: float  # quote still deployed in unclosed lots (holder dimension)
    mean_hold_s: float  # matched-base-weighted hold time of round trips; 0.0 if none matched


def fifo_pair_pnl(
    is_buy: np.ndarray,
    base: np.ndarray,
    quote: np.ndarray,
    ts: np.ndarray,
) -> PairPnL:
    """FIFO-walk one (wallet, token) pair's time-ordered trades into a :class:`PairPnL`.

    ``is_buy`` is a bool array; ``base``/``quote`` are UI-unit amounts; ``ts`` is epoch seconds.
    All four must be equal-length and already time-ordered (the crawler sorts).
    """
    lots: deque[tuple[float, float, float]] = deque()  # (base_remaining, unit_cost, buy_ts)
    n_buys = 0
    n_sells = 0
    quote_in = 0.0
    quote_out = 0.0
    realized = 0.0
    uncosted = 0.0
    base_bought = 0.0
    base_sold = 0.0
    hold_weighted = 0.0
    hold_weight = 0.0

    for i in range(int(np.asarray(is_buy).shape[0])):
        b = float(base[i])
        q = float(quote[i])
        t = float(ts[i])
        if b <= 0.0 or q <= 0.0:
            continue
        if bool(is_buy[i]):
            n_buys += 1
            quote_in += q
            base_bought += b
            lots.append((b, q / b, t))
            continue
        n_sells += 1
        base_sold += b
        sell_price = q / b
        remaining = b
        while remaining > 0.0 and lots:
            lot_base, lot_cost, lot_ts = lots[0]
            matched = min(remaining, lot_base)
            realized += matched * (sell_price - lot_cost)
            quote_out += matched * sell_price
            hold_weighted += matched * max(t - lot_ts, 0.0)
            hold_weight += matched
            remaining -= matched
            if matched >= lot_base:
                lots.popleft()
            else:
                lots[0] = (lot_base - matched, lot_cost, lot_ts)
        if remaining > 0.0:  # no cost basis left — transfer/airdrop proceeds, excluded from PnL
            uncosted += remaining * sell_price

    residual_base = sum(lot[0] for lot in lots)
    residual_cost = sum(lot[0] * lot[1] for lot in lots)
    return PairPnL(
        n_buys=n_buys,
        n_sells=n_sells,
        quote_in=quote_in,
        quote_out=quote_out,
        realized_pnl=realized,
        uncosted_sell_quote=uncosted,
        base_bought=base_bought,
        base_sold=base_sold,
        residual_base=residual_base,
        residual_cost_quote=residual_cost,
        mean_hold_s=(hold_weighted / hold_weight) if hold_weight > 0.0 else 0.0,
    )


__all__ = ["PairPnL", "fifo_pair_pnl"]
