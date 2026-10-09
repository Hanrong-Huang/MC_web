# Tests

Run every command from the repository root. Browser harnesses use the project
root as the Vite root and may start a local server.

- `logic/` contains lightweight Node tests. Bundle one with esbuild, then run
  the generated module from `artifacts/`.
- `e2e/` contains assertion-focused Playwright flows.
- `visual/` contains screenshot and manual-review harnesses.
- `performance/` contains profiling harnesses.
- `artifacts/` is ignored output for temporary bundles, screenshots and traces.

Examples:

```powershell
npx esbuild tests/logic/logic-test.ts --bundle --platform=node --format=esm --outfile=tests/artifacts/logic-test.mjs
node tests/artifacts/logic-test.mjs

$env:NO_SHOTS = '1'
node tests/e2e/fluid-shots.mjs
```

Use `SHOT_DIR=tests/artifacts` for browser harnesses that support screenshot
output selection. Keep generated files out of the repository.
