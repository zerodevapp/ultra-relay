import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici"
import { NodeSDK } from "@opentelemetry/sdk-node"
import {
    InMemorySpanExporter,
    SimpleSpanProcessor
} from "@opentelemetry/sdk-trace-base"
import pino from "pino"
import { expect, it, vi } from "vitest"
import { timed } from "../utils/timed"
import { customTransport } from "./customTransport"

it("links the real validation timer to the outgoing viem/Undici traceparent", async () => {
    vi.stubEnv("PERF_TRACING", "true")
    vi.stubEnv("OTEL_METRICS_EXPORTER", "none")
    vi.stubEnv("OTEL_LOGS_EXPORTER", "none")
    const exporter = new InMemorySpanExporter()
    const instrumentation = new UndiciInstrumentation({
        requireParentforSpans: true
    })
    const sdk = new NodeSDK({
        autoDetectResources: false,
        spanProcessor: new SimpleSpanProcessor(exporter),
        instrumentations: [instrumentation]
    })
    let traceparent: string | undefined
    const server = createServer(async (request, response) => {
        traceparent = request.headers.traceparent as string | undefined
        const chunks: Buffer[] = []
        for await (const chunk of request) {
            chunks.push(chunk)
        }
        const body = JSON.parse(Buffer.concat(chunks).toString())
        response.setHeader("content-type", "application/json")
        response.end(
            JSON.stringify({
                jsonrpc: "2.0",
                id: body.id,
                result: { fixture: true }
            })
        )
    })
    try {
        sdk.start()
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject)
            server.listen(0, "127.0.0.1", resolve)
        })
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
        const logger = pino({ level: "silent" })
        const transport = customTransport(url, {
            logger,
            retryCount: 0,
            timeout: 2000
        })({})
        const userOpHash = `0x${"ab".repeat(32)}`
        const result = await timed(
            logger,
            "shouldSkip.validate",
            { userOpHash },
            () =>
                transport.request({
                    method: "debug_traceCall",
                    params: [{}, "latest", {}]
                })
        )
        expect(result).toEqual({ fixture: true })
        expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
        if (!traceparent) {
            throw new Error("Outgoing RPC did not carry traceparent")
        }
        const [, traceId, spanId] = traceparent.split("-")
        const spans = exporter.getFinishedSpans()
        const validation = spans.find(
            (span) => span.name === "shouldSkip.validate"
        )
        const outbound = spans.find(
            (span) => span.spanContext().spanId === spanId
        )
        expect(validation).toBeDefined()
        expect(outbound).toBeDefined()
        if (!validation || !outbound) {
            throw new Error("Validation or outgoing RPC span was not exported")
        }
        expect(validation.attributes["profiler.userop"]).toBe(userOpHash)
        expect(outbound.spanContext().traceId).toBe(traceId)
        expect(outbound.parentSpanId).toBe(validation.spanContext().spanId)
        expect(validation.spanContext().traceId).toBe(traceId)
    } finally {
        if (server.listening) {
            await new Promise<void>((resolve) => server.close(() => resolve()))
        }
        await sdk.shutdown()
        vi.unstubAllEnvs()
    }
}, 10000)
