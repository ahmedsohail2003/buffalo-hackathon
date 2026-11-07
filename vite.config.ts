import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Dev: `npm run dev` (Vite) + `npm run server` (key-holding API server on :8787) side by side.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:8787' } },
  build: { chunkSizeWarningLimit: 2500 },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
