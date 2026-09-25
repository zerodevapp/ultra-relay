import type { AltoConfig } from "../../createConfig"
import { createMemoryMinMaxQueue } from "./createMemoryMinMaxQueue"
import { createRedisMinMaxQueue } from "./createRedisMinMaxQueue"

export interface MinMaxQueue {
    saveValue(value: bigint): Promise<void>
    getLatestValue(): Promise<bigint | null>
    getMinValue(): Promise<bigint | null>
    getMaxValue(): Promise<bigint | null>
}

export const createMinMaxQueue = ({
    config,
    keyPrefix,
    allowZero = false
}: {
    config: AltoConfig
    keyPrefix: string
    // Fee queues can contain genuine zero values; oracle queues keep filtering
    // them unless they explicitly opt in.
    allowZero?: boolean
}): MinMaxQueue => {
    if (config.enableHorizontalScaling && config.redisEndpoint) {
        return createRedisMinMaxQueue({
            config,
            keyPrefix,
            redisEndpoint: config.redisEndpoint,
            allowZero
        })
    }

    return createMemoryMinMaxQueue({ config, allowZero })
}
