import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Forward /api/* to the Flask backend so the browser sees a same-origin request.
      '/api': 'http://localhost:5000',
    },
  },
});
