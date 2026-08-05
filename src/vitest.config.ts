import { resolve } from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
    resolve: {
        alias: {
            "@alto/types": resolve(__dirname, "types")
        }
    },
    test: {
        environment: "node"
    }
})
