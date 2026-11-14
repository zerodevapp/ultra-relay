import { createServer } from "node:net"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { execa } from "execa"
import type { GlobalSetupContext } from "vitest/node"
import altoConfig from "./alto-config.json" with { type: "json" }
import { setupContracts } from "./deploy-contracts/index.js"

const testDirectory = fileURLToPath(new URL(".", import.meta.url))
const rootDirectory = resolve(testDirectory, "../..")

async function getPort(): Promise<number> {
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", resolve)
    })
    const address = server.address()
    if (!address || typeof address === "string") {
        throw new Error("Unable to allocate test port")
    }
    await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
    })
    return address.port
}

// Keep developer credentials, remote storage and telemetry out of local tests.
const localEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    DOTENV_CONFIG_PATH: "/dev/null",
    FOUNDRY_DISABLE_NIGHTLY_WARNING: "1",
    NO_COLOR: "1"
}

async function startProcess({
    command,
    args,
    readyMessage,
    env = {}
}: {
    command: string
    args: string[]
    readyMessage: string
    env?: Record<string, string>
}) {
    const child = execa(command, args, {
        cwd: testDirectory,
        env: { ...localEnv, ...env },
        extendEnv: false,
        reject: false,
        forceKillAfterDelay: 5_000,
        buffer: false
    })
    const stop = async () => {
        child.kill("SIGTERM")
        await child
    }
    let output = ""
    try {
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`${command} startup timed out:\n${output}`))
            }, 60_000)
            const onData = (data: Buffer) => {
                output = (output + data.toString()).slice(-16_000)
                if (output.includes(readyMessage)) {
                    clearTimeout(timer)
                    resolve()
                }
            }
            child.stdout?.on("data", onData)
            child.stderr?.on("data", onData)
            child.once("error", (error) => {
                clearTimeout(timer)
                reject(error)
            })
            child.once("exit", (code, signal) => {
                clearTimeout(timer)
                reject(
                    new Error(
                        `${command} exited (${code ?? signal}):\n${output}`
                    )
                )
            })
        })
    } catch (error) {
        await stop()
        throw error
    }
    return stop
}

export default async function setup({ provide }: GlobalSetupContext) {
    const anvilPort = await getPort()
    const anvilRpc = `http://127.0.0.1:${anvilPort}`
    const stopAnvil = await startProcess({
        command: "anvil",
        args: [
            "--host",
            "127.0.0.1",
            "--port",
            String(anvilPort),
            "--chain-id",
            "31337",
            "--hardfork",
            "prague",
            "--code-size-limit",
            "1000000",
            "--gas-limit",
            "30000000"
        ],
        readyMessage: "Listening on"
    })
    try {
        await setupContracts({ anvilRpc })
        const altoPort = await getPort()
        const envConfig = Object.fromEntries(
            Object.entries(altoConfig).map(([key, value]) => [
                `ALTO_${key.toUpperCase().replace(/-/g, "_")}`,
                String(value)
            ])
        )
        const stopAlto = await startProcess({
            command: "tsx",
            args: [
                "--tsconfig",
                resolve(rootDirectory, "src/tsconfig.json"),
                resolve(rootDirectory, "src/cli/alto.ts"),
                "run"
            ],
            readyMessage: "Server listening at",
            env: {
                ...envConfig,
                ALTO_RPC_URL: anvilRpc,
                ALTO_PORT: String(altoPort)
            }
        })
        provide("anvilRpc", anvilRpc)
        provide("altoRpc", `http://127.0.0.1:${altoPort}`)
        return async () => {
            try {
                await stopAlto()
            } finally {
                await stopAnvil()
            }
        }
    } catch (error) {
        await stopAnvil()
        throw error
    }
}

declare module "vitest" {
    export interface ProvidedContext {
        anvilRpc: string
        altoRpc: string
    }
}
