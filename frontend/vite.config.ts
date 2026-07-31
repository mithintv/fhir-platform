import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The dev server proxies `/api` to the backend process, so the app uses
 * same-origin relative URLs in development and in the built bundle alike.
 * Without the proxy the frontend would need an environment-specific base URL
 * and the backend would need permanent CORS — both only to support development.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: false,
      },
    },
  },
});
