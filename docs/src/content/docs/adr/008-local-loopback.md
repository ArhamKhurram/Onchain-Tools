---
title: 'ADR-008: Local mode binds loopback'
description: The unauthenticated local API listens on 127.0.0.1 only.
sidebar:
  order: 8
  label: '008 — Local loopback'
---

**Status:** Accepted

## Context

Local mode has no authentication (every request is user `local`) and its API
serves Discord tokens and Telegram session strings in plaintext. Early
versions listened on every interface, which exposed those credentials to the
local network.

## Decision

Local mode binds `127.0.0.1`. Hosted mode binds `0.0.0.0` (Railway needs
it). `OCT_HOST` / `TRENCHCORD_HOST` overrides both for the rare deliberate
case.

## Consequences

- A LAN device cannot reach a local OCT instance without an explicit
  override; anyone setting `OCT_HOST=0.0.0.0` in local mode is opting into
  exposing credentials and should add auth first.
- The Electron desktop app works unchanged (it talks to loopback).
- **Do not widen the local bind without adding authentication** — this is the
  single most important line not to cross in local mode.
