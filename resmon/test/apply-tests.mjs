import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Test-first target: src/plugin.js does not exist yet → this file MUST fail
// until the apply/route logic is extracted from index.js into testable units.
import {
  ROUTE_PATH,
  CACHE_MS,
  DEFAULT_MCP_MATCH,
  resolveAllowlist,
  buildToolDefs,
  registerTools,
  createRouteHandler,
  collectSnapshot,
} from '../src/plugin.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

let pass = 0
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass += 1; console.log(`ok - ${name}`) })
    .catch((e) => { console.error(`FAIL - ${name}: ${e.message}`); process.exitCode = 1 })
}

// Fakes: no DSH profile, no /proc, no network.
const fakeDefineTool = (d) => ({ ...d, __fake: true })
const fakeHost = { rss: 700_000_000, heapUsed: 1, system: { percent: 50 } }
const fakeDeps = {
  collectHostFn: () => fakeHost,
  scanMcpFn: ({ match } = {}) => [{ pid: 77, cmd: 'mcp-server', rssBytes: 123, matchSeen: match }],
  summarizeFn: ({ top } = {}) => [{ prefix: 'billion-context', files: 2, bytes: 150, topSeen: top }],
  collectCgroupFn: () => ({ totalBytes: 760_000_000, peakBytes: 770_000_000, anonBytes: 700_000_000, fileBytes: 7_000_000, kernelBytes: 21_000_000 }),
  osMod: null, proc: null, v8Mod: null,
}
function mockCtx({ webServer = { register() {} } } = {}) {
  const registered = []
  const warned = []
  return {
    ctx: {
      tools: { register: (d) => registered.push(d) },
      get: (k) => (k === 'webServer' ? webServer : undefined),
      effect: (fn) => fn(),
      logger: { warn: (m) => warned.push(m) },
    },
    registered, warned,
  }
}

await ok('resolveAllowlist: default on empty config', () => {
  assert.deepEqual(resolveAllowlist({}), DEFAULT_MCP_MATCH)
  assert.deepEqual(resolveAllowlist(), DEFAULT_MCP_MATCH)
  assert.deepEqual(resolveAllowlist({ mcpMatch: [] }), DEFAULT_MCP_MATCH)
})

await ok('resolveAllowlist: custom config wins', () => {
  assert.deepEqual(resolveAllowlist({ mcpMatch: ['chrome-devtools'] }), ['chrome-devtools'])
})

await ok('registerTools registers exactly the 3 resmon_* tools', () => {
  const { ctx, registered } = mockCtx()
  const names = registerTools(ctx, fakeDefineTool, fakeDeps)
  assert.deepEqual(names, ['resmon_snapshot', 'resmon_mcp', 'resmon_plugins'])
  assert.deepEqual(registered.map((d) => d.name), names)
})

await ok('resmon_snapshot execute returns host totals (injected, no /proc)', async () => {
  const { registered } = mockCtx()
  registerTools({ tools: { register: (d) => registered.push(d) } }, fakeDefineTool, fakeDeps)
  const snap = registered.find((d) => d.name === 'resmon_snapshot')
  const out = await snap.execute({})
  assert.equal(out.ok, true)
  assert.equal(out.host.rss, 700_000_000)
  assert.ok(typeof out.sampledAt === 'number')
})

await ok('resmon_mcp execute forwards allowlist to scanner', async () => {
  const { registered } = mockCtx()
  registerTools({ tools: { register: (d) => registered.push(d) } }, fakeDefineTool, fakeDeps)
  const def = registered.find((d) => d.name === 'resmon_mcp')
  const out = await def.execute({})
  assert.equal(out.ok, true)
  assert.deepEqual(out.mcp[0].matchSeen, DEFAULT_MCP_MATCH)
})

await ok('resmon_plugins execute honors top arg', async () => {
  const { registered } = mockCtx()
  registerTools({ tools: { register: (d) => registered.push(d) } }, fakeDefineTool, fakeDeps)
  const def = registered.find((d) => d.name === 'resmon_plugins')
  const out = await def.execute({ top: 3 })
  assert.equal(out.plugins[0].topSeen, 3)
})

