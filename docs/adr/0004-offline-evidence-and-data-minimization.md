# ADR 0004: Offline evidence and data minimization

- Status: Accepted
- Date: 2026-07-17

## Context

The application processes user-selected files and may run in environments without network access. Evidence exports need enough provenance for reproduction without copying the entire source dataset by default.

## Decision

Bundle runtime code, dependencies, and fonts locally. Produce a self-contained offline HTML artifact from the same commit as the Pages build. Export hashes, counts, versions, validation, and findings by default. Include source records only after a separate explicit user choice.

## Consequences

- Normal analysis does not require a runtime CDN.
- Release artifacts can be verified with SHA-256 checksums.
- Evidence reports are smaller and expose less user-selected data.
- Source-inclusive exports need a clear warning and separate test coverage.
