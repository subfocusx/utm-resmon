import { strict as assert } from 'node:assert'
import { readFileSync as nodeReadFileSync } from 'node:fs'
import { collectHost } from '../src/hostStats.js'
import { scanMcp } from '../src/mcpScan.js'
import { summarizeRequireCache } from '../src/pluginSizes.js'
import { collectCgroup } from '../src/cgroup.js'
import { collectSnapshot } from '../src/plugin.js'

let pass = 0
async function ok(name, fn) {
  try {
    await fn()
    pass += 1
    console.log(`ok - ${name}`)
  } catch (e) {
    console.error(`FAIL - ${name}: ${e.message}`)
    process.exitCode = 1
  }
}

// ── hostStats: shape + injected doubles ──────────────────────────
await ok('hostStats returns rss/heap/system with injected modules', () => {
  const fakeOs = {
    totalmem: () => 16 * 1024 ** 3,
    freemem: () => 8 * 1024 ** 3,
    loadavg: () => [0.5, 0.7, 0.9],
    cpus: () => [{}, {}, {}, {}],
    uptime: () => 3700,
  }
  const fakeProc = {
    memoryUsage: () => ({ rss: 700_000_000, heapTotal: 400_000_000, heapUsed: 300_000_000, external: 10_000_000, arrayBuffers: 5_000_000 }),
    cpuUsage: () => ({ user: 1000, system: 500 }),
  }
  const fakeV8 = {
    getHeapStatistics: () => ({ total_heap_size: 1, used_heap_size: 2, heap_size_limit: 3, external_memory: 4, number_of_native_contexts: 5 }),
  }
  const s = collectHost({ osMod: fakeOs, proc: fakeProc, v8Mod: fakeV8 })
  assert.equal(s.rss, 700_000_000)
  assert.equal(s.system.percent, 50)
  assert.equal(s.system.cpus, 4)
  assert.equal(s.heapSpaces.usedHeapSize, 2)
})

await ok('hostStats survives missing v8', () => {
  const s = collectHost({ v8Mod: null })
  assert.equal(s.heapSpaces, null)
  assert.ok(typeof s.rss === 'number')
})

// ── mcpScan: fixture fs, no /proc needed ─────────────────────────
function fixtureFs() {
  const files = {
    '/proc/1/cmdline': 'dsh --profile web',
    '/proc/1/status': 'VmRSS:\t 700000 kB\n',
    '/proc/1/stat': '1 (dsh) S 0 0 0 0 0 0 0 0 0 0 100 50 0 0 0 0 0 0 0 0 0',
    '/proc/77/cmdline': 'npx -y chrome-devtools-mcp@latest',
    '/proc/77/status': 'VmRSS:\t 250000 kB\n',
    '/proc/77/stat': '77 (chrome-devtools) S 1 0 0 0 0 0 0 0 0 0 200 60 0 0 0 0 0 0 0 0 0',
    '/proc/99/cmdline': 'node /srv/app.js',
    '/proc/99/status': 'VmRSS:\t 90000 kB\n',
    '/proc/99/stat': '99 (app) S 1 0 0 0 0 0 0 0 0 0 10 5 0 0 0 0 0 0 0 0 0',
  }
  return {
    readDir: () => ['1', '77', '99', 'self', 'sys'],
    readFile: (p) => {
      if (p in files) return files[p]
      throw new Error('ENOENT ' + p)
    },
  }
}

await ok('mcpScan finds only mcp-matching processes, sorted by rss', () => {
  const { readDir, readFile } = fixtureFs()
  const out = scanMcp({ procRoot: '/proc', match: ['mcp'], readDir, readFile })
  assert.equal(out.length, 1)
  assert.equal(out[0].pid, 77)
  assert.equal(out[0].rssBytes, 250000 * 1024)
  assert.equal(out[0].utime, 200)
})

await ok('mcpScan custom allowlist matches chrome-devtools too', () => {
  const { readDir, readFile } = fixtureFs()
  const out = scanMcp({ procRoot: '/proc', match: ['chrome-devtools'], readDir, readFile })
  assert.equal(out.length, 1)
  assert.equal(out[0].pid, 77)
})

await ok('mcpScan returns [] when /proc unreadable', () => {
  const out = scanMcp({ readDir: () => { throw new Error('deny') } })
  assert.deepEqual(out, [])
})

