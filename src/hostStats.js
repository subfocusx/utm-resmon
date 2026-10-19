import os from 'node:os'

/**
 * Host totals sampler. Only Node builtins, no subprocesses.
 * os/process/v8 are injectable so tests run without a host.
 * Returns a JSON-serializable snapshot.
 */
export function collectHost({ osMod = os, proc = process, v8Mod = null } = {}) {
  const mem = proc.memoryUsage()
  let heapSpaces = null
  if (v8Mod && typeof v8Mod.getHeapStatistics === 'function') {
    try {
      const s = v8Mod.getHeapStatistics()
      heapSpaces = {
        totalHeapSize: s.total_heap_size,
        usedHeapSize: s.used_heap_size,
        heapSizeLimit: s.heap_size_limit,
        externalMemory: s.external_memory,
        numberOfNativeContexts: s.number_of_native_contexts,
      }
    } catch {
      heapSpaces = null
    }
  }
  const total = osMod.totalmem()
  const free = osMod.freemem()
  return {
    rss: mem.rss,
    heapTotal: mem.heapTotal,
    heapUsed: mem.heapUsed,
    external: mem.external,
    arrayBuffers: mem.arrayBuffers,
    heapSpaces,
    system: {
      totalBytes: total,
      freeBytes: free,
      percent: total > 0 ? round1(((total - free) / total) * 100) : 0,
      loadavg: osMod.loadavg().map(round2),
      cpus: osMod.cpus().length,
      uptimeSeconds: Math.floor(osMod.uptime()),
    },
    cpuUsage: typeof proc.cpuUsage === 'function' ? proc.cpuUsage() : null,
  }
}

function round1(v) { return Math.round(v * 10) / 10 }
function round2(v) { return Math.round(v * 100) / 100 }
