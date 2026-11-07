import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import App from './App';
import { bootRuntime } from './app/runtime';
import { BootScreen } from './ui/BootScreen';

// Boot order: load the arm and build the bay core, then the layers' install modules (they may use
// getBay() at import time), then the UI.
const root = createRoot(document.getElementById('root')!);
root.render(<BootScreen />);
bootRuntime()
  .then(() => import('./plugins'))
  .then(() =>
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    ),
  )
  .catch((err: unknown) => {
    console.error('[boot]', err);
    root.render(<BootScreen error={err instanceof Error ? err.message : String(err)} />);
  });
