# Release screenshots

Capture screenshots only from the exact verified release commit after the production build succeeds.

The currently checked-in PNG files and `metadata.json` are local v2.2 candidate captures from the implementation working tree. They demonstrate the minimalist interface but are not exact-tag release evidence. The release workflow must regenerate and verify the complete set from the protected release commit before publication.

Required release files:

- `workbench-desktop.png`: desktop Monitor viewport showing the loaded included synthetic baseline and visible product version.
- `workbench-diagnostics.png`: desktop Diagnostics viewport showing filterable evidence-backed findings.
- `workbench-configuration.png`: desktop Configuration viewport showing provenance, the distinct v1 research and v2 integrated-advisory evidence roles, exact identity prefixes, user-disabled default state, and current requirement eligibility without implying release activation.
- `workbench-investigation.png`: desktop Investigation viewport showing a seeded synthetic temporal scenario, linked phase and residual evidence, and deterministic authority.
- `workbench-mobile.png`: narrow mobile viewport showing usable navigation, status text, and one primary view without clipped controls.

Before capture:

1. Confirm the displayed application version and input SHA-256 belong to the release commit.
2. Use only bundled synthetic, unclassified data.
3. Remove browser extensions, local paths, notifications, and personal information from the frame.
4. Verify visible focus and all named loading, empty, nominal, warning, and failure states separately, even if only the representative nominal images are released.
5. Record browser version and viewport in `docs/release-verification.md`.
6. If a temporal similarity score is visible, label it as a normalized ranking score rather than a calibrated probability.

Do not place placeholder images at these filenames. Release verification treats their presence as evidence and must fail while capture is pending.
