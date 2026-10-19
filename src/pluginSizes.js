import { statSync } from 'node:fs'
import { createRequire } from 'node:module'

/**
 * In-process plugin code-size estimator.
 *
 * Cordis plugins inside the dsh host share ONE V8 heap, so per-plugin RSS
 * does not exist at OS level. This is the honest coarse proxy: group
 * require.cache entries by package prefix and sum on-disk file sizes.
 * It measures CODE SIZE, not heap retained size — a 150MB dist/ does not
 * mean 150MB retained, but it ranks suspects (e.g. billion-context).
 *
 * require.cache is ESM-invisible; in the dsh host (CJS-interop loader)
 * most plugin files still land in require.cache. Entries missing from the
 * cache are simply not counted — documented limitation, not an error.
 *
 * @returns [{ prefix, files, bytes }] sorted desc, cut at top
 */
export function summarizeRequireCache({
  cache = getRequireCache(),
  statSize = defaultStatSize,
  prefixes = null,
  top = 15,
} = {}) {
  const names = Object.keys(cache ?? {})
  if (names.length === 0) return []
  const groups = new Map()
  for (const file of names) {
    const prefix = prefixOf(file, prefixes)
    let size = 0
    try {
      size = statSize(file) ?? 0
    } catch {
      size = 0
    }
    const g = groups.get(prefix) ?? { prefix, files: 0, bytes: 0 }
    g.files += 1
    g.bytes += size
    groups.set(prefix, g)
  }
  return [...groups.values()].sort((a, b) => b.bytes - a.bytes).slice(0, top)
}

/** Map a filename to a group: node_modules/<pkg> or (node) builtin / other. */
function prefixOf(file, prefixes) {
  const m = /node_modules[\\/](@[^\\/]+[\\/][^\\/]+|[^\\/]+)/.exec(file)
  if (m) {
    const pkg = m[1].replace(/\\/g, '/')
    if (!prefixes || prefixes.some((p) => pkg === p || pkg.startsWith(p))) return pkg
    return `other:${pkg}`
  }
  if (file.startsWith('node:')) return '(node-builtin)'
  return '(other)'
}

function defaultStatSize(file) {
  return statSync(file).size
}

function getRequireCache() {
  try {
    return createRequire(import.meta.url).cache ?? {}
  } catch {
    return {}
  }
}
