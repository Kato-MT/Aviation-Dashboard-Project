import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-600.css';
import '../styles.css';
import { WorkbenchController } from './ui/workbench';

const controller = new WorkbenchController();

void controller.initialize().catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : 'Unknown startup failure.';
  const fallback = document.createElement('div');
  fallback.setAttribute('role', 'alert');
  fallback.style.padding = '1rem';
  fallback.style.background = '#5b1020';
  fallback.style.color = '#fff';
  fallback.textContent = `The workbench could not start: ${detail}`;
  document.body.prepend(fallback);
});
