import { http, type Address, createPublicClient, createWalletClient, type PublicClient } from "viem"
import { mnemonicToAccount } from "viem/accounts"
import { foundry } from "viem/chains"
import {
  ENTRY_POINT_SIMULATIONS_CREATECALL,
  ENTRY_POINT_V06_CREATECALL,
  ENTRY_POINT_V07_CREATECALL,
  SIMPLE_ACCOUNT_FACTORY_V06_CREATECALL,
  SIMPLE_ACCOUNT_FACTORY_V07_CREATECALL
} from "../e2e/deploy-contracts/constants.js"

const DETERMINISTIC_DEPLOYER = "0x4e59b44847b379578588920ca78fbf26c0b4956c"
const DEPLOYMENT_TIMEOUT = 30000

const deployWithTimeout = <T>(promise: Promise<T>, timeoutMs: number, errorMsg: string): Promise<T> =>
  Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(errorMsg)), timeoutMs))])

const verifyDeployed = async (addresses: Address[], client: PublicClient) => {
  for (const address of addresses) {
    const bytecode = await client.getBytecode({ address })
    if (!bytecode || bytecode === "0x") throw new Error(`Contract ${address} not deployed`)
  }
}

async function setupContracts({ anvilRpc }: { anvilRpc: string }) {
  const walletClient = createWalletClient({
    account: mnemonicToAccount("test test test test test test test test test test test junk"),
    chain: foundry,
    transport: http(anvilRpc)
  })

  const client = createPublicClient({ transport: http(anvilRpc) })

  const deployments = [
    { name: "EntryPoint v0.7", data: ENTRY_POINT_V07_CREATECALL },
    { name: "SimpleAccountFactory v0.7", data: SIMPLE_ACCOUNT_FACTORY_V07_CREATECALL },
    { name: "EntryPointSimulations", data: ENTRY_POINT_SIMULATIONS_CREATECALL },
    { name: "EntryPoint v0.6", data: ENTRY_POINT_V06_CREATECALL },
    { name: "SimpleAccountFactory v0.6", data: SIMPLE_ACCOUNT_FACTORY_V06_CREATECALL }
  ]

  let nonce = await client.getTransactionCount({ address: walletClient.account.address })

  for (const deployment of deployments) {
    const hash = await deployWithTimeout(
      walletClient.sendTransaction({ to: DETERMINISTIC_DEPLOYER, data: deployment.data, gas: 15_000_000n, nonce: nonce++ }),
      DEPLOYMENT_TIMEOUT,
      `Timeout deploying ${deployment.name}`
    )
    await deployWithTimeout(client.waitForTransactionReceipt({ hash }), DEPLOYMENT_TIMEOUT, `Timeout waiting for ${deployment.name}`)
  }

  await verifyDeployed(
    ["0x0000000071727De22E5E9d8BAf0edAc6f37da032", "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789"],
    client
  )
}

setupContracts({ anvilRpc: process.env.ANVIL_RPC || process.env.RPC_URL || "http://localhost:8545" })
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Deploy failed:", error.message)
    process.exit(1)
  })
