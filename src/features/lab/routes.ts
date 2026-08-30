export type LabSubview =
  'monitor' | 'diagnostics' | 'verification' | 'investigation' | 'campaign' | 'configuration';

export const labSubviewMetadata: Record<
  LabSubview,
  {
    label: string;
    hash: `#lab-${string}`;
    panelId: string;
    tabId: string;
    documentTitle: string;
  }
> = {
  monitor: {
    label: 'Monitor',
    hash: '#lab-monitor',
    panelId: 'lab-monitor',
    tabId: 'lab-monitor-tab',
    documentTitle: 'Diagnostics Lab | Flight Diagnostics Workbench',
  },
  diagnostics: {
    label: 'Diagnostics',
    hash: '#lab-diagnostics',
    panelId: 'lab-diagnostics',
    tabId: 'lab-diagnostics-tab',
    documentTitle: 'Diagnostics | Diagnostics Lab | Flight Diagnostics Workbench',
  },
  verification: {
    label: 'Verification',
    hash: '#lab-verification',
    panelId: 'lab-verification',
    tabId: 'lab-verification-tab',
    documentTitle: 'Verification | Diagnostics Lab | Flight Diagnostics Workbench',
  },
  investigation: {
    label: 'Investigation',
    hash: '#lab-investigation',
    panelId: 'lab-investigation',
    tabId: 'lab-investigation-tab',
    documentTitle: 'Investigation | Diagnostics Lab | Flight Diagnostics Workbench',
  },
  campaign: {
    label: 'Campaign',
    hash: '#lab-campaign',
    panelId: 'lab-campaign',
    tabId: 'lab-campaign-tab',
    documentTitle: 'Campaign | Diagnostics Lab | Flight Diagnostics Workbench',
  },
  configuration: {
    label: 'Configuration',
    hash: '#lab-configuration',
    panelId: 'lab-configuration',
    tabId: 'lab-configuration-tab',
    documentTitle: 'Configuration | Diagnostics Lab | Flight Diagnostics Workbench',
  },
};

/** Returns only canonical Lab view routes. Accessibility anchors preserve the active view. */
export function labSubviewFromHash(hash: string): LabSubview | undefined {
  if (hash === '#lab' || hash === '#lab-monitor') return 'monitor';
  if (hash === '#lab-diagnostics') return 'diagnostics';
  if (hash === '#lab-verification') return 'verification';
  if (hash === '#lab-investigation') return 'investigation';
  if (hash === '#lab-campaign') return 'campaign';
  if (hash === '#lab-configuration') return 'configuration';
  return undefined;
}
