import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { LiveAirspaceApp } from '../live/LiveAirspaceApp';
import { LabSessionOwner } from '../lab/owner';
import { labSubviewFromHash, labSubviewMetadata, type LabSubview } from '../lab/routes';
import { WorkbenchHeader, type WorkbenchWorkspace } from './WorkbenchHeader';
import type { EvidenceBuildIdentity } from '../../evidence/types';

const LabApp = lazy(() => import('../lab/LabApp').then((module) => ({ default: module.LabApp })));
const ReplayApp = lazy(() =>
  import('../replay/ReplayApp').then((module) => ({ default: module.ReplayApp })),
);
const EvidenceApp = lazy(() =>
  import('../evidence/OnlineEvidenceApp').then((module) => ({
    default: module.OnlineEvidenceApp,
  })),
);

export type Workspace = WorkbenchWorkspace;
export interface WorkspaceRoute {
  workspace: Workspace;
  labSubview: LabSubview;
}

export function workspaceFromHash(hash: string): Workspace {
  if (hash === '#replay' || hash.startsWith('#replay-')) return 'replay';
  if (hash === '#evidence' || hash.startsWith('#evidence-') || hash === '#source-evidence') {
    return 'evidence';
  }
  return hash === '#lab' || hash.startsWith('#lab-') ? 'lab' : 'live';
}

export function workspaceRouteFromHash(
  hash: string,
  previousLabSubview: LabSubview = 'monitor',
): WorkspaceRoute {
  return {
    workspace: workspaceFromHash(hash),
    labSubview: labSubviewFromHash(hash) ?? previousLabSubview,
  };
}

const metadata: Record<Workspace, { label: string; mainId: string; loading: string }> = {
  live: { label: 'Live Airspace', mainId: 'airspace-main', loading: 'Loading Live Airspace' },
  replay: {
    label: 'Synthetic Replay',
    mainId: 'replay-main',
    loading: 'Loading Synthetic Replay',
  },
  lab: { label: 'Diagnostics Lab', mainId: 'lab-main', loading: 'Loading Diagnostics Lab' },
  evidence: { label: 'Evidence', mainId: 'evidence-main', loading: 'Loading Evidence' },
};

class WorkspaceErrorBoundary extends Component<
  { children: ReactNode; workspace: Workspace; resetKey: string },
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
        <h1>Workspace unavailable</h1>
        <p role="alert">
          {current.label} was stopped after a render failure. Choose another workspace or reload to
          retry.
        </p>
        <div className="workspace-recovery-links">
          <a href="#live">Live Airspace</a>
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

export function WorkspaceRouter({
  buildIdentity,
}: {
  buildIdentity: Readonly<EvidenceBuildIdentity>;
}) {
  const [route, setRoute] = useState<WorkspaceRoute>(() => workspaceRouteFromHash(location.hash));
  const workspace = route.workspace;
  const [labOwner] = useState(() => new LabSessionOwner());
  useEffect(() => () => labOwner.stop(), [labOwner]);
  useEffect(() => {
    const change = () => {
      setRoute((current) => {
        const next = workspaceRouteFromHash(location.hash, current.labSubview);
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
        : `${metadata[workspace].label} | Flight Diagnostics Workbench`;
  }, [route.labSubview, workspace]);
  const content =
    workspace === 'live' ? (
      <LiveAirspaceApp />
    ) : workspace === 'replay' ? (
      <ReplayApp />
    ) : workspace === 'lab' ? (
      <LabApp owner={labOwner} subview={route.labSubview} buildIdentity={buildIdentity} />
    ) : (
      <EvidenceApp buildIdentity={buildIdentity} />
    );
  return (
    <>
      <WorkbenchHeader workspace={workspace} />
      <WorkspaceErrorBoundary
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
                <p>Prior workspace activity has been stopped.</p>
              </main>
            }
          >
            {content}
          </Suspense>
        )}
      </WorkspaceErrorBoundary>
    </>
  );
}
