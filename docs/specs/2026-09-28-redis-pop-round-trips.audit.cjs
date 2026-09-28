// Standalone audit of baseline ba8d4cf and the Lua candidate in the spec.
// Run from repository root with AUDIT_REDIS_SOCKET and AUDIT_OUTPUT_DIR.
// Use a disposable local Redis: this test intentionally calls SCRIPT FLUSH.
const fs = require("node:fs")
const path = require("node:path")
const assert = require("node:assert/strict")
const { createRequire } = require("node:module")
const root = process.cwd()
const scratch = process.env.AUDIT_OUTPUT_DIR
assert(
    scratch && process.env.AUDIT_REDIS_SOCKET,
    "Set AUDIT_OUTPUT_DIR and AUDIT_REDIS_SOCKET; see the spec Appendix A"
)
fs.mkdirSync(scratch, { recursive: true })
const baselineCommit = "ba8d4cf29d15e09350f7363261734fe468badac7"
const sourcePath = "src/store/createRedisOutstandingStore.ts"
const baselineSource = require("node:child_process").execFileSync(
    "git",
    ["show", `${baselineCommit}:${sourcePath}`],
    { cwd: root }
)
assert(
    fs.readFileSync(path.join(root, sourcePath)).equals(baselineSource),
    "Run this historical evidence harness against the unchanged baseline store"
)
const req = createRequire(path.join(root, "package.json"))
process.env.TSX_TSCONFIG_PATH = path.join(root, "src/tsconfig.json")
process.env.DOTENV_CONFIG_PATH = "/dev/null"
process.env.BETTER_STACK_TOKEN = ""
req("tsx/cjs")
const { Redis } = req("./src/node_modules/ioredis")
const { userOpInfoSchema } = req("./src/types/schemas.ts")
const { createRedisOutstandingQueue: baseline } = req(
    "./src/store/createRedisOutstandingStore.ts"
)
const spec = fs.readFileSync(
    path.join(root, "docs/specs/2026-09-28-redis-pop-round-trips.md"),
    "utf8"
)
const correctedLua = spec
    .split("const POP_OUTSTANDING_SCRIPT = `\n")[1]
    .split("\n`")[0]
