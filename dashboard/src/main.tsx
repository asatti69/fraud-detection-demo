import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';

// ?theme=light or ?theme=dark overrides the OS setting (handy on projectors and screen shares).
const theme = new URLSearchParams(window.location.search).get('theme');
if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
