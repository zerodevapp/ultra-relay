// src/gas/abstractGasPriceManager.ts
import type { AltoConfig } from "../createConfig"
import { type MinMaxQueue, createMinMaxQueue } from "../utils/minMaxQueue"

export class AbstractManager {
    private pubdataPriceQueue: MinMaxQueue

    constructor({ config }: { config: AltoConfig }) {
        this.pubdataPriceQueue = createMinMaxQueue({
            keyPrefix: "abstract-pubdata-price-queue",
            config
        })
    }

    public async getMinPubdataPrice(): Promise<bigint> {
        return (await this.pubdataPriceQueue.getMinValue()) || 1n
    }

    public savePubdataPrice(value: bigint) {
        this.pubdataPriceQueue.saveValue(value)
    }
}
