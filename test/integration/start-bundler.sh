#!/bin/sh
set -e

until wget -q -O - --post-data='{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' --header='Content-Type: application/json' http://anvil:8545 2>/dev/null | grep -q "result"; do sleep 2; done

ENTRYPOINT_CODE=$(wget -q -O - --post-data='{"jsonrpc":"2.0","method":"eth_getCode","params":["0x0000000071727De22E5E9d8BAf0edAc6f37da032","latest"],"id":1}' --header='Content-Type: application/json' http://anvil:8545 2>/dev/null | grep -o '"result":"[^"]*"' | cut -d'"' -f4)

if [ "$ENTRYPOINT_CODE" = "0x" ] || [ -z "$ENTRYPOINT_CODE" ]; then
  echo "EntryPoint not deployed"
  exit 1
fi

exec pnpm start \
  --network-name=local \
  --log-environment=production \
  --enable-debug-endpoints=true \
  --entrypoints=0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789,0x0000000071727De22E5E9d8BAf0edAc6f37da032 \
  --balance-override-enabled=true \
  --api-version=v1,v2 \
  --min-balance=0 \
  --rpc-url=http://anvil:8545 \
  --utility-private-key=0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97 \
  --executor-private-keys=0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6,0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356 \
  --max-block-range=10000 \
  --safe-mode=false \
  --log-level=info \
  --polling-interval=100 \
  --mempool-max-parallel-ops=10 \
  --mempool-max-queued-ops=10 \
  --port=4337 \
  --bundling-mode=auto
