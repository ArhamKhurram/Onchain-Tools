---
title: 'ADR-007: Storage behind one interface'
description: All user-scoped persistence goes through StorageProvider; hosted-only tables deliberately bypass it.
sidebar:
  order: 7
  label: '007 — Storage interface'
---

**Status:** Accepted

## Context

Two storage backends must coexist ([ADR-001](../001-two-modes/)): JSON files
for the single-user desktop app, Supabase with RLS for the multi-tenant
service. Feature code that knows which backend it is on multiplies the
two-mode branching across the codebase.

## Decision

`storage/interface.ts` defines `StorageProvider` — every method takes
`userId` first — implemented by `JsonStorageProvider` (delegates to the
config-store and contract-log singletons, ignores `userId`) and
`SupabaseStorageProvider` (six repos around a shared service client).
`getStorageProvider()` memoizes the choice. New user-scoped persistence goes
through this interface.

Hosted-only, service-role-only tables (FOMO, token catalog, wallets,
missed-runner) deliberately **bypass** the interface with their
own service clients — a local implementation would be dead code. `token_peaks`
is the one exception with a JSON mirror, so the desktop app can score callers.

## Consequences

- Feature code is mode-blind; the two-mode branch lives in one factory.
- The interface stays honest: if a method wouldn't make sense in both modes,
  it doesn't belong on it.
- The bypass list must stay deliberate — check both this ADR and the
  [storage docs](../../data/storage/) before adding a table.
