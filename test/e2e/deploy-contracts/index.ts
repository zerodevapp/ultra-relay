import { http, createPublicClient, createWalletClient } from "viem"
import { mnemonicToAccount } from "viem/accounts"
import { foundry } from "viem/chains"
import {
    ENTRY_POINT_V06_CREATECALL,
    ENTRY_POINT_V07_CREATECALL,
    ENTRY_POINT_V08_CREATECALL,
    SIMPLE_7702_ACCOUNT_IMPLEMENTATION_V06_CREATECALL,
    SIMPLE_7702_ACCOUNT_IMPLEMENTATION_V07_CREATECALL,
    SIMPLE_7702_ACCOUNT_IMPLEMENTATION_V08_CREATECALL,
    SIMPLE_ACCOUNT_FACTORY_V06_CREATECALL,
    SIMPLE_ACCOUNT_FACTORY_V07_CREATECALL,
    SIMPLE_ACCOUNT_FACTORY_V08_CREATECALL
} from "./constants.js"

const DETERMINISTIC_DEPLOYER = "0x4e59b44847b379578588920ca78fbf26c0b4956c"

export async function setupContracts({ anvilRpc }: { anvilRpc: string }) {
    const walletClient = createWalletClient({
        account: mnemonicToAccount(
            "test test test test test test test test test test test junk"
        ),
        chain: foundry,
        transport: http(anvilRpc)
    })
    const client = createPublicClient({
        transport: http(anvilRpc),
        pollingInterval: 100
    })

    const deployments = [
        [
            SIMPLE_7702_ACCOUNT_IMPLEMENTATION_V08_CREATECALL,
            "0xe6Cae83BdE06E4c305530e199D7217f42808555B"
        ],
        [
            SIMPLE_7702_ACCOUNT_IMPLEMENTATION_V07_CREATECALL,
            "0xf3F57446bEC27F6531EFF3Da2B917ebA8F9BA49c"
        ],
        [
            SIMPLE_7702_ACCOUNT_IMPLEMENTATION_V06_CREATECALL,
            "0x90c7Fc0Fe4F0188E61C131d5dB7aCa03a684a2fB"
        ],
        [
            ENTRY_POINT_V08_CREATECALL,
            "0x4337084d9e255ff0702461cf8895ce9e3b5ff108"
        ],
        [
            SIMPLE_ACCOUNT_FACTORY_V08_CREATECALL,
            "0x13E9ed32155810FDbd067D4522C492D6f68E5944"
        ],
        [
            ENTRY_POINT_V07_CREATECALL,
            "0x0000000071727De22E5E9d8BAf0edAc6f37da032"
        ],
        [
            SIMPLE_ACCOUNT_FACTORY_V07_CREATECALL,
            "0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985"
        ],
        [
            ENTRY_POINT_V06_CREATECALL,
            "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789"
        ],
        [
            SIMPLE_ACCOUNT_FACTORY_V06_CREATECALL,
            "0x9406Cc6185a346906296840746125a0E44976454"
        ]
    ] as const

    for (const [data, address] of deployments) {
        const hash = await walletClient.sendTransaction({
            to: DETERMINISTIC_DEPLOYER,
            data,
            gas: 15_000_000n
        })
        const receipt = await client.waitForTransactionReceipt({
            hash,
            timeout: 30_000
        })
        const code = await client.getCode({ address })
        if (receipt.status !== "success" || !code || code === "0x") {
            throw new Error(`Test contract deployment failed: ${address}`)
        }
    }
}
