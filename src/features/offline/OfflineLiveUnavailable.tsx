export function OfflineLiveUnavailable() {
  return (
    <main id="airspace-main" className="offline-live-unavailable" tabIndex={-1}>
      <div className="source-banner" role="note">
        <strong>Self-contained offline package</strong>
        <span>
          No provider, regional service, map asset, or aggregate health request is available.
        </span>
      </div>
      <section className="workspace-heading" aria-labelledby="offline-live-title">
        <div>
          <p className="section-label">Runtime boundary</p>
          <h1 id="offline-live-title">Live Airspace is unavailable offline</h1>
          <p>
            Live observations require the separately deployed regional service and a network
            connection. This file deliberately contains no capability to open that feed.
          </p>
        </div>
        <span className="development-label">No live connection attempted</span>
      </section>
      <section className="startup-state" aria-labelledby="offline-capabilities-title">
        <h2 id="offline-capabilities-title">Offline engineering workflows remain available</h2>
        <p>
          Use deterministic synthetic Replay, all six Diagnostics Lab workflows, or the bundled
          Evidence ledger. Those routes run entirely inside this browser session.
        </p>
        <div className="workspace-recovery-links">
          <a href="#replay">Open Synthetic Replay</a>
          <a href="#lab">Open Diagnostics Lab</a>
          <a href="#evidence">Open Evidence</a>
        </div>
      </section>
    </main>
  );
}
