import { readFileSync } from 'node:fs'

/**
 * cgroup v2 family-total sampler (Linux only, null-safe everywhere else).
 *
 * Why: process.memoryUsage().rss covers ONE process, but the DSH service
 * family = host + MCP children (+ kernel share). The service cgroup's
 * memory.current is the only number that matches "what the OS charged us".
 * Found via /proc/self/cgroup ("0::/<path>"), read under /sys/fs/cgroup.
 *
 * All FS access is injectable so tests use a synthetic tree.
 *
 * @returns { totalBytes, peakBytes, anonBytes, fileBytes, kernelBytes }
 *          or null when cgroup accounting is unavailable.
 */
export function collectCgroup({
  read = defaultRead,
  selfCgroupPath = '/proc/self/cgroup',
  fsRoot = '/sys/fs/cgroup',
} = {}) {
  let rel
  try {
    const cg = read(selfCgroupPath)
    const m = /^0::(.*)$/m.exec(cg)
    if (!m) return null
    rel = m[1].trim()
    if (!rel) return null
  } catch {
    return null
  }
  const dir = fsRoot + rel
  try {
    const total = parseNum(read(dir + '/memory.current'))
    if (total === null) return null
    return {
      totalBytes: total,
      // Peak is nice-to-have: a missing memory.peak must not void the total.
      peakBytes: parseNum(safeRead(read, dir + '/memory.peak')),
      ...parseStat(safeRead(read, dir + '/memory.stat')),
    }
  } catch {
    return null
  }
}

function safeRead(read, path) {
  try {
    return read(path)
  } catch {
    return ''
  }
}

function parseNum(s) {
  if (typeof s !== 'string') return null
  const t = s.trim()
  if (!t) return null // absent file (safeRead '') is "unknown", never 0
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

/** Pick the three load-bearing counters out of memory.stat. */
function parseStat(stat) {
  const out = { anonBytes: null, fileBytes: null, kernelBytes: null }
  if (typeof stat !== 'string') return out
  for (const line of stat.split('\n')) {
    const [k, v] = line.split(' ')
    if (k === 'anon') out.anonBytes = parseNum(v)
    else if (k === 'file') out.fileBytes = parseNum(v)
    else if (k === 'kernel') out.kernelBytes = parseNum(v)
  }
  return out
}

function defaultRead(path) {
  return readFileSync(path, 'utf8')
}
