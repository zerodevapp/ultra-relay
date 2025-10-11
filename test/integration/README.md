# Ultra-Relay Integration Tests

Tests ZeroDev SDK → ultra-relay-provider → ultra-relay → Anvil

## Architecture

```
ZeroDev SDK → Provider (3333) → ultra-relay (4337) → Anvil (8545)
```

**Design**: ultra-relay stays standard, provider handles ZeroDev transformations

## Run Test

```bash
cd test/integration
pnpm run docker:test
```

## Services

- `anvil:8545` - Local Ethereum chain
- `postgres:5432` - Provider database
- `redis:6379` - Provider cache
- `ultra-relay:4337` - Standard ERC-4337 bundler
- `ultra-relay-provider:3333` - ZeroDev middleware

## Manual

```bash
docker-compose up -d
./setup-contracts.sh
pnpm test
docker-compose down -v
```
