import { describe, expect, test } from "vitest"
import { BundleManager } from "./bundleManager"

describe("isBundlePending", () => {
    const make = () => {
        const manager = Object.create(BundleManager.prototype) as BundleManager
        Object.assign(manager, { pendingBundles: new Map() })
        return manager
    }

    test("false before the bundle is tracked", () => {
        expect(make().isBundlePending("uid-1")).toBe(false)
    })

    test("true once tracked, false once stopped", () => {
        const manager = make()
        const bundle = { uid: "uid-1" } as never

        manager.trackBundle(bundle)
        expect(manager.isBundlePending("uid-1")).toBe(true)

        manager.stopTrackingBundle(bundle)
        expect(manager.isBundlePending("uid-1")).toBe(false)
    })

    test("is per bundle", () => {
        const manager = make()
        manager.trackBundle({ uid: "uid-1" } as never)

        expect(manager.isBundlePending("uid-2")).toBe(false)
    })
})