const originalLua = correctedLua.replace(
    "tonumber(nextOp.userOp.maxFeePerGas)",
    "tonumber(string.sub(nextOp.userOp.maxFeePerGas, 3), 16)"
)
const endpoint = process.env.AUDIT_REDIS_SOCKET
assert(
    path.isAbsolute(endpoint) && fs.statSync(endpoint).isSocket(),
    "Expected an existing absolute Unix socket path"
)
const entryPoint = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789"
const connections = []
const runPrefix = `audit-${require("node:crypto").randomUUID()}`
let serial = 0
const output = {}
const hash = (n) => `0x${BigInt(n).toString(16).padStart(64, "0")}`
const make = (n, sender = 1, nonce = 0n, fee = 10n, deployment = false) => ({
    userOp: {
        sender: `0x${sender.toString(16).padStart(40, "0")}`,
        nonce,
        initCode: deployment ? "0x1234" : "0x",
        callData: "0x",
        callGasLimit: 100000n,
        verificationGasLimit: 100000n,
        preVerificationGas: 100000n,
        maxPriorityFeePerGas: 1n,
        maxFeePerGas: fee,
        paymasterAndData: "0x",
        signature: "0x"
    },
    userOpHash: hash(n),
    addedToMempool: 1000,
    submissionAttempts: 0
})
async function queue(lua) {
    const prefix = `${runPrefix}-${++serial}`
    const store = baseline({
        config: { chainId: 1, redisKeyPrefix: prefix },
        entryPoint,
        redisEndpoint: endpoint
    })
    const redis = store.redis
    connections.push(redis)
    await redis.ping()
    if (lua) {
        redis.defineCommand("auditPop", { numberOfKeys: 3, lua })
        store.pop = async () => {
            const raw = await redis.auditPop(
                store.readyOpsQueue.keyPath,
                store.userOpHashLookup.keyPath,
                store.factoryLookup.keyPath
            )
            return raw ? userOpInfoSchema.parse(JSON.parse(raw)) : undefined
        }
    }
    return {
        store,
        redis,
        prefix: `${prefix}:1`,
        ready: store.readyOpsQueue.keyPath,
        hashes: store.userOpHashLookup.keyPath,
        factories: store.factoryLookup.keyPath
    }
}
async function state(q) {
    const keys = (await q.redis.keys(`${q.prefix}:*`)).sort()
    const result = {}
    for (const key of keys) {
        const type = await q.redis.type(key)
        const val =
            type === "hash"
                ? Object.entries(await q.redis.hgetall(key)).sort()
                : await q.redis.zrange(key, 0, -1, "WITHSCORES")
        result[key.replaceAll(q.prefix, "PREFIX")] = JSON.parse(
            JSON.stringify(val).replaceAll(q.prefix, "PREFIX")
        )
    }
    return result
}
async function trace(q, fn) {
    const stream = q.redis.connector.stream
    const write = stream.write
    const chunks = []
    stream.write = function (chunk, ...rest) {
        chunks.push(Buffer.from(chunk))
        return write.call(this, chunk, ...rest)
    }
    try {
        await fn()
    } finally {
        stream.write = write
    }
    const wire = Buffer.concat(chunks).toString()
    const commands = [...wire.matchAll(/\*\d+\r\n\$\d+\r\n([^\r]+)\r\n/g)].map(
        (m) => m[1]
    )
    return { writes: chunks.length, commands }
}
async function drain(q, old) {
    let count = 0
    if (!(await q.store.peek())) {
        return count
    }
    if (old) {
        while (await q.store.peek()) {
            while (await q.store.peek()) {
                assert(await q.store.pop())
                count++
            }
        }
    } else {
        while (await q.store.pop()) {
            count++
        }
    }
    return count
}
async function main() {
    output.versions = {
        node: process.version,
        ioredis: req("./src/node_modules/ioredis/package.json").version,
        baselineCommit
    }
    output.counts = []
    for (const n of [1, 4, 12]) {
        for (const lua of [undefined, originalLua]) {
            const q = await queue(lua)
            output.versions.redis = (await q.redis.info("server")).match(
                /redis_version:([^\r\n]+)/
            )[1]
            for (let i = 0; i < n; i++) {
                await q.store.add(make(i + 1, i + 1))
            }
            let popped
            const observed = await trace(q, async () => {
                popped = await drain(q, !lua)
            })
            assert.equal(popped, n)
            assert.equal(observed.writes, lua ? n + 3 : 6 * n + 6)
            output.counts.push({ n, mode: lua ? "lua" : "old", ...observed })
        }
    }
    output.fees = []
    for (const fee of [
        0xfffffffffffff7bn,
        0x20000000000000001n,
        1n << 80n,
        (1n << 128n) - 1n,
        (1n << 256n) - 1n
    ]) {
        const scores = []
        for (const lua of [undefined, originalLua, correctedLua]) {
            const q = await queue(lua)
            await q.store.add(make(1, 1, 0n, 1n))
            await q.store.add(make(2, 1, 1n, fee))
            await q.store.pop()
            const [slot] = await q.redis.zrange(q.ready, 0, -1)
            const score = Number(await q.redis.zscore(q.ready, slot))
            scores.push(score)
        }
        assert.equal(scores[0], Number(fee))
        assert.equal(scores[2], scores[0])
        output.fees.push({
            hex: `0x${fee.toString(16)}`,
            old: scores[0],
            proposed: scores[1],
            corrected: scores[2]
        })
    }
    const cache = await queue(originalLua)
    output.cache = {
        cold: await trace(cache, () => cache.store.pop()),
        warm: await trace(cache, () => cache.store.pop())
    }
    await cache.redis.script("FLUSH")
    output.cache.afterFlush = await trace(cache, () => cache.store.pop())
    assert.equal(output.cache.afterFlush.writes, 2)
    output.races = []
    // Stop the actual old pop at an exact awaited boundary, avoiding timing sweeps.
    for (const boundary of ["beforeExec", "afterExec"]) {
        const q = await queue()
        await q.store.add(make(1))
        const writer = baseline({
            config: { chainId: 1, redisKeyPrefix: q.prefix.slice(0, -2) },
            entryPoint,
            redisEndpoint: endpoint
        })
        connections.push(writer.redis)
        await writer.redis.ping()
        const multi = q.redis.multi.bind(q.redis)
        q.redis.multi = (...args) => {
            const transaction = multi(...args)
            const exec = transaction.exec.bind(transaction)
            transaction.exec = async (...args) => {
                if (boundary === "beforeExec") {
                    await writer.add(make(2, 1, 1n))
                }
                const result = await exec(...args)
                if (boundary === "afterExec") {
                    await writer.add(make(2, 1, 1n))
                }
                return result
            }
            return transaction
        }
        await q.store.pop()
        const indexed = await q.store.contains(hash(2))
        const slot = await q.redis.hget(q.hashes, hash(2))
        const members = await q.redis.zcard(slot)
        const ready = await q.redis.zscore(q.ready, slot)
        assert(indexed)
        assert.equal(members, 0)
        assert.equal(ready !== null, boundary === "afterExec")
        output.races.push({ boundary, indexed, members, ready })
    }
    // An add() that has read the old head may still write after atomic pop.
    const q = await queue(correctedLua)
    await q.store.add(make(1))
    const multi = q.redis.multi.bind(q.redis)
    q.redis.multi = (...args) => {
        const transaction = multi(...args)
        const exec = transaction.exec.bind(transaction)
        transaction.exec = async (...args) => {
            await q.store.pop()
            return exec(...args)
        }
        return transaction
    }
    await q.store.add(make(2, 1, 1n))
    const slot = await q.redis.hget(q.hashes, hash(2))
    output.remainingAddRace = {
        indexed: await q.store.contains(hash(2)),
        members: await q.redis.zcard(slot),
        ready: await q.redis.zscore(q.ready, slot)
    }
    assert.equal(output.remainingAddRace.members, 1)
    assert.equal(output.remainingAddRace.ready, null)
    // Normal, sequential operation equivalence, including scores and raw members.
    let steps = 0
    let pops = 0
    for (let seed = 1; seed <= 40; seed++) {
        let rng = seed
        const rand = () => {
            rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0
            return rng
        }
        const old = await queue()
        const next = await queue(correctedLua)
        const seq = new Array(12).fill(0)
        for (let j = 0; j < 60; j++) {
            if (rand() % 3 !== 0) {
                const slot = rand() % 12
                const nonce = (BigInt(slot % 2) << 64n) + BigInt(seq[slot]++)
                const op = make(
                    seed * 100 + j + 1,
                    Math.floor(slot / 2) + 1,
                    nonce,
                    BigInt(rand()) << 40n
                )
                await old.store.add(op)
                await next.store.add(op)
            } else {
                assert.deepEqual(await old.store.pop(), await next.store.pop())
                pops++
            }
            assert.deepEqual(await state(old), await state(next))
            steps++
        }
        while (true) {
            const a = await old.store.pop()
            const b = await next.store.pop()
            assert.deepEqual(a, b)
            assert.deepEqual(await state(old), await state(next))
            steps++
            pops++
            if (!a) {
                break
            }
        }
    }
    output.equivalence = { seeds: 40, steps, pops }
    const concurrent = await queue(correctedLua)
    const second = baseline({
        config: { chainId: 1, redisKeyPrefix: concurrent.prefix.slice(0, -2) },
        entryPoint,
        redisEndpoint: endpoint
    })
    connections.push(second.redis)
    await second.redis.ping()
    second.redis.defineCommand("auditPop", {
        numberOfKeys: 3,
        lua: correctedLua
    })
    const consume = async (redis) => {
        const out = []
        while (true) {
            const raw = await redis.auditPop(
                concurrent.ready,
                concurrent.hashes,
                concurrent.factories
            )
            if (!raw) {
                return out
            }
            out.push(JSON.parse(raw).userOpHash)
        }
    }
    for (let i = 1; i <= 40; i++) {
        await concurrent.store.add(make(i, 1, BigInt(i - 1)))
    }
    const consumed = (
        await Promise.all([consume(concurrent.redis), consume(second.redis)])
    ).flat()
    assert.equal(consumed.length, 40)
    assert.equal(new Set(consumed).size, 40)
    assert.deepEqual(await state(concurrent), {})
    output.concurrent = {
        consumers: 2,
        popped: 40,
        unique: 40,
        remainingKeys: 0
    }
    // Factory tracking difference, stale-head skip, and invalid-zod destructive behavior.
    const factory = await queue(correctedLua)
    await factory.store.add(make(1, 1, 0n, 10n, true))
    await factory.store.add(make(2, 1, 1n, 10n, true))
    await factory.store.pop()
    assert.equal(
        await factory.redis.hget(factory.factories, make(1).userOp.sender),
        hash(2)
    )
    const stale = await queue(correctedLua)
    await stale.store.add(make(1))
    await stale.redis.zadd(stale.ready, 100, `${stale.prefix}:missing`)
    assert.equal((await stale.store.pop()).userOpHash, hash(1))
    assert.equal(await stale.redis.zcard(stale.ready), 0)
    output.invalid = []
    for (const lua of [undefined, correctedLua]) {
        const bad = await queue(lua)
        await bad.store.add(make(1))
        const slot = await bad.redis.hget(bad.hashes, hash(1))
        const [raw] = await bad.redis.zrange(slot, 0, -1)
        const obj = JSON.parse(raw)
        obj.addedToMempool = "bad"
        await bad.redis.zrem(slot, raw)
        await bad.redis.zadd(slot, 0, JSON.stringify(obj))
        await assert.rejects(() => bad.store.pop())
        output.invalid.push({
            mode: lua ? "lua" : "old",
            indexed: await bad.store.contains(hash(1)),
            members: await bad.redis.zcard(slot)
        })
    }
    output.completed = true
}
main()
    .then(() => {
        fs.writeFileSync(
            path.join(scratch, "evidence.json"),
            JSON.stringify(output, null, 2)
        )
    })
    .catch((_err) => {
        process.exitCode = 1
    })
    .finally(async () => {
        try {
            if (connections[0]?.status === "ready") {
                const keys = await connections[0].keys(`${runPrefix}:*`)
                // Queue prefixes also include an incrementing case suffix.
                const caseKeys = await connections[0].keys(`${runPrefix}-*`)
                const all = [...keys, ...caseKeys]
                for (let i = 0; i < all.length; i += 100) {
                    await connections[0].del(...all.slice(i, i + 100))
                }
            }
        } finally {
            for (const redis of connections) {
                redis.disconnect()
            }
        }
    })
