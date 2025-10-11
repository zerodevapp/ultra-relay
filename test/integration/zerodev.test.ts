import { createKernelAccount, createKernelAccountClient } from "@zerodev/sdk"
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator"
import { http, createPublicClient, parseEther, createWalletClient, type Hash } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { foundry } from "viem/chains"

const ENTRYPOINT_VERSION = "0.7" as const
const PROJECT_ID = "550e8400-e29b-41d4-a716-446655440000"
const CHAIN_ID = "31337"
const PROVIDER_URL = process.env.PROVIDER_URL || `http://localhost:3333/api/v4/${PROJECT_ID}/chain/${CHAIN_ID}`
const RPC_URL = process.env.RPC_URL || "http://localhost:8545"
const ANVIL_DEFAULT_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

async function main() {
  console.log("🚀 Testing ZeroDev SDK → Provider → ultra-relay")

  const signer = privateKeyToAccount(generatePrivateKey())
  const publicClient = createPublicClient({ transport: http(RPC_URL), chain: foundry })
  const fundingAccount = privateKeyToAccount(ANVIL_DEFAULT_PRIVATE_KEY)
  const walletClient = createWalletClient({ account: fundingAccount, transport: http(RPC_URL), chain: foundry })

  const ecdsaValidator = await signerToEcdsaValidator(publicClient, {
    signer,
    entryPoint: { address: "0x0000000071727De22E5E9d8BAf0edAc6f37da032", version: ENTRYPOINT_VERSION },
    kernelVersion: "0.3.1"
  })

  const account = await createKernelAccount(publicClient, {
    plugins: { sudo: ecdsaValidator },
    entryPoint: { address: "0x0000000071727De22E5E9d8BAf0edAc6f37da032", version: ENTRYPOINT_VERSION },
    kernelVersion: "0.3.1"
  })
  console.log("✅ Kernel account:", account.address)

  const fundingTxHash = await walletClient.sendTransaction({ to: account.address, value: parseEther("10") })
  await publicClient.waitForTransactionReceipt({ hash: fundingTxHash })

  const kernelClient = createKernelAccountClient({
    account,
    chain: foundry,
    bundlerTransport: http(PROVIDER_URL),
    client: publicClient
  })

  console.log("📤 Sending UserOperation...")
  const userOpHash = await kernelClient.sendUserOperation({
    callData: await account.encodeCalls([{ to: signer.address, value: parseEther("0.001"), data: "0x" }])
  })

  const receipt = await kernelClient.waitForUserOperationReceipt({ hash: userOpHash as Hash, timeout: 30_000 })

  if (!receipt.success) throw new Error("UserOperation failed")

  const txReceipt = await publicClient.getTransactionReceipt({ hash: receipt.receipt.transactionHash })

  if (txReceipt.status !== 'success') throw new Error("Transaction reverted")

  console.log("✅ Test PASSED")
  console.log("   TX:", receipt.receipt.transactionHash)
  console.log("   Gas:", receipt.receipt.gasUsed)

  process.exit(0)
}

main().catch((error) => {
  console.error("❌ Test FAILED:", error.message)
  process.exit(1)
})
