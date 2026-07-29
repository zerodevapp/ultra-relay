import { defineConfig } from "vitest/config"

export default defineConfig({
    test: {
        environment: "node",
        // forks pool exits cleanly despite the sender manager's long-lived
        // ioredis connection (SenderManager exposes no close())
        pool: "forks",
        testTimeout: 15_000
    }
})