// ── pluginSizes: fake cache + sizes ──────────────────────────────
await ok('pluginSizes groups by package prefix, desc', () => {
  const cache = {
    '/p/node_modules/billion-context/dist/a.js': {},
    '/p/node_modules/billion-context/dist/b.js': {},
    '/p/node_modules/zod/lib/c.js': {},
  }
  const sizes = { '/p/node_modules/billion-context/dist/a.js': 100, '/p/node_modules/billion-context/dist/b.js': 50, '/p/node_modules/zod/lib/c.js': 10 }
  const out = summarizeRequireCache({ cache, statSize: (f) => sizes[f] })
  assert.equal(out[0].prefix, 'billion-context')
  assert.equal(out[0].bytes, 150)
  assert.equal(out[0].files, 2)
  assert.equal(out[1].prefix, 'zod')
})

await ok('pluginSizes empty cache → []', () => {
  assert.deepEqual(summarizeRequireCache({ cache: {}, statSize: () => 1 }), [])
})

// ── mcpScan edge cases ───────────────────────────────────────────
await ok('mcpScan parses comm with spaces/parens via last ")"', () => {
  const files = {
    // comm = "my app (1)": fields after the LAST ')' → utime=300 stime=70
    '/proc/95/cmdline': 'my-mcp-server --port 1',
    '/proc/95/status': 'VmRSS:\t 10000 kB\n',
    '/proc/95/stat': '95 (my app (1)) S 1 0 0 0 0 0 0 0 0 0 300 70 0 0 0 0 0 0 0 0 0',
  }
  const out = scanMcp({
    procRoot: '/proc', match: ['mcp'],
    readDir: () => ['95'],
    readFile: (p) => { if (p in files) return files[p]; throw new Error('ENOENT') },
  })
  assert.equal(out.length, 1)
  assert.equal(out[0].utime, 300)
  assert.equal(out[0].stime, 70)
})

await ok('mcpScan keeps process with missing VmRSS (rssBytes null)', () => {
  const files = {
    '/proc/96/cmdline': 'mcp-proxy',
    '/proc/96/status': 'Name:\tmcp-proxy\nState:\tS (sleeping)\n',
    '/proc/96/stat': '96 (mcp-proxy) S 1 0 0 0 0 0 0 0 0 0 5 6 0 0 0 0 0 0 0 0 0',
  }
  const out = scanMcp({
    procRoot: '/proc', match: ['mcp'],
    readDir: () => ['96'],
    readFile: (p) => { if (p in files) return files[p]; throw new Error('ENOENT') },
  })
  assert.equal(out.length, 1)
  assert.equal(out[0].rssBytes, null)
  assert.equal(out[0].utime, 5)
})

await ok('mcpScan skips empty cmdline and empty match list', () => {
  const readFile = (p) => {
    if (p.endsWith('cmdline')) return '\0\0'
    throw new Error('ENOENT')
  }
  const out1 = scanMcp({ procRoot: '/proc', match: ['mcp'], readDir: () => ['97'], readFile })
  assert.deepEqual(out1, [])
  const fb = fixtureFs()
  assert.deepEqual(scanMcp({ procRoot: '/proc', match: [], readDir: fb.readDir, readFile: fb.readFile }), [])
})

// ── pluginSizes edge cases ───────────────────────────────────────
await ok('pluginSizes prefixes filter folds the rest into other:', () => {
  const cache = {
    '/p/node_modules/billion-context/dist/a.js': {},
    '/p/node_modules/zod/lib/c.js': {},
  }
  const out = summarizeRequireCache({ cache, statSize: () => 10, prefixes: ['billion-context'] })
  assert.equal(out[0].prefix, 'billion-context')
  assert.equal(out[1].prefix, 'other:zod')
})

await ok('pluginSizes top cuts groups, statSize throw counts 0', () => {
  const cache = {
    '/p/node_modules/a-big/x.js': {},
    '/p/node_modules/b-mid/y.js': {},
    '/p/node_modules/c-small/z.js': {},
  }
  const statSize = (f) => {
    if (f.includes('b-mid')) throw new Error('EPERM')
    return f.includes('a-big') ? 100 : 1
  }
  const out = summarizeRequireCache({ cache, statSize, top: 2 })
  assert.equal(out.length, 2)
  assert.equal(out[0].prefix, 'a-big')
  assert.equal(out[1].prefix, 'c-small') // 1 byte still outranks EPERM→0
  const all = summarizeRequireCache({ cache, statSize, top: 5 })
  assert.equal(all[2].prefix, 'b-mid')
  assert.equal(all[2].bytes, 0)
})

