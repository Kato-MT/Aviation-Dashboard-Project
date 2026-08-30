export type WorkbenchWorkspace = 'live' | 'replay' | 'lab' | 'evidence';
export type WorkbenchRuntime = 'online' | 'offline';

const workspaceMetadata: Record<
  WorkbenchWorkspace,
  { label: string; shortLabel: string; href: string; mainId: string }
> = {
  live: {
    label: 'Live Airspace',
    shortLabel: 'airspace',
    href: '#live',
    mainId: 'airspace-main',
  },
  replay: {
    label: 'Synthetic Replay',
    shortLabel: 'Replay',
    href: '#replay',
    mainId: 'replay-main',
  },
  lab: {
    label: 'Diagnostics Lab',
    shortLabel: 'Lab',
    href: '#lab',
    mainId: 'lab-main',
  },
  evidence: {
    label: 'Evidence',
    shortLabel: 'Evidence',
    href: '#evidence',
    mainId: 'evidence-main',
  },
};

export interface WorkbenchHeaderProps {
  workspace: WorkbenchWorkspace;
  runtime?: WorkbenchRuntime;
}

export function WorkbenchHeader({ workspace, runtime = 'online' }: WorkbenchHeaderProps) {
  const current = workspaceMetadata[workspace];
  return (
    <>
      <a className="skip-link" href={`#${current.mainId}`}>
        Skip to {current.shortLabel} workspace
      </a>
      <header className="live-app-header">
        <a className="workbench-brand" href="#live">
          <span aria-hidden="true" className="brand-lettermark">
            FDW
          </span>
          <span>
            Flight Diagnostics
            <br />
            <strong>Workbench</strong>
          </span>
        </a>
        <nav className="workbench-nav" aria-label="Workbench navigation">
          {(Object.keys(workspaceMetadata) as WorkbenchWorkspace[]).map((key) => {
            const entry = workspaceMetadata[key];
            return (
              <a key={key} href={entry.href} aria-current={workspace === key ? 'page' : undefined}>
                {entry.label}
              </a>
            );
          })}
        </nav>
        <span className="development-label">
          {runtime === 'offline' ? 'Self-contained offline package' : 'Development preview'}
        </span>
      </header>
    </>
  );
}
