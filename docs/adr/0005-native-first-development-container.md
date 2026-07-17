# ADR 0005: Native-first development container

- Status: Accepted, implementation deferred to v2.1 gate
- Date: 2026-07-17

## Context

The primary development environment is native Windows. A container can improve reproducibility, but adding it before native setup and continuous integration are stable can hide platform-specific defects and create two moving baselines.

## Decision

Keep native Windows commands and CI as the authoritative setup. Add an optional development container only after the native install, validation, normal build, offline build, and browser checks pass. The container must use the same lockfile and commands and may not become the sole supported workflow.

## Consequences

- Initial debugging stays focused on the environment used to develop the project.
- The v2.1 container is a reproducibility aid, not a replacement for native verification.
- `.devcontainer/README.md` records the gate until an actual container configuration is justified by successful native evidence.
