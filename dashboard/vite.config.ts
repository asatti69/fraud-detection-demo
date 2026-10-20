import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // Fixed port so start.sh and the presenter always know where the dashboard is.
  server: { port: 5173, strictPort: true },
  preview: { port: 5173, strictPort: true },
});
