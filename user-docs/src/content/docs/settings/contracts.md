---
title: Contract settings
description: Contract clicks, trading platforms, the convergence window, and address colors.
sidebar:
  order: 3
---

**Settings → Contracts** controls what happens with the contract addresses OCT
detects.

## Clicks & display

- **Contract Click Action** — **Copy**, **Copy + Open** (default), or **Open
  Only**.
- **Display Full Contract Address** — show the whole address instead of the
  shortened `0x1234...abcd` form.
- **Auto-Open Highlighted Contracts** — automatically open a tab when a
  highlighted user posts a contract.

## Trading platform

Where "Open" sends a contract:

- **SOL Platform** — Axiom, Padre, Bloom, GMGN, or **Custom** (your own URL
  template, e.g. `https://example.com/token/{address}`).
- **EVM Platform** — GMGN, Bloom, or **Custom**.

## Signal convergence window

- **Signal Convergence Window** — minutes (1–240, default 30). A
  [convergence](../../fomo/convergence/) alert fires when a fed contract and a
  tracked FOMO buy of the same token land within this window.

## Address colors

- **EVM (0x…)** and **SOL** address colors, each with an alpha picker and a Reset
  — so the two chains are visually distinct in the feed.
