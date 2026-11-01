import { defineConfig } from 'vite';
export default defineConfig({
  root: __dirname,
  base: '/',
  build: { outDir: '../public', emptyOutDir: true, target: 'es2022' },
  server: { proxy: { '/api': 'http://localhost:8787' } },
});
