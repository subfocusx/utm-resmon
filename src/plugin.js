import { collectHost } from './hostStats.js'
import { scanMcp } from './mcpScan.js'
import { summarizeRequireCache } from './pluginSizes.js'
import { collectCgroup } from './cgroup.js'

/**
 * Testable core of utm-resmon (extracted from index.js so it loads without
 * a DSH profile — only Node builtins + injected doubles).
 *
 * index.js stays a thin wiring layer: real defineTool + real samplers.
 * test/apply-tests.mjs covers this module with mock ctx/samplers.
 */
export const ROUTE_PATH = '/dsh-resmon'
export const CACHE_MS = 5000
export const DEFAULT_MCP_MATCH = ['mcp', 'chrome-devtools']

export const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }

export function renderResult(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2).slice(0, 20_000) }]
}

export function resolveAllowlist(config = {}) {
  const m = config?.mcpMatch
  return Array.isArray(m) && m.length > 0 ? m : DEFAULT_MCP_MATCH
}

export function defaultDeps() {
  return {
    collectHostFn: (opts) => collectHost(opts),
    scanMcpFn: (opts) => scanMcp(opts),
    summarizeFn: (opts) => summarizeRequireCache(opts),
    collectCgroupFn: (opts) => collectCgroup(opts),
  }
}

/** Pure tool definitions (no ctx) — also used for schema-subset checks.
 * NOTE (DSH 0.2.0 dsh-tools): `parameters` is a flat property map
 * ({name: value-schema}), NOT a JSON-Schema object. JSON-Schema style
 * ({type:'object', properties, ...}) fails with UNSUPPORTED_SCHEMA
 * ("parameters.type must be a value schema object"). */
export function buildToolDefs({ defineTool, deps, allowlist }) {
  return [
    defineTool({
      name: 'resmon_snapshot',
      description: 'Host process totals: rss/heapUsed/external/arrayBuffers, v8 heap spaces, os mem/load. No args.',
      parameters: {},
      output: { schema: OUTPUT_SCHEMA, render: renderResult },
      execute: async () => collectSnapshot(allowlist, { withMcp: false, withPlugins: false }, deps),
    }),
    defineTool({
      name: 'resmon_mcp',
      description: 'MCP server child processes (separate OS processes): pid, command, RSS, CPU ticks. Linux /proc only.',
      parameters: {},
      output: { schema: OUTPUT_SCHEMA, render: renderResult },
      execute: async () => ({ ok: true, mcp: deps.scanMcpFn({ match: allowlist }) }),
    }),
    defineTool({
      name: 'resmon_plugins',
      description: 'In-process plugin code sizes grouped by package prefix (require.cache file sizes). Disk bytes, not heap retained.',
      parameters: {
        top: { type: 'integer', description: 'How many groups to return' },
      },
      output: { schema: OUTPUT_SCHEMA, render: renderResult },
      execute: async (args) => ({
        ok: true,
        plugins: deps.summarizeFn({ top: args?.top ?? 15 }),
      }),
    }),
  ]
}

/** Register defs on a (possibly mocked) ctx.tools; returns tool names. */
export function registerTools(ctx, defineTool, deps, allowlist = DEFAULT_MCP_MATCH) {
  const names = []
  if (ctx?.tools && typeof ctx.tools.register === 'function') {
    for (const def of buildToolDefs({ defineTool, deps, allowlist })) {
      ctx.tools.register(def)
      names.push(def.name)
    }
  }
  return names
}

export async function collectSnapshot(allowlist, { withMcp, withPlugins }, deps, hostOpts = null) {
  return {
    ok: true,
    sampledAt: Date.now(),
    host: deps.collectHostFn(hostOpts ?? undefined),
    // Family total: always attempted, null where cgroup accounting is absent
    // (non-Linux, no permission). Client falls back to host RSS as the head.
    cgroup: deps.collectCgroupFn ? deps.collectCgroupFn() : null,
    mcp: withMcp ? deps.scanMcpFn({ match: allowlist }) : undefined,
    plugins: withPlugins ? deps.summarizeFn({ top: 15 }) : undefined,
  }
}

/** Route handler with TTL cache (sysmon pattern). Returns handler only.
 * `log` is an optional ctx.logger-compatible sink; collect failures are
 * reported there and still served as 500 {ok:false}. */
export function createRouteHandler({ collect, cacheMs = CACHE_MS, log = null }) {
  let cache = { at: 0, value: null }
  return async function handler(_req, res) {
    try {
      const now = Date.now()
      if (cache.value === null || now - cache.at >= cacheMs) {
        cache = { at: now, value: await collect() }
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(cache.value))
    } catch (error) {
      try {
        log?.error?.(`[utm-resmon] snapshot collect failed: ${error?.message ?? error}`)
      } catch {}
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
    }
  }
}

/** Mount the route on a (possibly mocked) webServer via ctx.effect. */
export function registerRoute(ctx, webServer, handler) {
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler,
  }))
}
