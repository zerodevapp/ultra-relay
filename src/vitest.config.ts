import { resolve } from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
    resolve: {
        // Mirror the @alto/* path aliases from tsconfig.json.
        alias: {
            "@alto/cli": resolve(__dirname, "cli"),
            "@alto/executor": resolve(__dirname, "executor"),
            "@alto/mempool": resolve(__dirname, "mempool"),
            "@alto/rpc": resolve(__dirname, "rpc"),
            "@alto/types": resolve(__dirname, "types"),
            "@alto/utils": resolve(__dirname, "utils"),
            "@alto/handlers": resolve(__dirname, "handlers"),
            "@alto/store": resolve(__dirname, "store"),
            "@alto/receiptCache": resolve(__dirname, "receiptCache")
        }
    },
    test: {
        environment: "node"
    }
})
