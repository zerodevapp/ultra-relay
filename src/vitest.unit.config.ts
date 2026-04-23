import { resolve } from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
    test: {
        environment: "node",
        include: ["**/__tests__/**/*.test.ts"],
        exclude: ["node_modules", "esm", "lib"]
    },
    resolve: {
        alias: {
            "@alto/db": resolve(__dirname, "./db"),
            "@alto/cli": resolve(__dirname, "./cli"),
            "@alto/executor": resolve(__dirname, "./executor"),
            "@alto/mempool": resolve(__dirname, "./mempool"),
            "@alto/rpc": resolve(__dirname, "./rpc"),
            "@alto/types": resolve(__dirname, "./types"),
            "@alto/utils": resolve(__dirname, "./utils"),
            "@alto/handlers": resolve(__dirname, "./handlers"),
            "@alto/store": resolve(__dirname, "./store"),
            "@alto/receiptCache": resolve(__dirname, "./receiptCache")
        }
    }
})
