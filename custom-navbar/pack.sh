#!/usr/bin/env bash
# pack.sh — zip for extensions.gnome.org
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "${ROOT}"
make pack
