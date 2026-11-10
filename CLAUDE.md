# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Alto is a TypeScript implementation of the ERC-4337 bundler specification, designed for high transaction inclusion reliability. It supports multiple ERC-4337 versions (0.6, 0.7, and 0.8) and includes chain-specific optimizations.

## Key Commands

```bash
# Run a specific test
cd e2e && pnpm test -t "test name"
```

## Architecture Overview

### Key Design Patterns
- **Executor Strategies**: Supports different bundle submission strategies (conditional, flashbots). Stuck bundles are resubmitted with bumped gas (floored above the bor +10% replacement requirement), then rotated to a fresh executor wallet after `max-stuck-attempts-before-rotation` total attempts (cancelling the old transaction)

## Development Tips
1. The project uses pnpm workspaces - always use `pnpm` instead of `npm` or `yarn`
2. Smart contracts must be built before running the bundler
3. For debugging, enable verbose logging with `--verbose` flag
4. Use `--dangerous-skip-user-operation-validation` only for testing
5. The bundler requires an Ethereum node with `debug_traceCall` support

## Testing Approach
- E2E tests are in the `e2e/` directory using Vitest
- Test against local Anvil instances or testnets
- Mock mode available for development without real blockchain

## Common Tasks

### Adding a New Chain Handler
1. Create a new handler in `src/handlers/`
2. Implement the `GasPriceManager` interface
3. Register in the appropriate version's handler factory

### Adding a New RPC Endpoint
1. Add the schema for your new endpoint in `src/types/schemas.ts`:
   - Define the schema using Zod (e.g., `pimlicoNewEndpointSchema`)
   - Add it to both `bundlerRequestSchema` and `bundlerRpcSchema` unions
2. Create a new file in `src/rpc/methods/` following the naming convention (e.g., `pimlico_newEndpoint.ts`)
3. Implement the endpoint handler following the existing pattern using `createMethodHandler`
4. Import and register the handler in `src/rpc/methods/index.ts`
5. The endpoint will be automatically registered with the RPC server

### Modifying RPC Methods
1. Update the method in `src/rpc/methods/`
2. Ensure compatibility across all supported versions
3. Update validation logic if needed

## Code Style and Best Practices

### TypeScript Configuration
- **Type Safety**: Never use `any` type - use proper type definitions, `unknown`, or type assertions when needed

### Coding Conventions

#### Naming Conventions
- **Interfaces**: Prefixed with `Interface` (e.g., `InterfaceValidator`)
- **UserOperation Naming**: 
  - **Local variables and parameters**: Use `userOp` (e.g., `submittedUserOp`, `validUserOp`, `queuedUserOps`)
  - **Local method names**: Use `userOp` (e.g., `dropUserOps`, `addUserOp`, `getUserOpHash`)
  - **RPC endpoints**: Use full `userOperation` name (e.g., `eth_sendUserOperation`)
  - **Types and interfaces**: Use full `UserOperation` name (e.g., `UserOperationV07`, `PackedUserOperation`)
  - **Zod schemas**: Use full `userOperation` name (e.g., `userOperationSchema`, `userOperationV06Schema`)
  - **Solidity contracts**: Use full `UserOperation` name
  - **Inline comments**: Use full `userOperation` when referring to the concept

#### Import Organization
1. External dependencies
2. Internal type imports (`import type { ... } from "@alto/types"`)
3. Internal module imports (`import { ... } from "@alto/utils"`)
4. Relative imports

#### Function Patterns
```typescript
// Use object destructuring for multiple parameters
async function functionName({
    param1,
    param2
}: {
    param1: Type1
    param2: Type2
}): Promise<ReturnType> {
    // Implementation
}
```

#### Error Handling
- Use custom error classes (e.g., `RpcError`)
- Include specific error codes from enums
- Walk error chains for Viem errors
- Return error tuples for non-throwing operations

#### Logging
- Use structured logging with Pino
- Create child loggers with context
- Convert BigInts to hex strings in logs
- Include relevant data in log objects

### Validation Patterns
- Use Zod schemas for runtime validation
- Transform values in schemas (e.g., `transform((val) => val as Hex)`)
- Create branded types for type safety
- Validate at system boundaries (RPC, storage)

### Testing Guidelines
- Use Vitest with `describe.each` for version testing
- Follow Arrange-Act-Assert pattern
- Use `beforeEach` for test setup
- Test against real blockchain (Anvil) when possible

### Dependency Injection
- Constructor-based injection
- Pass configuration and dependencies as objects
- Use interfaces for testability

### RPC and HTTP Communication
- **Important**: When making RPC calls for methods that are not natively supported by viem, use the viem client's `request` method
- The viem `Client` type provides a `request` method for custom RPC calls: `client.request({ method: 'custom_method', params: [...] })`
- Only use this for non-standard RPC methods (e.g., `debug_traceCall`, custom bundler methods)
- For standard methods, use viem's built-in functions (e.g., `client.getBalance()` instead of `client.request({ method: 'eth_getBalance' })`)

### Module Structure
- Export public API through index files
- Keep version-specific logic in separate directories
- Use factory pattern for creating handlers

### Utility Functions
When working with BigInt calculations, use the utility functions from `@alto/utils`:
- **scaleBigIntByPercent**: Scale a BigInt by a percentage (e.g., `scaleBigIntByPercent(value, 150n)` for 150%)
- **minBigInt/maxBigInt**: Get min/max of two BigInts
- **roundUpBigInt**: Round up to nearest multiple
- Never use manual percentage calculations like `(value * 150n) / 100n`

### Security Best Practices
- Never log sensitive data (private keys, etc.)
