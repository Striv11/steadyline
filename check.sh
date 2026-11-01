#!/usr/bin/env bash
# Single quality gate used by CI and by build-lab before every push:
# format check, lint, typecheck, unit tests, production build.
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -d node_modules ]; then npm ci; fi
npx prettier --check .
npx eslint .
npx tsc --noEmit
npx vitest run
npx vite build
