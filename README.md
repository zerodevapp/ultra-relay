# 🚀 Ultra Relay (Modified from Alto) 🚀

![Node Version](https://img.shields.io/badge/node-20.x-green)

**Ultra Relay** is a **modified version** of [Alto](https://github.com/Pimlico/alto), originally developed by [Pimlico](https://pimlico.io).  
It is a **TypeScript implementation** of the [ERC-4337 bundler specification](https://eips.ethereum.org/EIPS/eip-4337), focused on transaction inclusion reliability.

> ⚠️ **DISCLAIMER:** This project contains modifications made by **ZeroDev Inc.** It is **not** affiliated with or endorsed by Pimlico.

## Modifications by ZeroDev Inc.

Ultra Relay has been modified from the original **Alto** to support **relayer functionality without requiring a paymaster**.

### **Key Changes**
- Accepting zeroed out `maxFeePerGas` and `maxPriorityFeePerGas` in the User Operation to be sent on-chain
- Other general improvements related to relayer/bundler (non-paymaster) sponsored user operations

These modifications were first made on **[Jan 22, 2025]** and continue to be updated.

## Getting started

For a full explanation of Alto, please visit Pimlico's [docs page](https://docs.pimlico.io/infra/bundler)

#### Run an instance of Ultra Relay (Command remains `alto` for compatibility):

```bash
pnpm install
pnpm build
./alto --entrypoints "0x5ff1...2789,0x0000...a032" --executor-private-keys "..." --utility-private-key "..." --min-balance "0" --rpc-url "http://localhost:8545" --network-name "local"
```
To find a list of all options, run:
```bash
./alto help
```

A helper script for running Alto locally with an Anvil node can be found at [scripts/run-local-instance.sh](scripts/README.md).

A comprehensive guide for self-hosting Alto can be found [here](https://docs.pimlico.io/infra/bundler/self-host).

#### Run the test suite with the following commands:
```bash
pnpm build
pnpm test # note: foundry must be installed on the machine for this to work
```

## Prerequisites

- :gear: [NodeJS](https://nodejs.org/) (LTS)
- :toolbox: [Pnpm](https://pnpm.io/)

## How to test bundler specs

- Run Geth node or any other node that support debug_traceCall
- Clone [bundler-spec-tests](https://github.com/eth-infinitism/bundler-spec-tests) repo.
- build & run bundler with `--environment development --bundleMode manual --safeMode true`


## License

Distributed under the GPL-3.0 License. See [LICENSE](./LICENSE) for more information.

## Contact

- Email: contact@zerodev.app

## Acknowledgements

- [Eth-Infinitism bundler](https://github.com/eth-infinitism/bundler)
- [Lodestar](https://github.com/ChainSafe/lodestar)
- [Pimlico Alto Bundler](https://github.com/Pimlico/alto), the original implementation from which Ultra Relay is derived.
