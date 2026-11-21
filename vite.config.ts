import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  // `vite preview` proxies /api/* to the FastAPI backend so the built
  // frontend talks to the real API on the same origin. Target comes from
  // VITE_API_PROXY (docker compose sets http://api:8000); locally it
  // defaults to http://localhost:8000. If no backend is running, the
  // frontend falls back to its local deterministic engine and says so.
  // (Read via globalThis: this config is typechecked by the frontend
  // tsconfig, which has no Node types.)
  preview: {
    port: 4173,
    proxy: { '/api': (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env?.VITE_API_PROXY ?? 'http://localhost:8000' },
  },
  build: { outDir: 'dist', sourcemap: false },
});
