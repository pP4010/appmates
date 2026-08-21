#!/usr/bin/env bash
# Deploy the Pages site. Must run `wrangler pages deploy` from inside web/ —
# running it from the repo root with `web` as the project arg silently skips
# web/functions/ (the private-preview gate), which has bitten this project
# before. This script is the only supported deploy path so that mistake
# can't happen again.
set -euo pipefail
cd "$(dirname "$0")/../web"
wrangler pages deploy .
