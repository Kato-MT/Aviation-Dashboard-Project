# ADR 0001: Strict TypeScript modules with Vite

- Status: Accepted
- Date: 2026-07-17

## Context

The original application is a browser-global JavaScript file loaded directly from a static page. That structure makes parsing, rule evaluation, UI state, and exports difficult to test independently. The existing visual identity and replay interaction are worth preserving.

## Decision

Use strict TypeScript modules and Vite. Keep direct DOM rendering and the existing CSS design language. Do not introduce a component framework solely for modernization. Bundle all runtime dependencies and fonts locally.

## Consequences

- Core logic can run in Node tests without a browser.
- Browser globals and implicit coercion become compile-time or review-visible problems.
- The project retains a small runtime and familiar HTML/CSS structure.
- Vite produces both the normal static build and an offline single-file artifact.
- Build tooling becomes a required development dependency, pinned by the lockfile.
