#!/bin/bash
# p247 — pi-247 CLI for terminal prompts
# Usage: p247 "your prompt here"
# Install: sudo ln -sf "$(dirname "$0")/p247.sh" /usr/local/bin/p247

SCRIPT="$(readlink -f "$0")"
DIR="$(cd "$(dirname "$SCRIPT")" && pwd)"
cd "$DIR" || exit 1
exec bun run packages/telegram-gateway/src/cli.ts "$@"
