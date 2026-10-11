import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig(({ command }) => ({
  root: 'src/renderer',
  base: './',
  plugins: [
    react(),
    {
      name: 'development-csp',
      transformIndexHtml: (html) =>
        command === 'serve'
          ? html
              .replace("script-src 'self';", "script-src 'self' 'unsafe-inline';")
              .replace("connect-src 'self'", "connect-src 'self' ws://127.0.0.1:*")
          : html,
    },
  ],
  build: { outDir: '../../dist/renderer', emptyOutDir: true },
  server: { host: '127.0.0.1' },
}));
