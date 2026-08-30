import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-600.css';
import './features/live/live.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { OfflineWorkspaceRouter } from './features/offline/OfflineWorkspaceRouter';

const container = document.getElementById('offline-root');
if (!container) throw new Error('The offline workbench root is missing.');

const root = createRoot(container);
root.render(
  <StrictMode>
    <OfflineWorkspaceRouter buildIdentity={__EVIDENCE_BUILD_IDENTITY__} />
  </StrictMode>,
);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