// Behavioral, not truthy: parameters must be a flat property map of value
// schemas (DSH 0.2.0 dsh-tools) or the loader fails with UNSUPPORTED_SCHEMA
// (repo README §1). Output schemas stay classic JSON Schema.
const ALLOWED_VALUE_KEYS = new Set([
  'type', 'required', 'description', 'title', 'default', 'examples', 'enum', 'const',
])
const ALLOWED_VALUE_TYPES = new Set(['string', 'integer', 'number', 'boolean'])
const ALLOWED_SCHEMA_KEYS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items',
  'enum', 'const', 'oneOf', 'description', 'title', 'default', 'examples',
])
function assertValueSchema(node, path) {
  assert.equal(typeof node, 'object', `${path} must be a value schema object`)
  for (const key of Object.keys(node)) {
    assert.ok(ALLOWED_VALUE_KEYS.has(key), `${path}: unsupported value-schema key "${key}"`)
  }
  if (node.type !== undefined) {
    assert.ok(ALLOWED_VALUE_TYPES.has(node.type), `${path}: unsupported value type "${node.type}"`)
  }
}
function assertSchemaSubset(node, path) {
  assert.equal(typeof node, 'object', `${path} must be an object schema`)
  for (const key of Object.keys(node)) {
    assert.ok(ALLOWED_SCHEMA_KEYS.has(key), `${path}: unsupported schema key "${key}"`)
  }
  if (node.properties) {
    for (const [k, v] of Object.entries(node.properties)) assertSchemaSubset(v, `${path}.${k}`)
  }
  if (node.items && typeof node.items === 'object') assertSchemaSubset(node.items, `${path}[]`)
}

await ok('all tool defs use only supported JSON Schema keys', () => {
  for (const def of buildToolDefs({ defineTool: fakeDefineTool, deps: fakeDeps, allowlist: DEFAULT_MCP_MATCH })) {
    // parameters: flat property map, never a {type:'object'} wrapper.
    assert.equal(typeof def.parameters, 'object', `${def.name}.parameters must be a property map`)
    assert.equal(def.parameters.type, undefined, `${def.name}.parameters must not be a JSON-Schema object`)
    for (const [k, v] of Object.entries(def.parameters)) assertValueSchema(v, `${def.name}.parameters.${k}`)
    assertSchemaSubset(def.output.schema, `${def.name}.output.schema`)
    assert.equal(typeof def.execute, 'function', `${def.name} must have execute`)
  }
})

function fakeRes() {
  return { status: null, headers: null, body: null,
    writeHead(s, h) { this.status = s; this.headers = h },
    end(b) { this.body = b } }
}

