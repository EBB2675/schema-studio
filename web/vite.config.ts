import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  // A GitHub Pages project site lives under /<repository>/ (see .env.pages); everything else under /.
  base: loadEnv(mode, process.cwd(), '').VITE_BASE_PATH || '/',
  plugins: [react()],
  // The static site's worker loads Pyodide with a dynamic import, which needs an ES module worker.
  worker: { format: 'es' },
  server: {
    // The static site bundles the Python core from ../api/sources.
    fs: { allow: ['..'] },
  },
  test: {
    environment: 'happy-dom',
    setupFiles: './tests/setup.ts',
  },
}))
