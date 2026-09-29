import { readFileSync } from "node:fs"

const CGROUP_ROOT = "/sys/fs/cgroup"

export type ReadFile = (path: string) => string | undefined

// Never throws: a missing or unreadable file reads as undefined.
export const readFileOrUndefined: ReadFile = (path) => {
    try {
        return readFileSync(path, "utf8")
    } catch {
        return undefined
    }
}

// Cumulative counters. A field is undefined when its source is unavailable.
export type CpuSnapshot = {
    usageUs?: number
    throttledPeriods?: number
    throttledUs?: number
    waitUs?: number
    stealTicks?: number
    totalTicks?: number
}

export type CpuSourceInfo = {
    cgroup: "v2" | "other" | "none"
    cpuLimit: number | null
    cpuPressure: boolean
    steal: boolean
    nodeCpus: number | null
}

export type CpuCounters = {
    info: CpuSourceInfo
    snapshot: () => CpuSnapshot
}

const USAGE_USEC = /^usage_usec (\d+)$/m
const NR_THROTTLED = /^nr_throttled (\d+)$/m
const THROTTLED_USEC = /^throttled_usec (\d+)$/m
const PRESSURE_SOME_TOTAL = /^some .*\btotal=(\d+)$/m
const WHITESPACE = /\s+/
const PER_CPU_LINE = /^cpu\d+ /gm

const matchNumber = (pattern: RegExp, text: string) => {
    const match = pattern.exec(text)
    return match ? Number(match[1]) : undefined
}

// The aggregate "cpu" line: user nice system idle iowait irq softirq steal
// guest guest_nice, in clock ticks. guest and guest_nice are already inside
// user and nice, so the total stops at steal.
const procStatTicks = (text: string) => {
    const line = text.slice(0, text.indexOf("\n"))
    const values = line.trim().split(WHITESPACE)
    if (values[0] !== "cpu" || values.length < 9) {
        return undefined
    }
    const ticks = values.slice(1, 9).map(Number)
    if (ticks.some((value) => !Number.isFinite(value))) {
        return undefined
    }
    return {
        stealTicks: ticks[7],
        totalTicks: ticks.reduce((sum, value) => sum + value, 0)
    }
}

// cpu.max is "<quota> <period>" or "max <period>".
const cpuLimit = (text: string | undefined) => {
    const [quota, period] = (text ?? "").trim().split(WHITESPACE)
    const limit = Number(quota) / Number(period)
    return Number.isFinite(limit) && limit > 0 ? limit : null
}

// This process's cgroup v2 directory. In a container with its own cgroup
// namespace /proc/self/cgroup reads "0::/" and the files sit at the root. With
// the host's namespace the path is appended; if that directory can't be read,
// give up rather than read the root, which would be the whole machine.
function findCgroupDir(readFile: ReadFile) {
    const self = readFile("/proc/self/cgroup")
    if (self === undefined) {
        return { cgroup: "none" as const }
    }
    const line = self.split("\n").find((entry) => entry.startsWith("0::"))
    if (
        line === undefined ||
        readFile(`${CGROUP_ROOT}/cgroup.controllers`) === undefined
    ) {
        return { cgroup: "other" as const }
    }
    const path = line.slice(3).trim()
    const dir = path === "/" ? CGROUP_ROOT : `${CGROUP_ROOT}${path}`
    return readFile(`${dir}/cpu.stat`) === undefined
        ? { cgroup: "other" as const }
        : { cgroup: "v2" as const, dir }
}

export function createCpuCounters(readFile: ReadFile): CpuCounters {
    const found = findCgroupDir(readFile)
    const dir = "dir" in found ? found.dir : undefined
    const pressurePath = dir && `${dir}/cpu.pressure`
    const pressureText = pressurePath ? readFile(pressurePath) : undefined
    const hasPressure =
        pressureText !== undefined &&
        matchNumber(PRESSURE_SOME_TOTAL, pressureText) !== undefined
    const procStat = readFile("/proc/stat")
    const hasSteal =
        procStat !== undefined && procStatTicks(procStat) !== undefined

    const info: CpuSourceInfo = {
        cgroup: found.cgroup,
        cpuLimit: dir ? cpuLimit(readFile(`${dir}/cpu.max`)) : null,
        cpuPressure: hasPressure,
        steal: hasSteal,
        nodeCpus: procStat
            ? (procStat.match(PER_CPU_LINE)?.length ?? null)
            : null
    }

    const snapshot = (): CpuSnapshot => {
        const result: CpuSnapshot = {}
        const stat = dir ? readFile(`${dir}/cpu.stat`) : undefined
        if (stat !== undefined) {
            result.usageUs = matchNumber(USAGE_USEC, stat)
            result.throttledPeriods = matchNumber(NR_THROTTLED, stat)
            result.throttledUs = matchNumber(THROTTLED_USEC, stat)
        }
        if (hasPressure && pressurePath) {
            const pressure = readFile(pressurePath)
            result.waitUs =
                pressure === undefined
                    ? undefined
                    : matchNumber(PRESSURE_SOME_TOTAL, pressure)
        }
        if (hasSteal) {
            const text = readFile("/proc/stat")
            const ticks = text === undefined ? undefined : procStatTicks(text)
            result.stealTicks = ticks?.stealTicks
            result.totalTicks = ticks?.totalTicks
        }
        return result
    }

    return { info, snapshot }
}

const round1 = (value: number) => Math.round(value * 10) / 10
const round2 = (value: number) => Math.round(value * 100) / 100

// Log fields for the change between two snapshots. A field is left out when
// either side lacks it or the counter went backwards; stealPct is also left
// out when no ticks passed.
export function cpuFields(previous: CpuSnapshot, current: CpuSnapshot) {
    const diff = (key: keyof CpuSnapshot) => {
        const before = previous[key]
        const after = current[key]
        return before !== undefined && after !== undefined && after >= before
            ? after - before
            : undefined
    }
    const fields: {
        cpuMs?: number
        throttledPeriods?: number
        throttledMs?: number
        cpuWaitMs?: number
        stealPct?: number
    } = {}
    const usage = diff("usageUs")
    if (usage !== undefined) {
        fields.cpuMs = round1(usage / 1000)
    }
    const periods = diff("throttledPeriods")
    if (periods !== undefined) {
        fields.throttledPeriods = periods
    }
    const throttled = diff("throttledUs")
    if (throttled !== undefined) {
        fields.throttledMs = round1(throttled / 1000)
    }
    const wait = diff("waitUs")
    if (wait !== undefined) {
        fields.cpuWaitMs = round1(wait / 1000)
    }
    const steal = diff("stealTicks")
    const total = diff("totalTicks")
    if (steal !== undefined && total) {
        fields.stealPct = round2((100 * steal) / total)
    }
    return fields
}