await ok('route handler serves snapshot JSON with no-store', async () => {
  let calls = 0
  const handler = createRouteHandler({ collect: async () => { calls += 1; return { ok: true } }, cacheMs: CACHE_MS })
  const res = fakeRes()
  await handler({}, res)
  assert.equal(res.status, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.deepEqual(JSON.parse(res.body), { ok: true })
  assert.equal(calls, 1)
})

await ok('route handler caches within TTL (collect called once)', async () => {
  let calls = 0
  const handler = createRouteHandler({ collect: async () => { calls += 1; return { ok: true, n: calls } }, cacheMs: 60_000 })
  const r1 = fakeRes(); await handler({}, r1)
  const r2 = fakeRes(); await handler({}, r2)
  assert.equal(calls, 1)
  assert.equal(JSON.parse(r1.body).n, 1)
  assert.equal(JSON.parse(r2.body).n, 1)
})

await ok('route handler maps collect failure to 500 {ok:false}', async () => {
  const handler = createRouteHandler({ collect: async () => { throw new Error('boom') }, cacheMs: 0 })
  const res = fakeRes()
  await handler({}, res)
  assert.equal(res.status, 500)
  assert.equal(JSON.parse(res.body).ok, false)
})

await ok('route handler reports collect failure to the log sink', async () => {
  const errors = []
  const handler = createRouteHandler({
    collect: async () => { throw new Error('boom') },
    cacheMs: 0,
    log: { error: (m) => errors.push(m) },
  })
  const res = fakeRes()
  await handler({}, res)
  assert.equal(res.status, 500)
  assert.equal(errors.length, 1)
  assert.ok(errors[0].includes('[utm-resmon]') && errors[0].includes('boom'))
})

await ok('collectSnapshot composes host+mcp+plugins with flags', async () => {
  const full = await collectSnapshot(DEFAULT_MCP_MATCH, { withMcp: true, withPlugins: true }, fakeDeps)
  assert.equal(full.ok, true)
  assert.equal(full.host.rss, 700_000_000)
  assert.equal(full.mcp.length, 1)
  assert.equal(full.plugins.length, 1)
  assert.equal(full.cgroup.totalBytes, 760_000_000)
  const slim = await collectSnapshot(DEFAULT_MCP_MATCH, { withMcp: false, withPlugins: false }, fakeDeps)
  assert.equal(slim.mcp, undefined)
  assert.equal(slim.plugins, undefined)
})

await ok('contract: ROUTE_PATH shared by route core and client.js', () => {
  const indexSrc = readFileSync(join(root, 'index.js'), 'utf8')
  const clientSrc = readFileSync(join(root, 'client.js'), 'utf8')
  // index.js is not importable outside a DSH profile (dsh-tools peer dep),
  // so verify the wiring by text: it must re-export ROUTE_PATH from the core.
  assert.ok(indexSrc.includes('ROUTE_PATH'), 'index.js must re-export the shared ROUTE_PATH')
  // client.js polls the same literal path the route registers.
  assert.ok(clientSrc.includes(ROUTE_PATH), `client.js must poll ${ROUTE_PATH}`)
  assert.ok(clientSrc.includes('__ModuleLoader__'), 'client.js must use the __ModuleLoader__ bundle pattern')
  // Reference client API (sysmon): slot via inject+register, polling via the
  // timer service — guards regressions back to setInterval/wrong register.
  assert.ok(clientSrc.includes("ctx.slots.inject('conversation.composer.dock'"), 'client.js must inject into conversation.composer.dock')
  assert.ok(clientSrc.includes('ctx.interval('), 'client.js must poll via the ctx.interval timer service')
  assert.ok(clientSrc.includes('exports.apply = apply'), 'client.js must export apply like sysmon')
  // Icon + HoverCard breakdown (m00484, m00555): guarded primitives require
  // with a sysmon-style fallback — guards regressions to an unguarded require
  // (which would break the whole client bundle when the module is absent).
  // The marker is a bespoke SVG (m00555: the gauge icon already means token
  // speed elsewhere — it must never come back). The card is inline preview
  // (m00593: variant="preview" derives its width from the anchor width and
  // collapses a dock chip into a ~2px strip; plain compact opens right of
  // the anchor and runs off-window from a dock-edge anchor).
  assert.ok(clientSrc.includes('HoverCard'), 'client.js must render the breakdown via HoverCard')
  assert.ok(clientSrc.includes('dsh-client-ui-primitives'), 'client.js must source HoverCard from dsh-client-ui-primitives')
  assert.ok(!clientSrc.includes('IconGaugeOutlineRegular'), 'client.js must NOT use the gauge icon (means token speed)')
  assert.ok(clientSrc.includes('MemIcon'), 'client.js must render the bespoke memory-bars marker')
  assert.ok(clientSrc.includes('inline: true'), 'client.js must use the inline preview so the card stays inside the viewport')
  assert.ok(!clientSrc.includes("variant: 'preview'"), 'client.js must NOT use variant preview (2px-strip regression)')
  assert.ok(clientSrc.includes('textOverflow'), 'client.js rows must ellipsize long process names')
  // Attribution tree (m00670): family total in the head, compact rows with
  // disclosure arrows, plugin rows honestly marked as on-disk sizes.
  assert.ok(clientSrc.includes('PanelNode'), 'client.js must render expandable attribution rows')
  assert.ok(clientSrc.includes('GLYPH_CLOSED'), 'client.js rows must carry a disclosure arrow')
  assert.ok(clientSrc.includes('cgroup'), 'client.js head must show the cgroup family total')
  assert.ok(clientSrc.includes('onDisk'), 'client.js plugin rows must be marked as on-disk sizes')
  assert.ok(clientSrc.includes('chipTotal'), 'client.js chip must show the family total, not host RSS alone')
  // Disclosure rows: expandable with detail lines, and the head falls back
  // to host RSS where cgroup accounting is absent (non-Linux).
  assert.ok(clientSrc.includes('onToggle'), 'client.js rows must be expandable via onToggle')
  assert.ok(clientSrc.includes('GLYPH_OPEN'), 'client.js expanded rows must swap the disclosure arrow')
  assert.ok(clientSrc.includes('DetailLine'), 'client.js expanded rows must show detail lines')
  assert.ok(clientSrc.includes('d.host && d.host.rss'), 'client.js head must fall back to host RSS without cgroup')
})

await ok('contract: client primitives declared in package.json', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const inject = (pkg.dsh && pkg.dsh.client && pkg.dsh.client.inject) || []
  assert.ok(inject.includes('@deepseek-ai/dsh-client-ui-primitives'),
    'dsh.client.inject must list dsh-client-ui-primitives or the HoverCard require throws in the client graph')
  assert.ok(pkg.peerDependencies && pkg.peerDependencies['@deepseek-ai/dsh-client-ui-primitives'],
    'peerDependencies must cover dsh-client-ui-primitives or the loader gate disables the plugin')
})

console.log(`\n${pass} apply/route tests passed${process.exitCode ? ' (with failures)' : ''}`)
