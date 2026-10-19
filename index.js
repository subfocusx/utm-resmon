import os from 'node:os'
import v8 from 'node:v8'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  ROUTE_PATH,
  CACHE_MS,
  resolveAllowlist,
  defaultDeps,
  registerTools,
  collectSnapshot,
  createRouteHandler,
  registerRoute,
} from './src/plugin.js'

/**
 * utm-resmon — combined Cordis plugin (tools core + UI route).
 * Thin wiring over src/plugin.js (testable without a DSH profile).
 *
 * Phase 1 (tools, fits plugin/README §1 contract):
 *   resmon_snapshot — host totals: process.memoryUsage + v8 heap + os
 *   resmon_mcp      — MCP child processes: /proc scan, RSS per PID
 *   resmon_plugins  — in-process code sizes per plugin prefix (require.cache)
 *
 * Phase 2 (UI, sysmon pattern): same samplers served via GET /dsh-resmon,
 * polled by client.js chip in composer.dock.
 */
export const name = 'utm-resmon'

// Hard deps: tools for tool registration, webServer for the /dsh-resmon route
// (sysmon pattern — apply waits until webServer is mounted, so the route
// registration can't be skipped by load order).
export const inject = ['tools', 'webServer']

export function apply(ctx, config = {}) {
  const allowlist = resolveAllowlist(config)
  const deps = defaultDeps()
  const hostOpts = { osMod: os, proc: process, v8Mod: v8 }

  // ── Phase 1: tools ──────────────────────────────────────────────
  registerTools(ctx, defineTool, deps, allowlist)

  // ── Phase 2: UI route (sysmon pattern) ──────────────────────────
  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  if (webServer === undefined) {
    ctx.logger?.warn?.('[utm-resmon] webServer service absent; /dsh-resmon route not registered')
    return
  }
  const handler = createRouteHandler({
    collect: () => collectSnapshot(allowlist, { withMcp: true, withPlugins: true }, deps, hostOpts),
    cacheMs: CACHE_MS,
    log: ctx.logger ?? undefined,
  })
  registerRoute(ctx, webServer, handler)
}

export { ROUTE_PATH }