// ── hostStats edge cases ─────────────────────────────────────────
await ok('hostStats without proc.cpuUsage → cpuUsage null', () => {
  const s = collectHost({ proc: { memoryUsage: () => ({ rss: 1, heapTotal: 2, heapUsed: 3, external: 4, arrayBuffers: 5 }) } })
  assert.equal(s.cpuUsage, null)
  assert.equal(s.rss, 1)
})

// ── guarded live /proc (read-only, Linux only; skipped elsewhere) ─
await ok('live /proc scan returns array shape (skipped if no /proc)', () => {
  let probe = null
  try { probe = nodeReadFileSync('/proc/1/cmdline', 'utf8') } catch { probe = null }
  if (probe === null) { console.log('  (no /proc — live check skipped)'); return }
  assert.deepEqual(scanMcp({ match: ['__resmon_no_match_xyz__'] }), [])
  assert.ok(Array.isArray(scanMcp({ match: ['mcp'] })))
})

// ── cgroup: synthetic tree, no host FS needed ──────────────────────
function cgroupFs() {
  const files = {
    '/proc/self/cgroup': '0::/user.slice/app.slice/dsh-web.service\n',
    '/cg/user.slice/app.slice/dsh-web.service/memory.current': '763043840\n',
    '/cg/user.slice/app.slice/dsh-web.service/memory.peak': '766000000\n',
    '/cg/user.slice/app.slice/dsh-web.service/memory.stat': 'anon 734478336\nfile 7049216\nkernel 21270528\nsock 0\n',
  }
  return (path) => {
    if (!(path in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return files[path]
  }
}

await ok('cgroup parses total/peak/anon/file/kernel from synthetic tree', () => {
  const c = collectCgroup({ read: cgroupFs(), selfCgroupPath: '/proc/self/cgroup', fsRoot: '/cg' })
  assert.equal(c.totalBytes, 763043840)
  assert.equal(c.peakBytes, 766000000)
  assert.equal(c.anonBytes, 734478336)
  assert.equal(c.fileBytes, 7049216)
  assert.equal(c.kernelBytes, 21270528)
})

await ok('cgroup returns null when accounting is absent', () => {
  assert.equal(collectCgroup({ read: () => { throw new Error('ENOENT') } }), null)
  assert.equal(collectCgroup({ read: () => '1:name=systemd:/docker/abc\n' }), null) // cgroup v1 layout
  assert.equal(collectCgroup({ read: () => '0::/\n', fsRoot: '/nonexistent-xyz' }), null)
})

await ok('cgroup partial tree (no peak file) → peakBytes null, total set', () => {
  const files = {
    '/proc/self/cgroup': '0::/app.slice/dsh-web.service\n',
    '/cg/app.slice/dsh-web.service/memory.current': '100\n',
  }
  const read = (p) => {
    if (!(p in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return files[p]
  }
  const c = collectCgroup({ read, selfCgroupPath: '/proc/self/cgroup', fsRoot: '/cg' })
  assert.equal(c.totalBytes, 100)
  assert.equal(c.peakBytes, null)
  assert.equal(c.anonBytes, null)
})

await ok('cgroup garbage memory.current → null', () => {
  const read = (p) => (p === '/proc/self/cgroup' ? '0::/app.slice/x.service\n' : 'not-a-number\n')
  assert.equal(collectCgroup({ read, selfCgroupPath: '/proc/self/cgroup', fsRoot: '/cg' }), null)
})

// ── collectSnapshot wiring (injected doubles, no DSH) ──────────────
function snapshotDeps(extra = {}) {
  return {
    collectHostFn: () => ({ rss: 1 }),
    scanMcpFn: () => [{ pid: 1 }],
    summarizeFn: () => [{ prefix: 'x' }],
    collectCgroupFn: () => ({ totalBytes: 2 }),
    ...extra,
  }
}

await ok('snapshot with legacy deps (no collectCgroupFn) → cgroup null', async () => {
  const { collectCgroupFn: _drop, ...legacy } = snapshotDeps()
  const s = await collectSnapshot([], { withMcp: true, withPlugins: true }, legacy)
  assert.equal(s.cgroup, null)
})

await ok('snapshot slim mode omits mcp/plugins keys but still carries cgroup', async () => {
  const s = await collectSnapshot([], { withMcp: false, withPlugins: false }, snapshotDeps())
  assert.equal(s.mcp, undefined) // slim = token economy; client guards with (d.mcp || [])
  assert.equal(s.plugins, undefined)
  assert.equal(s.cgroup.totalBytes, 2)
})

console.log(`\n${pass} tests passed${process.exitCode ? ' (with failures)' : ''}`)
