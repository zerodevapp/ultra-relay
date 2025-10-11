#!/bin/bash
set -e

docker-compose down -v 2>/dev/null || true
docker-compose up -d anvil postgres redis
sleep 10

./setup-contracts.sh

docker-compose up -d ultra-relay
sleep 10

docker-compose up -d ultra-relay-provider
sleep 15

pnpm test

docker-compose down -v
