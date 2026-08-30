import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import type { EvidenceBuildIdentity } from '../../evidence/types';
import { LabSessionOwner } from '../lab/owner';
import { labSubviewFromHash, labSubviewMetadata, type LabSubview } from '../lab/routes';
import { WorkbenchHeader, type WorkbenchWorkspace } from '../workbench/WorkbenchHeader';
import { OfflineLiveUnavailable } from './OfflineLiveUnavailable';

const LabApp = lazy(() => import('../lab/LabApp').then((module) => ({ default: module.LabApp })));
const ReplayApp = lazy(() =>
  import('../replay/ReplayApp').then((module) => ({ default: module.ReplayApp })),
);
const EvidenceApp = lazy(() =>
  import('../evidence/EvidenceApp').then((module) => ({ default: module.EvidenceApp })),
);

export type OfflineWorkspace = WorkbenchWorkspace;

export interface OfflineWorkspaceRoute {
  workspace: OfflineWorkspace;
  labSubview: LabSubview;
}

export function offlineWorkspaceFromHash(hash: string): OfflineWorkspace {
  if (hash === '#replay' || hash.startsWith('#replay-')) return 'replay';
  if (hash === '#evidence' || hash.startsWith('#evidence-') || hash === '#source-evidence') {
    return 'evidence';
  }
  return hash === '#lab' || hash.startsWith('#lab-') ? 'lab' : 'live';
}

export function offlineWorkspaceRouteFromHash(
  hash: string,
  previousLabSubview: LabSubview = 'monitor',
): OfflineWorkspaceRoute {
  return {
    workspace: offlineWorkspaceFromHash(hash),
    labSubview: labSubviewFromHash(hash) ?? previousLabSubview,
  };
}

const metadata: Record<
  OfflineWorkspace,
  { label: string; mainId: string; loading: string; documentTitle: string }
> = {
  live: {
    label: 'Live Airspace',
    mainId: 'airspace-main',
    loading: 'Opening offline boundary',
    documentTitle: 'Live Airspace unavailable | Flight Diagnostics Workbench',
  },
  replay: {
    label: 'Synthetic Replay',
    mainId: 'replay-main',
    loading: 'Opening Synthetic Replay',
    documentTitle: 'Synthetic Replay | Flight Diagnostics Workbench',
  },
  lab: {
    label: 'Diagnostics Lab',
    mainId: 'lab-main',
    loading: 'Opening Diagnostics Lab',
    documentTitle: 'Diagnostics Lab | Flight Diagnostics Workbench',
  },
  evidence: {
    label: 'Evidence',
    mainId: 'evidence-main',
    loading: 'Opening Evidence',
    documentTitle: 'Evidence | Flight Diagnostics Workbench',
  },
};

class OfflineWorkspaceErrorBoundary extends Component<
  { children: ReactNode; workspace: OfflineWorkspace; resetKey: string },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidUpdate(previous: Readonly<{ resetKey: string }>) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  override render() {
    const current = metadata[this.props.workspace];
    return this.state.failed ? (
      <main id={current.mainId} className="startup-state" tabIndex={-1}>
        <h1>Offline workspace unavailable</h1>
        <p role="alert">
          {current.label} was stopped after a render failure. No fallback network capability was
          started. Choose another bundled workspace or reload this file to retry.
        </p>
        <div className="workspace-recovery-links">
          <a href="#live">Offline boundary</a>
          <a href="#replay">Synthetic Replay</a>
          <a href="#lab">Diagnostics Lab</a>
          <a href="#evidence">Evidence</a>
        </div>
      </main>
    ) : (
      this.props.children
    );
  }
}

export function OfflineWorkspaceRouter({
  buildIdentity,
}: {
  buildIdentity: Readonly<EvidenceBuildIdentity>;
}) {
  const [route, setRoute] = useState<OfflineWorkspaceRoute>(() =>
    offlineWorkspaceRouteFromHash(location.hash),
  );
  const [labOwner] = useState(() => new LabSessionOwner());
  const workspace = route.workspace;

  useEffect(() => {
    const stop = () => labOwner.stop();
    window.addEventListener('pagehide', stop);
    return () => {
      window.removeEventListener('pagehide', stop);
      stop();
    };
  }, [labOwner]);

  useEffect(() => {
    const change = () => {
      setRoute((current) => {
        const next = offlineWorkspaceRouteFromHash(location.hash, current.labSubview);
        return next.workspace === current.workspace && next.labSubview === current.labSubview
          ? current
          : next;
      });
    };
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);

  useEffect(() => {
    document.title =
      workspace === 'lab'
        ? labSubviewMetadata[route.labSubview].documentTitle
        : metadata[workspace].documentTitle;
  }, [route.labSubview, workspace]);

  const content =
    workspace === 'live' ? (
      <OfflineLiveUnavailable />
    ) : workspace === 'replay' ? (
      <ReplayApp />
    ) : workspace === 'lab' ? (
      <LabApp
        owner={labOwner}
        subview={route.labSubview}
        buildIdentity={buildIdentity}
        legacyOracleHref={null}
      />
    ) : (
      <EvidenceApp buildIdentity={buildIdentity} staticOnly />
    );

  return (
    <>
      <WorkbenchHeader workspace={workspace} runtime="offline" />
      <OfflineWorkspaceErrorBoundary
        key={workspace}
        workspace={workspace}
        resetKey={workspace === 'lab' ? route.labSubview : workspace}
      >
        {workspace === 'live' ? (
          content
        ) : (
          <Suspense
            fallback={
              <main
                id={metadata[workspace].mainId}
                className="startup-state"
                role="status"
                tabIndex={-1}
              >
                <h1>{metadata[workspace].loading}</h1>
                <p>Loading bundled code only. No network request is permitted.</p>
              </main>
            }
          >
            {content}
          </Suspense>
        )}
      </OfflineWorkspaceErrorBoundary>
    </>
  );
}
