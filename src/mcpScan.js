import { readdirSync, readFileSync } from 'node:fs'

/**
 * MCP child-process scanner (Linux /proc only, zero subprocesses).
 *
 * MCP stdio servers (dsh-mcp-client spawns them via child_process.spawn)
 * are SEPARATE OS processes, so each has its own RSS — unlike in-process
 * Cordis plugins sharing one V8 heap. We find them by scanning /proc/<pid>/
 * cmdline for match substrings (default: 'mcp'), then read VmRSS from
 * /proc/<pid>/status and CPU ticks from /proc/<pid>/stat.
 *
 * All fs access is injectable → unit-testable with fixtures, no /proc needed.
 * On non-Linux / EPERM returns [] (never throws).
 *
 * @returns [{ pid, cmd, rssBytes, utime, stime }]
 */
export function scanMcp({
  procRoot = '/proc',
  match = ['mcp'],
  readDir = readdirSync,
  readFile = readFileSync,
} = {}) {
  const needles = (Array.isArray(match) ? match : [match])
    .filter((s) => typeof s === 'string' && s.length > 0)
    .map((s) => s.toLowerCase())
  if (needles.length === 0) return []
  let entries
  try {
    entries = readDir(procRoot)
  } catch {
    return []
  }
  const out = []
  for (const name of entries) {
    if (!/^\d+$/.test(String(name))) continue
    const pid = Number(name)
    let cmdline
    try {
      cmdline = readFile(`${procRoot}/${pid}/cmdline`, 'utf8')
    } catch {
      continue
    }
    const cmd = String(cmdline).replace(/\0/g, ' ').trim()
    if (!cmd) continue
    if (!needles.some((n) => cmd.toLowerCase().includes(n))) continue
    out.push({
      pid,
      cmd: cmd.slice(0, 300),
      rssBytes: readVmRss(procRoot, pid, readFile),
      ...readCpuTicks(procRoot, pid, readFile),
    })
  }
  out.sort((a, b) => (b.rssBytes ?? 0) - (a.rssBytes ?? 0))
  return out
}

function readVmRss(procRoot, pid, readFile) {
  try {
    const status = readFile(`${procRoot}/${pid}/status`, 'utf8')
    const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(status)
    return m ? Number(m[1]) * 1024 : null
  } catch {
    return null
  }
}

function readCpuTicks(procRoot, pid, readFile) {
  try {
    // /proc/<pid>/stat: comm may contain spaces/parens → cut after last ')'.
    const stat = readFile(`${procRoot}/${pid}/stat`, 'utf8')
    const after = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)
    // fields after comm: state(0) ppid(1) ... utime(11) stime(12) (0-based)
    const utime = Number(after[11])
    const stime = Number(after[12])
    return {
      utime: Number.isFinite(utime) ? utime : null,
      stime: Number.isFinite(stime) ? stime : null,
    }
  } catch {
    return { utime: null, stime: null }
  }
}
