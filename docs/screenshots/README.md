# Release screenshots

Capture screenshots only from the exact verified release commit after the production build succeeds.

Required release files:

- `workbench-desktop.png`: desktop viewport showing the loaded included synthetic baseline and visible product version.
- `workbench-mobile.png`: narrow mobile viewport showing usable navigation, status text, and one primary view without clipped controls.

Before capture:

1. Confirm the displayed application version and input SHA-256 belong to the release commit.
2. Use only bundled synthetic, unclassified data.
3. Remove browser extensions, local paths, notifications, and personal information from the frame.
4. Verify visible focus and all named loading, empty, nominal, warning, and failure states separately, even if only the representative nominal images are released.
5. Record browser version and viewport in `docs/release-verification.md`.

Do not place placeholder images at these filenames. Release verification treats their presence as evidence and must fail while capture is pending.
