import type { ApiVersion } from "@alto/types"
import type { ReadonlyDeep } from "type-fest"
import type { z } from "zod"
import type { RpcHandler } from "./rpcHandler"
import { trace, SpanStatusCode } from "@opentelemetry/api"

export type MethodHandler<T extends z.ZodType = z.ZodType> = {
    schema: T
    method: z.infer<T>["method"]
    handler: (args: {
        rpcHandler: RpcHandler
        params: ReadonlyDeep<z.infer<T>["params"]>
        apiVersion: ApiVersion
    }) => Promise<z.infer<T>["result"]> | z.infer<T>["result"]
}

const freezeDeep = <T>(obj: T): T => {
    if (Array.isArray(obj)) {
        return Object.freeze(obj.map(freezeDeep)) as T
    }
    if (obj !== null && typeof obj === "object") {
        const frozenObj = Object.create(Object.getPrototypeOf(obj))
        for (const prop of Object.getOwnPropertyNames(obj)) {
            const value = obj[prop as keyof T]
            frozenObj[prop] = freezeDeep(value)
        }
        return Object.freeze(frozenObj) as T
    }
    return obj as T
}

export const createMethodHandler = <T extends z.ZodType>(methodConfig: {
    schema: T
    method: z.infer<T>["method"]
    handler: (args: {
        rpcHandler: RpcHandler
        params: ReadonlyDeep<z.infer<T>["params"]>
        apiVersion: ApiVersion
    }) => Promise<z.infer<T>["result"]> | z.infer<T>["result"]
}): {
    schema: T
    method: z.infer<T>["method"]
    handler: (args: {
        rpcHandler: RpcHandler
        params: ReadonlyDeep<z.infer<T>["params"]>
        apiVersion: ApiVersion
    }) => Promise<z.infer<T>["result"]> | z.infer<T>["result"]
} => {
    return {
        schema: methodConfig.schema,
        method: methodConfig.method,
        handler: (args) => {
            const frozenParams = freezeDeep(args.params)
            const invoke = () => methodConfig.handler({
                rpcHandler: args.rpcHandler,
                params: frozenParams,
                apiVersion: args.apiVersion
            })
            if (process.env.PERF_TRACING !== "true") return invoke()
            return trace.getTracer("ultra-relay-rpc").startActiveSpan(`rpc.${methodConfig.method}`, async (span) => {
                try {
                    const result = await invoke()
                    if (methodConfig.method === "eth_sendUserOperation" && typeof result === "string") {
                        span.setAttribute("profiler.userop", result.toLowerCase())
                    }
                    return result
                } catch (error) {
                    span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) })
                    throw error
                } finally { span.end() }
            })
        }
    }
}
