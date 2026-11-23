# Static frontend

React + TypeScript + Vite with React Flow as the sole graph canvas. All app requests are handled locally by `src/static/backend.ts`; the Python engine runs in a Pyodide worker.

See the [project README](../README.md) for snapshot preparation, local development, tests, and GitHub Pages deployment. Both `npm run dev` and production builds use the static application. `npm run build:pages` uses the base path in `.env.pages` and copies browser Python assets into `dist/pyodide`.
