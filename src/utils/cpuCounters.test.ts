import { describe, expect, it } from "vitest"
import {
    type CpuSnapshot,
    type ReadFile,
    cpuFields,
    createCpuCounters,
    readFileOrUndefined
} from "./cpuCounters"

// File texts as read in node:20.12.2-alpine on a cgroup v2 host.
const CPU_STAT = `usage_usec 12297
user_usec 6707
system_usec 5589
nr_periods 1
nr_throttled 0
throttled_usec 0
nr_bursts 0
burst_usec 0
`
const CPU_PRESSURE = `some avg10=0.00 avg60=0.00 avg300=0.00 total=87
full avg10=0.00 avg60=0.00 avg300=0.00 total=87
`
// user nice system idle iowait irq softirq steal guest guest_nice. The first
// eight sum to 975; guest (30) and guest_nice (4) must not be added.
const PROC_STAT = `cpu  100 5 50 800 10 1 2 7 30 4
cpu0 50 2 25 400 5 0 1 3 15 2
cpu1 50 3 25 400 5 1 1 4 15 2
intr 12345
`

const cpuStat = (usageUs: number, nrThrottled = 0, throttledUs = 0) =>
    `usage_usec ${usageUs}\nuser_usec 0\nsystem_usec 0\nnr_periods 10\nnr_throttled ${nrThrottled}\nthrottled_usec ${throttledUs}\nnr_bursts 0\nburst_usec 0\n`
const cpuPressure = (totalUs: number) =>
    `some avg10=0.00 avg60=0.00 avg300=0.00 total=${totalUs}\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=${totalUs}\n`
const procStat = (busyTicks: number, stealTicks: number) =>
    `cpu  ${busyTicks} 0 0 1000 0 0 0 ${stealTicks} 0 0\ncpu0 0 0 0 0 0 0 0 0 0 0\ncpu1 0 0 0 0 0 0 0 0 0 0\n`

// A fake filesystem: undefined means the file is missing. Records every read.
function fakeFs(files: Record<string, string | undefined>) {
    const contents = new Map(Object.entries(files))
    const reads: string[] = []
    const readFile: ReadFile = (path) => {
        reads.push(path)
        return contents.get(path)
    }
    return { readFile, reads, contents }
}

// A cgroup v2 container whose files live in dir, named by selfCgroup.
const v2Files = (
    dir = "/sys/fs/cgroup",
    selfCgroup = "0::/\n"
): Record<string, string | undefined> => ({
    "/proc/self/cgroup": selfCgroup,
    "/sys/fs/cgroup/cgroup.controllers": "cpuset cpu io memory pids\n",
    [`${dir}/cpu.stat`]: CPU_STAT,
    [`${dir}/cpu.max`]: "100000 100000\n",
    [`${dir}/cpu.pressure`]: CPU_PRESSURE,
    "/proc/stat": PROC_STAT
})

