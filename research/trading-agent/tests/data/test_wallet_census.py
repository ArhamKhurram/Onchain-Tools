"""Wallet census tests — FIFO realized-PnL correctness, cross-token cohorting, wash exclusion,
and output-schema compatibility with the operator-export (wallets-file) parser."""

from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path

import numpy as np
import polars as pl
import pytest

from oct_trading_agent.data.census.cohorts import (
    CensusConfig,
    extract_cohorts,
    to_wallets_file_rows,
    write_census_outputs,
)
from oct_trading_agent.data.census.crawler import crawl_dataset, scan_swaps
from oct_trading_agent.data.census.fifo import fifo_pair_pnl
from oct_trading_agent.data.census.loader import build_labeled_wallets, load_cohort_wallets
from oct_trading_agent.data.labeling.reconstruct import build_trajectories
from oct_trading_agent.data.labeling.wallets_file import parse_tracked_wallets, select_cohort
from oct_trading_agent.data.pinax_client.decode import WSOL

# ---------------------------------------------------------------------------
# FIFO realized PnL (synthetic tapes)
# ---------------------------------------------------------------------------


def _tape(
    trades: list[tuple[bool, float, float, float]],
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    is_buy = np.array([t[0] for t in trades])
    base = np.array([t[1] for t in trades])
    quote = np.array([t[2] for t in trades])
    ts = np.array([t[3] for t in trades])
    return is_buy, base, quote, ts


def test_fifo_simple_round_trip() -> None:
    # buy 100 @ 0.01 (1 SOL), sell 100 @ 0.02 (2 SOL) -> +1 SOL realized
    pnl = fifo_pair_pnl(*_tape([(True, 100.0, 1.0, 0.0), (False, 100.0, 2.0, 60.0)]))
    assert pnl.realized_pnl == pytest.approx(1.0)
    assert pnl.residual_base == pytest.approx(0.0)
    assert pnl.residual_cost_quote == pytest.approx(0.0)
    assert pnl.mean_hold_s == pytest.approx(60.0)
    assert pnl.uncosted_sell_quote == pytest.approx(0.0)


def test_fifo_partial_close_books_only_sold_portion() -> None:
    # buy 100 for 1 SOL, sell 40 for 2 SOL -> realized = 2 - 40*0.01 = +1.6; 60 stay unrealized
    pnl = fifo_pair_pnl(*_tape([(True, 100.0, 1.0, 0.0), (False, 40.0, 2.0, 10.0)]))
    assert pnl.realized_pnl == pytest.approx(2.0 - 40.0 * 0.01)
    assert pnl.residual_base == pytest.approx(60.0)
    assert pnl.residual_cost_quote == pytest.approx(0.6)


def test_fifo_matches_oldest_lot_first() -> None:
    # lot A: 100 @ 0.01; lot B: 100 @ 0.03; sell 150 @ 0.02:
    # A's 100 book +1.0; B's 50 book -0.5 -> +0.5 total, 50 of B remain at cost 1.5
    pnl = fifo_pair_pnl(
        *_tape(
            [
                (True, 100.0, 1.0, 0.0),
                (True, 100.0, 3.0, 1.0),
                (False, 150.0, 3.0, 2.0),
            ]
        )
    )
    assert pnl.realized_pnl == pytest.approx(0.5)
    assert pnl.residual_base == pytest.approx(50.0)
    assert pnl.residual_cost_quote == pytest.approx(50.0 * 0.03)


def test_fifo_unrealized_inventory_is_never_profit() -> None:
    # buys only: whatever the "worth", realized must be exactly zero
    pnl = fifo_pair_pnl(*_tape([(True, 100.0, 1.0, 0.0), (True, 200.0, 1.0, 1.0)]))
    assert pnl.realized_pnl == 0.0
    assert pnl.quote_in == pytest.approx(2.0)
    assert pnl.residual_base == pytest.approx(300.0)


def test_fifo_uncosted_sell_excluded_from_pnl() -> None:
    # sell 100 with no prior buy (transfer in): proceeds tallied separately, PnL stays 0
    pnl = fifo_pair_pnl(*_tape([(False, 100.0, 5.0, 0.0)]))
    assert pnl.realized_pnl == 0.0
    assert pnl.uncosted_sell_quote == pytest.approx(5.0)
    # oversell: buy 50, sell 100 -> only the 50 with basis book PnL
    pnl2 = fifo_pair_pnl(*_tape([(True, 50.0, 1.0, 0.0), (False, 100.0, 4.0, 1.0)]))
    assert pnl2.realized_pnl == pytest.approx(50.0 * 0.04 - 1.0)
    assert pnl2.uncosted_sell_quote == pytest.approx(50.0 * 0.04)


# ---------------------------------------------------------------------------
# Synthetic dataset (parquet) -> crawler -> cohorts
# ---------------------------------------------------------------------------

_MINTS = [f"Mint{i}pump" for i in range(4)]


def _row(
    wallet: str, mint: str, is_buy: bool, base: float, quote: float, ts: int, sig: str
) -> dict[str, object]:
    return {
        "amm_pool": f"pool-{mint}",
        "protocol": "pumpfun",
        "signature": sig,
        "signer": wallet,
        "block_num": ts,
        "timestamp": ts,
        "transaction_index": 0,
        "instruction_index": 0,
        "input_mint": WSOL if is_buy else mint,
        "output_mint": mint if is_buy else WSOL,
        "input_value": quote if is_buy else base,
        "output_value": base if is_buy else quote,
    }


def _synthetic_dataset(root: Path) -> None:
    """4 tokens x 9 wallets: w-win top-quartile everywhere, w-lose bottom everywhere,
    w-wash a flaggable constant-size ping-pong bot, w-hold a pure accumulator, fillers between."""
    pools = root / "pools"
    pools.mkdir(parents=True)
    sig = 0

    def s() -> str:
        nonlocal sig
        sig += 1
        return f"sig{sig:05d}"

    for mint in _MINTS:
        rows: list[dict[str, object]] = []
        t = 1_000_000
        # winner: buy 1 SOL, sell for 3 SOL (+2 realized per token)
        rows += [
            _row("w-win", mint, True, 1000.0, 1.0, t, s()),
            _row("w-win", mint, False, 1000.0, 3.0, t + 300, s()),
        ]
        # loser: buy 2 SOL, sell for 0.5 SOL (-1.5 realized per token)
        rows += [
            _row("w-lose", mint, True, 1000.0, 2.0, t + 10, s()),
            _row("w-lose", mint, False, 1000.0, 0.5, t + 600, s()),
        ]
        # holder: buys 1.5 SOL of inventory per token, never sells
        rows += [_row("w-hold", mint, True, 500.0, 1.5, t + 20, s())]
        # wash bot: 24 alternating constant-size trades at a constant 30s metronome, would
        # otherwise be the top wallet (+2.4 realized per token via a rigged sell price)
        for k in range(12):
            rows += [
                _row("w-wash", mint, True, 100.0, 1.0, t + 30 * (2 * k), s()),
                _row("w-wash", mint, False, 100.0, 1.2, t + 30 * (2 * k + 1), s()),
            ]
        # fillers: mild single-trade wallets to give quartiles bodies (mixed small PnL)
        for j in range(5):
            w = f"w-mid{j}"
            rows += [
                _row(w, mint, True, 100.0, 1.0, t + 40 + j, s()),
                _row(w, mint, False, 100.0, 1.0 + 0.02 * (j - 2), t + 700 + j, s()),
            ]
        # one-token wonder: a single top-quartile placement on the FIRST token only
        if mint == _MINTS[0]:
            rows += [
                _row("w-lucky", mint, True, 1000.0, 1.0, t + 50, s()),
                _row("w-lucky", mint, False, 1000.0, 2.5, t + 800, s()),
            ]
        pl.DataFrame(rows).write_parquet(pools / f"pool-{mint}.parquet")


@pytest.fixture()
def dataset(tmp_path: Path) -> Path:
    root = tmp_path / "ds"
    _synthetic_dataset(root)
    return root


def test_crawler_normalizes_and_counts_pairs(dataset: Path) -> None:
    pairs = crawl_dataset(dataset)
    assert pairs.height == 9 * len(_MINTS) + 1  # 9 wallets per token + w-lucky on token 0
    win = pairs.filter((pl.col("wallet") == "w-win") & (pl.col("mint") == _MINTS[0]))
    assert win.get_column("realized_pnl")[0] == pytest.approx(2.0)
    hold = pairs.filter(pl.col("wallet") == "w-hold")
    assert hold.get_column("realized_pnl").sum() == pytest.approx(0.0)
    assert hold.get_column("residual_cost_quote").sum() == pytest.approx(1.5 * len(_MINTS))


def test_crawler_collapses_multi_fill_signatures(dataset: Path) -> None:
    # two rows sharing (wallet, mint, signature, side) must collapse into one economic trade
    df = scan_swaps(dataset).collect()
    extra = pl.DataFrame(
        [
            _row("w-split", _MINTS[0], True, 60.0, 0.6, 999, "sigSPLIT"),
            {**_row("w-split", _MINTS[0], True, 40.0, 0.4, 999, "sigSPLIT"), "instruction_index": 1},
        ]
    )
    root2 = dataset / ".." / "ds2"
    (root2 / "pools").mkdir(parents=True)
    extra.write_parquet(root2 / "pools" / "p.parquet")
    df2 = scan_swaps(root2).collect()
    assert df2.height == 1
    assert df2.get_column("base")[0] == pytest.approx(100.0)
    assert df2.get_column("quote")[0] == pytest.approx(1.0)
    assert df.filter(pl.col("wallet") == "w-split").height == 0


def test_cross_token_cohort_assignment(dataset: Path) -> None:
    cfg = CensusConfig(min_wallets_per_token=5, min_tokens_ranked=3, holder_min_tokens=2)
    cohorts = extract_cohorts(crawl_dataset(dataset), cfg)

    winners = cohorts.winners.get_column("wallet").to_list()
    losers = cohorts.losers.get_column("wallet").to_list()
    holders = cohorts.holders.get_column("wallet").to_list()
    suspects = cohorts.suspects.get_column("wallet").to_list()

    assert "w-win" in winners  # repeated top-quartile, positive total
    assert "w-lose" in losers  # repeated bottom-quartile, negative total
    assert "w-hold" in holders  # top net-accumulator by residual cost
    assert "w-wash" in suspects  # flagged, despite being nominally profitable
    assert "w-wash" not in winners  # wash exclusion is what keeps the ranking honest
    assert "w-lose" not in winners and "w-win" not in losers


def test_wash_flag_reasons_and_one_token_wonder(dataset: Path) -> None:
    cfg = CensusConfig(min_wallets_per_token=5, min_tokens_ranked=3)
    cohorts = extract_cohorts(crawl_dataset(dataset), cfg)
    wash = cohorts.wallets.filter(pl.col("wallet") == "w-wash")
    assert bool(wash.get_column("flag_ping_pong")[0]) or bool(wash.get_column("flag_metronome")[0])
    rows = to_wallets_file_rows(cohorts.suspects, "suspect")
    flagged = next(r for r in rows if r["address"] == "w-wash")
    assert isinstance(flagged["suspect_reasons"], list) and flagged["suspect_reasons"]
    # a wallet top-quartile once but under N ranked tokens is flagged, never cohorted
    wonders = cohorts.wallets.filter(pl.col("one_token_wonder")).get_column("wallet").to_list()
    assert "w-lucky" in wonders
    assert set(wonders).isdisjoint(cohorts.winners.get_column("wallet").to_list())


def test_machine_volume_flag_excludes_multi_token_bots(dataset: Path) -> None:
    # lower the window threshold so w-wash's 96 trades count as machine-scale — the multi-token
    # arb/MEV shape the single-token-hyperactivity flag structurally misses
    cfg = CensusConfig(min_wallets_per_token=5, min_tokens_ranked=3, machine_trade_count=90)
    cohorts = extract_cohorts(crawl_dataset(dataset), cfg)
    wash = cohorts.wallets.filter(pl.col("wallet") == "w-wash")
    assert bool(wash.get_column("flag_machine")[0])
    rows = to_wallets_file_rows(cohorts.suspects, "suspect")
    flagged = next(r for r in rows if r["address"] == "w-wash")
    assert any("machine-scale" in reason for reason in flagged["suspect_reasons"])
    assert "w-win" in cohorts.winners.get_column("wallet").to_list()  # humans unaffected


def test_outputs_parse_via_wallets_file_and_feed_bc_pipeline(
    dataset: Path, tmp_path: Path
) -> None:
    cfg = CensusConfig(min_wallets_per_token=5, min_tokens_ranked=3)
    cohorts = extract_cohorts(crawl_dataset(dataset), cfg)
    out = tmp_path / "census_out"
    paths = write_census_outputs(cohorts, out, config=cfg, source="synthetic")
    assert json.loads(paths["summary"].read_text(encoding="utf-8"))["n_winners"] >= 1

    # 1) the export round-trips through the OPERATOR-EXPORT parser (schema compatibility)
    tracked = parse_tracked_wallets(paths["winners"])
    assert tracked and tracked[0].address == "w-win"
    top = select_cohort(tracked, max_wallets=10)
    # ranking score = cross-token realized PnL: 4 tokens x +2 SOL realized
    assert float(top[0].native_balance) == pytest.approx(8.0)

    # 2) the offline loader rebuilds BC-ready LabeledWallets from the same capture
    wallets = load_cohort_wallets(paths["winners"], dataset, max_wallets=5)
    by_addr = {w.wallet: w for w in wallets}
    assert "w-win" in by_addr and by_addr["w-win"].trades
    trajectories = build_trajectories(by_addr["w-win"])
    assert len(trajectories) == len(_MINTS)
    assert all(t.outcome == "win" for t in trajectories)

    # 3) losers flow through the SAME pipeline (loser-clone eval baselines)
    losers = load_cohort_wallets(paths["losers"], dataset, max_wallets=5)
    loser = next(w for w in losers if w.wallet == "w-lose")
    assert all(t.outcome == "loss" for t in build_trajectories(loser))


def test_build_labeled_wallets_orders_trades_and_uses_decimal(dataset: Path) -> None:
    (wallet,) = build_labeled_wallets(["w-win"], dataset)
    times = [t.timestamp for t in wallet.trades]
    assert times == sorted(times)
    assert isinstance(wallet.trades[0].base_amount, Decimal)
