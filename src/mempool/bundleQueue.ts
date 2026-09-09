import type { MempoolStore } from "@alto/store"
import type { Address, UserOpInfo } from "@alto/types"

/** Tracks operations temporarily removed by one builder tick, not durable queue ownership. */
export class BundleQueue {
    private readonly owned = new Map<string, UserOpInfo>()

    constructor(
        private readonly store: MempoolStore,
        private readonly entryPoint: Address
    ) {}

    async pop() {
        const info = await this.store.popOutstanding(this.entryPoint)
        if (info) this.owned.set(info.userOpHash, info)
        return info
    }

    release(info: UserOpInfo) {
        this.owned.delete(info.userOpHash)
    }

    async readd(info: UserOpInfo) {
        await this.store.addOutstanding({
            entryPoint: this.entryPoint,
            userOpInfo: info
        })
        this.release(info)
    }

    async restore(infos: UserOpInfo[]) {
        if (!infos.length) return
        await this.store.restoreOutstanding({
            entryPoint: this.entryPoint,
            userOpInfos: infos
        })
        for (const info of infos) this.release(info)
    }

    async close() {
        await this.restore([...this.owned.values()])
    }
}
