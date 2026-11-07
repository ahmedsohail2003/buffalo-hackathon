import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// Track B dev pages (?livesmoke=1 browser Live smoke, ?coworker=1 CoworkerPane on a StubCell) replace the app.
const devQ = new URLSearchParams(location.search);
if (devQ.get('livesmoke') === '1' || devQ.get('coworker') === '1') import('./dev/devMount').then((m) => m.mount(document.getElementById('root')!, devQ));
else createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
