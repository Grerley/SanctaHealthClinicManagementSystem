import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Built assets are served from the edge hub root and from Workers Static Assets.
export default defineConfig({
  plugins: [react()],
  base: '/',
  build: { outDir: 'dist', emptyOutDir: true },
});
