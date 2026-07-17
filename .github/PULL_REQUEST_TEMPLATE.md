## Summary

Describe the outcome and the smallest coherent change that produced it.

## Scope

- Requirement IDs:
- Issue:
- Release target:

## Verification

- [ ] `pnpm validate`
- [ ] `pnpm test:coverage`
- [ ] `pnpm build`
- [ ] `pnpm build:offline`
- [ ] `pnpm test:e2e`, when browser behavior changes
- [ ] `pnpm requirements:check`
- [ ] Failure paths and boundary values tested

Paste command results or link the exact CI run. Do not mark a result complete unless it was observed.

## User-visible evidence

Describe loading, empty, nominal, warning, and failure behavior affected by this change. Include desktop and mobile screenshots for a visual change.

## Security and data boundary

- [ ] All new fixtures, profiles, thresholds, streams, and scenarios are synthetic and unclassified.
- [ ] No organization affiliation, operational, real-platform, maintenance, safety, or certification claim was added.
- [ ] Untrusted values remain text and normal exports exclude source data.
- [ ] No secret, user upload, local database, cache, or generated dependency directory is included.

## Documentation and compatibility

- [ ] Requirements and traceability updated
- [ ] Changelog and affected docs updated
- [ ] Included 85-record and 5/3/1 regression remains verified, or a reviewed breaking change is explained
- [ ] Any deferred or unverified result is labeled pending