describe("createCpuCounters", () => {
    it("reads every source on cgroup v2 with its own namespace", () => {
        const { readFile } = fakeFs(v2Files())

        const counters = createCpuCounters(readFile)

        expect(counters.info).toEqual({
            cgroup: "v2",
            cpuLimit: 1,
            cpuPressure: true,
            steal: true,
            nodeCpus: 2
        })
        expect(counters.snapshot()).toEqual({
            usageUs: 12297,
            throttledPeriods: 0,
            throttledUs: 0,
            waitUs: 87,
            stealTicks: 7,
            totalTicks: 975
        })
    })

    it.each([
        ["max 100000\n", null],
        ["50000 100000\n", 0.5],
        [undefined, null]
    ])("reads cpu.max %j as cpuLimit %j", (text, expected) => {
        const { readFile } = fakeFs({
            ...v2Files(),
            "/sys/fs/cgroup/cpu.max": text
        })

        expect(createCpuCounters(readFile).info.cpuLimit).toBe(expected)
    })

    it("follows a host-namespace path to the container's own files", () => {
        const dir = "/sys/fs/cgroup/kubepods/pod1/ctr"
        const { readFile, reads } = fakeFs(
            v2Files(dir, "0::/kubepods/pod1/ctr\n")
        )

        const counters = createCpuCounters(readFile)

        expect(counters.info.cgroup).toBe("v2")
        expect(counters.snapshot().usageUs).toBe(12297)
        expect(reads).toContain(`${dir}/cpu.stat`)
        expect(reads).not.toContain("/sys/fs/cgroup/cpu.stat")
    })

    it("gives up on cgroup fields rather than read the machine's root", () => {
        // Root files exist (the whole machine), but our own directory doesn't.
        const { readFile, reads } = fakeFs({
            ...v2Files(),
            "/proc/self/cgroup": "0::/kubepods/pod1/ctr\n"
        })

        const counters = createCpuCounters(readFile)

        expect(counters.info).toEqual({
            cgroup: "other",
            cpuLimit: null,
            cpuPressure: false,
            steal: true,
            nodeCpus: 2
        })
        expect(counters.snapshot()).toEqual({
            stealTicks: 7,
            totalTicks: 975
        })
        expect(reads).not.toContain("/sys/fs/cgroup/cpu.stat")
    })

    it.each([
        ["v1 lines only", { "/proc/self/cgroup": "12:cpu,cpuacct:/x\n" }],
        [
            "no cgroup.controllers",
            { "/sys/fs/cgroup/cgroup.controllers": undefined }
        ]
    ])("reports cgroup other with %s, and steal still works", (_, change) => {
        const { readFile } = fakeFs({ ...v2Files(), ...change })

        const counters = createCpuCounters(readFile)

        expect(counters.info.cgroup).toBe("other")
        expect(counters.snapshot()).toEqual({
            stealTicks: 7,
            totalTicks: 975
        })
    })

    it("finds the 0:: line on a hybrid v1+v2 host", () => {
        const { readFile } = fakeFs({
            ...v2Files(),
            "/proc/self/cgroup":
                "12:cpu,cpuacct:/docker/abc\n11:memory:/docker/abc\n0::/\n"
        })

        expect(createCpuCounters(readFile).info.cgroup).toBe("v2")
    })

    it("reports cgroup none without /proc/self/cgroup", () => {
        const { readFile } = fakeFs({
            ...v2Files(),
            "/proc/self/cgroup": undefined
        })

        const counters = createCpuCounters(readFile)

        expect(counters.info).toMatchObject({
            cgroup: "none",
            cpuLimit: null,
            cpuPressure: false,
            steal: true
        })
    })

    it.each([
        ["missing", undefined],
        ["without total=", "some avg10=0.00 avg60=0.00 avg300=0.00\n"]
    ])("has no cpu wait when cpu.pressure is %s", (_, text) => {
        const { readFile } = fakeFs({
            ...v2Files(),
            "/sys/fs/cgroup/cpu.pressure": text
        })

        const counters = createCpuCounters(readFile)

        expect(counters.info.cpuPressure).toBe(false)
        expect(counters.snapshot()).not.toHaveProperty("waitUs")
    })

    it("reads usage but no throttle fields when the cpu controller isn't delegated", () => {
        const { readFile } = fakeFs({
            ...v2Files(),
            "/sys/fs/cgroup/cpu.stat":
                "usage_usec 12297\nuser_usec 6707\nsystem_usec 5589\n"
        })

        const snapshot = createCpuCounters(readFile).snapshot()

        expect(snapshot.usageUs).toBe(12297)
        expect(snapshot.throttledPeriods).toBeUndefined()
        expect(snapshot.throttledUs).toBeUndefined()
        expect(
            cpuFields(snapshot, { ...snapshot, usageUs: 22297 })
        ).not.toHaveProperty("throttledMs")
    })

    it.each([
        ["a first line that isn't cpu", "intr 1 2 3\ncpu 1 2 3 4 5 6 7 8\n"],
        ["fewer than eight values", "cpu  1 2 3 4 5 6 7\n"]
    ])("has no steal with %s", (_, text) => {
        const { readFile } = fakeFs({ ...v2Files(), "/proc/stat": text })

        const counters = createCpuCounters(readFile)

        expect(counters.info.steal).toBe(false)
        expect(counters.snapshot()).not.toHaveProperty("stealTicks")
    })

    it("recovers when a file vanishes for one snapshot", () => {
        const fs = fakeFs(v2Files())
        const counters = createCpuCounters(fs.readFile)
        const before = counters.snapshot()

        for (const path of [
            "/sys/fs/cgroup/cpu.stat",
            "/sys/fs/cgroup/cpu.pressure",
            "/proc/stat"
        ]) {
            fs.contents.delete(path)
        }
        const gap = counters.snapshot()
        expect(Object.values(gap).every((value) => value === undefined)).toBe(
            true
        )
        expect(cpuFields(before, gap)).toStrictEqual({})

        fs.contents.set("/sys/fs/cgroup/cpu.stat", cpuStat(22_297))
        fs.contents.set("/sys/fs/cgroup/cpu.pressure", cpuPressure(187))
        fs.contents.set("/proc/stat", procStat(200, 9))
        const back = counters.snapshot()
        fs.contents.set("/sys/fs/cgroup/cpu.stat", cpuStat(32_297))
        fs.contents.set("/sys/fs/cgroup/cpu.pressure", cpuPressure(287))
        fs.contents.set("/proc/stat", procStat(300, 9))

        expect(cpuFields(back, counters.snapshot())).toEqual({
            cpuMs: 10,
            throttledPeriods: 0,
            throttledMs: 0,
            cpuWaitMs: 0.1,
            stealPct: 0
        })
    })
})

