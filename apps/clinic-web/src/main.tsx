import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@sancta/design-tokens/css';
import '@sancta/ui/src/ui.css';
import './base.css';
import { App } from './App.tsx';

// Register the service worker for the offline app shell (SYN-001).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js');
  });
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
