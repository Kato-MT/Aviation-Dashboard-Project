import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-600.css';
import './features/live/live.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceRouter } from './features/workbench/WorkspaceRouter';

const root = createRoot(document.getElementById('live-root')!);
root.render(
  <StrictMode>
    <WorkspaceRouter buildIdentity={__EVIDENCE_BUILD_IDENTITY__} />
  </StrictMode>,
);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
