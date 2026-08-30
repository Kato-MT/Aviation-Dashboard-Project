# R3 selected-implementation evidence context

This is the local evidence context for the two R3 options Kato approved on 2026-08-29: Operational Evidence Option 1 (`regional-operations-contract`) and Runtime Policy Option 2 (`central-runtime-policy-contract`). It is not a release receipt, provider approval, deployment record, or claim about hosted behavior.

## Current machine-verifiable record

`hardening/r3/selected-evidence.manifest.json` is the authoritative current inventory. It is generated and checked by:

```text
pnpm r3:evidence:refresh
pnpm r3:evidence:check
pnpm requirements:check
```

The verifier pins the selected contract independently of the Markdown and JSON requirements sources. It requires exactly `FDW-OPS-001..008`, `FDW-POL-001..008`, `TC-OPS-001..008`, and `TC-POL-001..008`; the exact evidence paths declared by every selected test; the exact two selected option IDs; and only normalized, repository-contained regular files for selected R3 evidence. Removing an ID from the requirements, test cases, and traceability matrix at the same time therefore still fails.

The manifest records the current base HEAD, dirty state, non-ignored source-content identity, per-file byte count and SHA-256, and the collection SHA-256. The generated manifest excludes only itself from the source-content identity to avoid a self-referential digest. Any other material non-ignored source change makes the checked record stale until it is deliberately refreshed.

## Included scope

- The approved regional operations contract and central runtime-policy contract.
- The selected hardening record and both selected proposal documents.
- The exact selected requirement, test-case, and traceability sources.
- Every regular implementation, schema, test, runbook, workflow, and configuration file linked by the 16 selected test cases.
- Current non-ignored Git source content, including dirty tracked bytes and untracked source files.

## Excluded claims and evidence

- Ignored build output, dependency caches, test output, local temporary files, and credentials.
- Cloudflare account configuration, routes, billing, platform observability, WAF, deployment, and hosted availability.
- Provider terms, provider contact, permission for real-aircraft access, and real-source captures.
- Commit, push, hosted CI, retained-candidate, G0, G1, G2, G3, release, deployment, and publication proof.

## Authority boundary

The selection authorizes local R3 implementation only. It does not authorize commit, push, provider contact, Cloudflare mutation, billing, deployment, or publication. The repository remains a dirty working tree on base HEAD `80c1e47b1d3662163f297b67e8a3c86477159231`; the manifest, rather than HEAD alone, identifies the reviewed source bytes.

## Historical review basis

The earlier 26-file context digest described the pre-implementation design review and is historical. It must not be used as current implementation evidence. The proposal evidence labels remain useful for design rationale, while the selected manifest now owns current source and traceability identity.
