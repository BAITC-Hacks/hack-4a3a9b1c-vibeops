import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    root: resolve('client'), plugins: [react()],
    build: { outDir: resolve('dist/client'), emptyOutDir: true },
    server: { port: 5173, strictPort: true, proxy: { '/api': `http://127.0.0.1:${process.env.PORT || env.PORT || '3000'}` } },
  };
});
