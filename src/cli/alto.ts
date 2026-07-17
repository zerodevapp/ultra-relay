#!/usr/bin/env node
import * as sentry from "@sentry/node"
import dotenv from "dotenv"
import { Agent, setGlobalDispatcher, fetch as undiciFetch } from "undici"
import { HttpRequestError, InternalRpcError, TimeoutError } from "viem"
import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { awaitingSocketInterceptor } from "../utils/fetchDispatcherStats"
import {
    bundlerCommand,
    bundlerOptions,
    compatibilityOptions,
    debugOptions,
    executorOptions,
    gasEstimationOptions,
    logOptions,
    mempoolOptions,
    redisOptions,
    rpcOptions,
    serverOptions
} from "./config"
import { registerCommandToYargs } from "./util"

// Load environment variables from .env file
if (process.env.DOTENV_CONFIG_PATH) {
    dotenv.config({ path: process.env.DOTENV_CONFIG_PATH })
} else {
    dotenv.config()
}

// Every RPC call goes through Node's global fetch (viem's HTTP transport),
// whose default dispatcher is unconfigured: unbounded per-origin connection
// creation and a 4s keep-alive. Under RPC bursts that means connection
// churn/storms (a DNS lookup + TLS handshake per new socket, connects queueing
// behind the 4-thread libuv pool) and tripping provider-edge connection
// limits — requests then burn their whole viem timeout budget client-side
// while the RPC endpoint itself stays healthy (Jul 15-16 Base incident:
// TimeoutErrors on eth_blockNumber while the same endpoint answered other
// clients in ~40ms). Pin an explicit bounded pool with a long keep-alive so
// warm sockets are reused and connection creation is bounded.
// The interceptor counts requests sitting between dispatch and socket write
// (queued for a free connection or waiting on DNS/TLS setup) — the
// client-side queueing signal the Jul 15-16 incident lacked. Composed onto
// the Agent so only its traffic is counted.
setGlobalDispatcher(
    new Agent({
        connections: 256, // per-origin socket cap
        keepAliveTimeout: 60_000 // keep sockets warm between bursts
    }).compose(awaitingSocketInterceptor)
)
// Pin global fetch to THIS undici package so fetch and dispatcher are always
// the same version. Node's BUILT-IN fetch only honors setGlobalDispatcher when
// its bundled undici major matches the npm package's global-dispatcher slot:
// verified empirically that on Node >= 26 (bundled undici v7) the npm v6
// setGlobalDispatcher is a silent no-op for built-in fetch. Our fleet runs
// mixed Node versions (Docker images pin 20.x; native Render services float
// to the latest at build time), so same-package pairing is the only
// combination that provably works everywhere (verified on Node 18/20/22/24/26).
globalThis.fetch = undiciFetch as unknown as typeof globalThis.fetch

if (process.env.SENTRY_DSN) {
    const SENTRY_IGNORE_ERRORS = [
        InternalRpcError,
        HttpRequestError,
        TimeoutError
    ]

    sentry.init({
        dsn: process.env.SENTRY_DSN,
        environment: process.env.ENVIRONMENT,
        skipOpenTelemetrySetup: true,
        tracesSampleRate: 0,
        profilesSampleRate: 0,
        integrations: [sentry.httpIntegration({ spans: false })],
        beforeSend(event, hint) {
            const errorType = event.exception?.values?.[0]?.type

            const shouldIgnore = SENTRY_IGNORE_ERRORS.some(
                (error) =>
                    hint.originalException instanceof error ||
                    errorType === error.name
            )

            if (shouldIgnore) {
                return null
            }

            return event
        }
    })
}

export const yarg = yargs(
    (hideBin as (args: string[]) => string[])(process.argv)
)

const topBanner = `🏔 Alto: TypeScript ERC-4337 Bundler.
  * by Pimlico, 2024`
const bottomBanner = `📖 For more information, check the our docs:
  * https://docs.pimlico.io/
`

export function getAltoCli(): yargs.Argv {
    const alto = yarg
        .wrap(null)
        .env("ALTO")
        .parserConfiguration({
            // As of yargs v16.1.0 dot-notation breaks strictOptions()
            // Manually processing options is typesafe tho more verbose
            "dot-notation": true
        })
        .options(bundlerOptions)
        .group(Object.keys(bundlerOptions), "Options:")
        .options(compatibilityOptions)
        .group(Object.keys(compatibilityOptions), "Compatibility Options:")
        .options(serverOptions)
        .group(Object.keys(serverOptions), "Server Options:")
        .options(executorOptions)
        .group(Object.keys(executorOptions), "Executor Options:")
        .options(rpcOptions)
        .group(Object.keys(rpcOptions), "RPC Options:")
        .options(logOptions)
        .group(Object.keys(logOptions), "Logging Options:")
        .options(debugOptions)
        .group(Object.keys(debugOptions), "Debug Options:")
        .options(gasEstimationOptions)
        .group(Object.keys(gasEstimationOptions), "Gas Estimation Options:")
        .options(mempoolOptions)
        .group(Object.keys(mempoolOptions), "Mempool Options:")
        .options(redisOptions)
        .group(Object.keys(redisOptions), "Redis Options:")
        // blank scriptName so that help text doesn't display the cli name before each command
        .scriptName("")
        .demandCommand(1)
        .usage(topBanner)
        .epilogue(bottomBanner)
        // Control show help behaviour below on .fail()
        .showHelpOnFail(false)
        .alias("h", "help")
        .alias("v", "version")
        .recommendCommands()

    // throw an error if we see an unrecognized cmd
    alto.recommendCommands() //.strict()
    alto.config()

    // yargs.command and all ./cmds
    registerCommandToYargs(alto, bundlerCommand)

    return alto
}

export class YargsError extends Error {}

const alto = getAltoCli()

// eslint-disable-next-line @typescript-eslint/no-floating-promises
alto.fail((msg, err) => {
    if (msg) {
        // Show command help message when no command is provided
        if (msg.includes("Not enough non-option arguments")) {
            yarg.showHelp()
            // eslint-disable-next-line no-console
            console.log("\n")
        }
    }

    const errorMessage =
        err !== undefined
            ? err instanceof YargsError
                ? err.message
                : err.stack
            : msg || "Unknown error"

    // eslint-disable-next-line no-console
    console.error(` × ${errorMessage}\n`)
    process.exit(1)
}).parse()
