import { describe, expect, it } from "vitest"
import {
    pickSuccessHeaders,
    sanitizeRpcUrl,
    stripSensitiveHeaders
} from "./customTransport"

describe("sanitizeRpcUrl", () => {
    it("drops a path-based API key (Alchemy style)", () => {
        expect(
            sanitizeRpcUrl("https://base-mainnet.g.alchemy.com/v2/sk-SECRET")
        ).toBe("https://base-mainnet.g.alchemy.com")
    })

    it("drops a query-based API key", () => {
        expect(
            sanitizeRpcUrl("https://rpc.example.com/?apikey=sk-SECRET")
        ).toBe("https://rpc.example.com")
    })

    it("drops basic-auth userinfo", () => {
        expect(sanitizeRpcUrl("https://user:secret@rpc.example.com/path")).toBe(
            "https://rpc.example.com"
        )
    })

    it("keeps a non-default port", () => {
        expect(sanitizeRpcUrl("http://127.0.0.1:8545/")).toBe(
            "http://127.0.0.1:8545"
        )
    })

    it("returns a fixed marker for garbage input", () => {
        expect(sanitizeRpcUrl("not a url")).toBe("unparseable-url")
    })
})

describe("pickSuccessHeaders", () => {
    it("keeps only allowlisted and x-ratelimit-* headers", () => {
        expect(
            pickSuccessHeaders({
                "content-type": "application/json",
                "retry-after": "1",
                "cf-ray": "abc-BOM",
                "x-request-id": "req-1",
                "x-ratelimit-remaining": "99",
                "set-cookie": "__cf_bm=SECRET",
                "alt-svc": "h3",
                server: "cloudflare"
            })
        ).toEqual({
            "content-type": "application/json",
            "retry-after": "1",
            "cf-ray": "abc-BOM",
            "x-request-id": "req-1",
            "x-ratelimit-remaining": "99"
        })
    })

    it("passes undefined through", () => {
        expect(pickSuccessHeaders(undefined)).toBeUndefined()
    })
})

describe("stripSensitiveHeaders", () => {
    it("removes set-cookie and keeps everything else", () => {
        expect(
            stripSensitiveHeaders({
                "set-cookie": "__cf_bm=SECRET",
                "cf-ray": "abc-BOM",
                server: "cloudflare"
            })
        ).toEqual({ "cf-ray": "abc-BOM", server: "cloudflare" })
    })

    it("passes undefined through", () => {
        expect(stripSensitiveHeaders(undefined)).toBeUndefined()
    })
})
