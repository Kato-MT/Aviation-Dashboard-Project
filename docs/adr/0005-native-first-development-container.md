# ADR 0005: Native-first development container

- Status: Accepted and implemented after native stability
- Date: 2026-07-17

## Context

The primary development environment is native Windows. A container can improve reproducibility, but adding it before native setup and continuous integration are stable can hide platform-specific defects and create two moving baselines.

## Decision

Keep native Windows commands and CI as the authoritative setup. The optional development container was added after the native install and validation workflow stabilized. Its official JavaScript and Node.js 22 Bookworm image is pinned to digest `sha256:0d29e5fdc64f8397cd502223e0c4679f1e60877ca0fd2db4f2e2e0028e4271af`; the official Python feature is fixed at version 1.8.0 with its resolved digest recorded in the Dev Container lockfile, and the feature installs Python 3.12. Its post-create command installs pnpm 11.9.0 and uses the frozen pnpm lockfile. The required `development-container` CI job builds that configuration without pushing an image and runs validation plus the normal and offline builds inside it. The container may not become the sole supported workflow.

## Consequences

- Initial debugging stays focused on the environment used to develop the project.
- The optional container is a reproducibility aid, not a replacement for native verification.
- `.devcontainer/devcontainer.json` is a reproducibility aid whose build feeds the aggregate `CI required` check.
- The dedicated browser-assurance job remains authoritative for Chromium, offline, responsive, and accessibility behavior.
