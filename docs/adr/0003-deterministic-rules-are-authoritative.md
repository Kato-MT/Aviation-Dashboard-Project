# ADR 0003: Deterministic rules are authoritative

- Status: Accepted
- Date: 2026-07-17

## Context

An experimental learned baseline can surface multichannel patterns, but its output depends on generated training data, preprocessing, and an evaluated artifact. A reproducible workbench needs findings that can be explained directly from a declared profile and sample evidence.

## Decision

Profile-driven deterministic rules are authoritative. The learned model is optional, versioned, disabled by default unless its held-out gates pass, and shown only as a side-by-side comparison. Model output cannot suppress, downgrade, or rewrite deterministic findings.

## Consequences

- Every authoritative finding has a stable rule ID and explicit condition.
- Model limitations and evaluation metrics remain visible.
- Users can reproduce deterministic outcomes without Python or a model artifact.
- Conflicts between model and rule output are evidence to investigate, not a hidden arbitration decision.
