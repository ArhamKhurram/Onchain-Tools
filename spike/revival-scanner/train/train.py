"""Revival-scanner v1 trainer.

Input:  ../data/corpus/episodes.jsonl (one row per dormancy-exit episode)
Output: models/ (LightGBM boosters) + metrics.json + stdout report

Evaluation law (TRAINING_ARCHITECTURE.md #6): OUT-OF-TIME split only.
  train = sol-w1 (earlier Solana window) + BSC episodes before the test cutoff
  test  = sol-w2 (latest Solana window)  + BSC episodes after the cutoff
The cutoff is sol-w2's earliest episode timestamp, so "test" is strictly the
latest slice of tape on both chains.

Models:
  (a) LGBMClassifier  -> P(peak_24h >= 2x)   [the product event]
  (b) LGBM quantile regressors P10/P50/P90 of log(peak_24h)  [magnitude head]

Baseline: the v0 hand gates evaluated at the same decision minute on the same
test episodes (trigger z>3 & ATR%>0.1% + RVOL>=3 + buyers>=5 + buy/sell>=1.5),
plus model precision at the same alert budget.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import lightgbm as lgb
from sklearn.metrics import average_precision_score

HERE = Path(__file__).resolve().parent
CORPUS = HERE.parent / "data" / "corpus"
MODELS = HERE / "models"
MODELS.mkdir(exist_ok=True)

FEATURES = [
    "atrPctZ", "atrPct", "rvol", "uniqueBuyers10m", "buySellRatio10m",
    "vol10m", "absorption", "dispFromBaseline", "dormancyHours",
    "tokenAgeMin", "tradesInMinute", "hourUtc", "dayOfWeek",
    "priorEpisodes", "prior2xEpisodes", "chainId",
]


def load() -> pd.DataFrame:
    rows = []
    with open(CORPUS / "episodes.jsonl", encoding="utf-8") as f:
        for line in f:
            if line.strip():
                rows.append(json.loads(line))
    # Operator-labeled intake snapshots (data/labels, window='intake') — see
    # src/labels-to-corpus.js. Few rows, newest tape, OHLCV-derived features
    # (wallet/trade fields null -> LightGBM missing). They join the TEST side
    # only: far too few to train on, exactly right to evaluate on.
    intake = HERE.parent / "data" / "labels" / "intake-episodes.jsonl"
    if intake.exists():
        with open(intake, encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    r = json.loads(line)
                    if r.get("censored"):
                        continue  # short tape + no 2x = unknown, not negative
                    rows.append(r)
    df = pd.DataFrame(rows)
    df["chainId"] = (df["chain"] == "bsc").astype(int)
    df = df[df["warm"] == 1].copy()
    df = df.dropna(subset=["peak_24h", "label2x"])
    # Data-quality filter: peak_24h > 100x is physically implausible for a real
    # token — every such row is a near-zero dormancy-baseline division artifact
    # (baseline price ~1e-5, 0-1 unique buyers). 19/12879 = 0.15% of episodes.
    # Left in, they inject fake positives into label2x and blow up the log-peak
    # magnitude target. Excluded, and reported in TRAINING_REPORT limitations.
    n_before = len(df)
    df = df[df["peak_24h"] <= 100].copy()
    globals()["_dropped_outliers"] = n_before - len(df)
    return df


def split(df: pd.DataFrame):
    cutoff = df.loc[df["window"] == "sol-w2", "ts"].min()
    test_mask = (
        (df["window"] == "sol-w2")
        | ((df["chain"] == "bsc") & (df["ts"] >= cutoff))
        | (df["window"] == "intake")
    )
    train = df[~test_mask].copy()
    test = df[test_mask].copy()
    return train, test, int(cutoff)


def precision_at_k(y_true, scores, frac):
    k = max(1, int(len(scores) * frac))
    idx = np.argsort(-scores)[:k]
    return float(np.mean(y_true[idx])), k


def main():
    df = load()
    train, test, cutoff = split(df)
    # time-ordered early-stopping slice from the train tail (still before cutoff)
    train = train.sort_values("ts")
    n_val = max(200, int(len(train) * 0.15))
    tr, va = train.iloc[:-n_val], train.iloc[-n_val:]

    Xtr, ytr = tr[FEATURES], tr["label2x"].values
    Xva, yva = va[FEATURES], va["label2x"].values
    Xte, yte = test[FEATURES], test["label2x"].values

    base_rate_train = float(np.mean(train["label2x"]))
    base_rate_test = float(np.mean(yte))
    print(f"episodes: total={len(df)} train={len(train)} (fit={len(tr)} val={len(va)}) test={len(test)}")
    print(f"test cutoff ts={cutoff}  base rate: train={base_rate_train:.4f} test={base_rate_test:.4f}")
    per = df.groupby(["chain", "window"]).agg(n=("label2x", "size"), rate2x=("label2x", "mean"),
                                              med_peak=("peak_24h", "median"))
    print(per.to_string())

    # ---- (a) classifier ----
    clf = lgb.LGBMClassifier(
        n_estimators=800, learning_rate=0.05, num_leaves=31,
        min_child_samples=60, subsample=0.9, subsample_freq=1,
        colsample_bytree=0.9, reg_lambda=1.0, verbose=-1,
    )
    clf.fit(Xtr, ytr, eval_set=[(Xva, yva)], eval_metric="average_precision",
            callbacks=[lgb.early_stopping(60, verbose=False)])
    p_te = clf.predict_proba(Xte)[:, 1]
    pr_auc = float(average_precision_score(yte, p_te))

    metrics = {
        "n_train": int(len(train)), "n_test": int(len(test)),
        "base_rate_train": base_rate_train, "base_rate_test": base_rate_test,
        "test_cutoff_ts": cutoff,
        "pr_auc_test": pr_auc,
        "pr_auc_lift": pr_auc / base_rate_test if base_rate_test else None,
        "best_iteration": int(clf.best_iteration_ or 0),
        "precision_at": {},
    }
    print(f"\nCLASSIFIER (label2x): PR-AUC={pr_auc:.4f} (base rate {base_rate_test:.4f}, "
          f"lift {pr_auc / base_rate_test:.2f}x) best_iter={clf.best_iteration_}")
    for frac in (0.05, 0.10, 0.20):
        p, k = precision_at_k(yte, p_te, frac)
        metrics["precision_at"][f"top{int(frac*100)}pct"] = {
            "k": k, "precision": p, "lift": p / base_rate_test if base_rate_test else None}
        print(f"  precision@top{int(frac*100)}% (k={k}): {p:.4f}  lift={p / base_rate_test:.2f}x")

    # ---- operator-labeled intake rows: where does the model rank them? ----
    intake_mask = (test["window"] == "intake").values
    if intake_mask.any():
        print("\nINTAKE ROWS (operator-labeled, scored by the classifier):")
        metrics["intake_rows"] = []
        for pos, (_, row) in zip(np.where(intake_mask)[0], test[intake_mask].iterrows()):
            score = float(p_te[pos])
            pctile = float(np.mean(p_te <= score) * 100)
            rec = {
                "symbol": row.get("symbol"), "ts": int(row["ts"]),
                "operatorLabel": row.get("operatorLabel"),
                "label2x": int(row["label2x"]), "peak_24h": float(row["peak_24h"]),
                "score": score, "test_percentile": pctile,
            }
            metrics["intake_rows"].append(rec)
            print(f"  {row.get('symbol')} @ {pd.Timestamp(row['ts'], unit='s')}Z "
                  f"label2x={int(row['label2x'])} peak24h={row['peak_24h']:.2f}x "
                  f"score={score:.4f} -> top {100 - pctile:.1f}% of test")

    # ---- hand-gate baseline on the same test episodes ----
    g = test
    gates = (
        (g["atrPctZ"] > 3.0) & (g["atrPct"] > 0.001)
        & (g["rvol"] >= 3.0) & (g["uniqueBuyers10m"] >= 5)
        & (g["buySellRatio10m"] >= 1.5)
    )
    n_alerts = int(gates.sum())
    gate_prec = float(g.loc[gates, "label2x"].mean()) if n_alerts else None
    gate_recall = float(g.loc[gates, "label2x"].sum() / max(1, yte.sum()))
    metrics["hand_gates_test"] = {
        "alerts": n_alerts, "precision": gate_prec, "recall_of_2x": gate_recall,
        "lift": gate_prec / base_rate_test if gate_prec is not None and base_rate_test else None,
    }
    print(f"\nHAND-GATE BASELINE (same test episodes): alerts={n_alerts} "
          f"precision={gate_prec if gate_prec is not None else float('nan'):.4f} "
          f"recall(2x)={gate_recall:.4f}")
    if n_alerts:
        p_at_budget, _ = precision_at_k(yte, p_te, n_alerts / len(g))
        model_recall = float(yte[np.argsort(-p_te)[:n_alerts]].sum() / max(1, yte.sum()))
        metrics["model_at_gate_budget"] = {"precision": p_at_budget, "recall_of_2x": model_recall}
        print(f"  model at same alert budget (k={n_alerts}): precision={p_at_budget:.4f} recall(2x)={model_recall:.4f}")

    # ---- (b) magnitude head: quantile regression on log(peak_24h) ----
    y_log_tr = np.log(np.clip(tr["peak_24h"].values, 0.05, None))
    y_log_va = np.log(np.clip(va["peak_24h"].values, 0.05, None))
    y_log_te = np.log(np.clip(test["peak_24h"].values, 0.05, None))
    quants = {}
    preds_q = {}
    for a in (0.10, 0.50, 0.90):
        q = lgb.LGBMRegressor(
            objective="quantile", alpha=a,
            n_estimators=600, learning_rate=0.05, num_leaves=31,
            min_child_samples=60, verbose=-1,
        )
        q.fit(Xtr, y_log_tr, eval_set=[(Xva, y_log_va)],
              callbacks=[lgb.early_stopping(60, verbose=False)])
        pred = q.predict(Xte)
        preds_q[a] = pred
        cov = float(np.mean(y_log_te <= pred))
        quants[f"p{int(a*100)}"] = {"coverage_below": cov, "best_iter": int(q.best_iteration_ or 0)}
        q.booster_.save_model(str(MODELS / f"magnitude_p{int(a*100)}.txt"))
    med_mult = np.exp(preds_q[0.50])
    mae = float(np.median(np.abs(np.exp(y_log_te) - med_mult)))
    quants["p50_median_abs_err_mult"] = mae
    interval = float(np.mean((y_log_te >= preds_q[0.10]) & (y_log_te <= preds_q[0.90])))
    quants["p10_p90_interval_coverage"] = interval
    metrics["magnitude"] = quants
    print(f"\nMAGNITUDE HEAD log(peak_24h): P10/P90 interval coverage={interval:.3f} "
          f"(target 0.80), P50 median |err|={mae:.3f}x")
    for k, v in quants.items():
        if isinstance(v, dict):
            print(f"  {k}: coverage_below={v['coverage_below']:.3f}")

    # ---- importances ----
    imp = sorted(zip(FEATURES, clf.booster_.feature_importance("gain")),
                 key=lambda t: -t[1])
    total_gain = sum(g for _, g in imp) or 1
    metrics["feature_importance_gain"] = {f: float(g / total_gain) for f, g in imp}
    print("\nFEATURE IMPORTANCES (gain share):")
    for f, gn in imp:
        print(f"  {f:<18} {gn / total_gain:6.1%}")

    try:
        import shap
        ex = shap.TreeExplainer(clf.booster_)
        sample = Xte.sample(min(4000, len(Xte)), random_state=7)
        sv = ex.shap_values(sample)
        if isinstance(sv, list):
            sv = sv[-1]
        mean_abs = np.abs(sv).mean(axis=0)
        order = np.argsort(-mean_abs)
        metrics["shap_mean_abs"] = {FEATURES[i]: float(mean_abs[i]) for i in order}
        print("\nSHAP mean|value| (test sample):")
        for i in order:
            print(f"  {FEATURES[i]:<18} {mean_abs[i]:.4f}")
    except Exception as e:  # SHAP is optional by design
        print(f"\nSHAP skipped: {e}")
        metrics["shap_mean_abs"] = None

    clf.booster_.save_model(str(MODELS / "classifier_2x.txt"))
    (MODELS / "features.json").write_text(json.dumps(FEATURES))
    with open(HERE / "metrics.json", "w") as f:
        json.dump(metrics, f, indent=1)
    print(f"\nsaved models -> {MODELS}, metrics -> {HERE / 'metrics.json'}")


if __name__ == "__main__":
    sys.exit(main())
