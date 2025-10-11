import { createPublicClient, http } from "viem"
import { mainnet, foundry } from "viem/chains"

const MAINNET_RPC = "https://eth.llamarpc.com"
const ANVIL_RPC = process.env.ANVIL_RPC || "http://localhost:8545"

const KERNEL_CONTRACTS = {
  metaFactory: "0xd703aaE79538628d27099B8c4f621bE4CCd142d5",
  factory: "0xaac5D4240AF87249B3f71BC8E4A2cae074A3E419",
  kernel: "0xBAC849bB641841b44E965fB01A4Bf5F074f84b4D",
  ecdsaValidator: "0x845ADb2C711129d4f3966735eD98a9F09fC4cE57"
}

async function main() {
  const mainnetClient = createPublicClient({ transport: http(MAINNET_RPC), chain: mainnet })
  const anvilClient = createPublicClient({ transport: http(ANVIL_RPC), chain: foundry })

  for (const [name, address] of Object.entries(KERNEL_CONTRACTS)) {
    const bytecode = await mainnetClient.getBytecode({ address: address as `0x${string}` })
    if (!bytecode) throw new Error(`No bytecode for ${name}`)

    await anvilClient.request({ method: 'anvil_setCode' as any, params: [address, bytecode] })

    const deployed = await anvilClient.getBytecode({ address: address as `0x${string}` })
    if (deployed !== bytecode) throw new Error(`Verification failed: ${name}`)
  }
}

main().catch((error) => {
  console.error("Failed to copy Kernel contracts:", error.message)
  process.exit(1)
})