describe("cpuFields", () => {
    const before: CpuSnapshot = {
        usageUs: 1_000_000,
        throttledPeriods: 3,
        throttledUs: 200_000,
        waitUs: 50_000,
        stealTicks: 10,
        totalTicks: 1000
    }

    it("turns deltas into rounded log fields", () => {
        const after: CpuSnapshot = {
            usageUs: 1_031_449,
            throttledPeriods: 5,
            throttledUs: 250_049,
            waitUs: 242_249,
            stealTicks: 11,
            totalTicks: 1300
        }

        expect(cpuFields(before, after)).toEqual({
            cpuMs: 31.4,
            throttledPeriods: 2,
            throttledMs: 50,
            cpuWaitMs: 192.2,
            stealPct: 0.33
        })
    })

    it("leaves out a field either snapshot lacks", () => {
        expect(cpuFields({ usageUs: 1 }, {})).toStrictEqual({})
        expect(cpuFields({}, { usageUs: 5 })).toStrictEqual({})
    })

    it("leaves out a counter that went backwards", () => {
        expect(
            cpuFields({ usageUs: 10, waitUs: 5 }, { usageUs: 5, waitUs: 9 })
        ).toEqual({ cpuWaitMs: 0 })
    })

    it("has no stealPct when no ticks passed", () => {
        expect(
            cpuFields(
                { stealTicks: 5, totalTicks: 100 },
                { stealTicks: 5, totalTicks: 100 }
            )
        ).toStrictEqual({})
    })
})

describe("readFileOrUndefined", () => {
    it("returns undefined for a missing file or a directory instead of throwing", () => {
        expect(readFileOrUndefined("/definitely/not/here")).toBeUndefined()
        expect(readFileOrUndefined("/")).toBeUndefined()
    })

    it.runIf(process.platform === "linux")(
        "reads real Linux counters without throwing",
        async () => {
            const counters = createCpuCounters(readFileOrUndefined)
            expect(counters.info.steal).toBe(true)

            const before = counters.snapshot()
            await new Promise((resolve) => setTimeout(resolve, 50))
            const fields = cpuFields(before, counters.snapshot())

            // The runner's cgroup setup isn't ours to pin; only check v2 hosts.
            expect(
                counters.info.cgroup !== "v2" || (fields.cpuMs ?? -1) >= 0
            ).toBe(true)
        }
    )
})
