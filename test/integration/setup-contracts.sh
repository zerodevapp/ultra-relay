#!/bin/bash
set -e

until curl -s http://localhost:8545 > /dev/null 2>&1; do sleep 1; done

ANVIL_RPC=http://localhost:8545 pnpm run deploy:entrypoints
ANVIL_RPC=http://localhost:8545 pnpm run copy:kernel
