import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The node serves the built app from dist/web (see src/api/statusPages.ts).
// In dev, JSON data routes are proxied to a locally running node so frontend
// work never requires rebuilding the node itself.
const apiTarget = process.env.VITE_API_TARGET ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '^/(node|nodes)(/[^/]+)?\\.json$': { target: apiTarget, changeOrigin: true },
      '/health': { target: apiTarget, changeOrigin: true },
    },
  },
});
