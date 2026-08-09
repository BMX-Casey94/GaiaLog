#!/usr/bin/env npx tsx
/**
 * Probe public explorer API routes for HTTP / JSON failures.
 *
 * Usage (on the VPS, with gaialog-web up):
 *   npx tsx scripts/check-explorer-apis.ts
 *   npx tsx scripts/check-explorer-apis.ts http://127.0.0.1:3000
 *
 * Exit code 1 if any probe fails (non-2xx, non-JSON, or success:false).
 */

const BASE = (process.argv[2] || process.env.GAIALOG_PUBLIC_BASE || 'http://127.0.0.1:3000').replace(
  /\/$/,
  '',
)

type Probe = {
  name: string
  path: string
  /** Optional extra check after JSON parse */
  assert?: (body: any) => string | null
}

const PROBES: Probe[] = [
  {
    name: 'stats',
    path: '/api/explorer/stats',
    assert: (body) => {
      if (!body?.data) return 'missing data'
      if (body.data.aggregates && typeof body.data.aggregates.byType !== 'object') {
        return 'missing aggregates.byType'
      }
      return null
    },
  },
  {
    name: 'search',
    path: '/api/explorer/search?page=1&pageSize=5',
    assert: (body) => {
      if (!body?.data?.pagination) return 'missing pagination'
      if (!Array.isArray(body?.data?.items)) return 'missing items[]'
      return null
    },
  },
  {
    name: 'locations',
    path: '/api/explorer/locations?q=london&limit=5',
    assert: (body) =>
      Array.isArray(body?.data?.suggestions) ? null : 'missing data.suggestions[]',
  },
  {
    name: 'latest-readings',
    path: '/api/explorer/latest-readings',
    assert: (body) => (Array.isArray(body?.readings) ? null : 'missing readings[]'),
  },
  {
    name: 'priority-alerts',
    path: '/api/explorer/priority-alerts',
    assert: (body) => (Array.isArray(body?.alerts) ? null : 'missing alerts[]'),
  },
]

async function probeOne(probe: Probe): Promise<{ ok: boolean; line: string }> {
  const url = `${BASE}${probe.path}`
  const started = Date.now()
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    })
    const ms = Date.now() - started
    const text = await res.text()
    let body: any = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      return {
        ok: false,
        line: `FAIL ${probe.name} HTTP ${res.status} ${ms}ms non-JSON: ${text.slice(0, 120)}`,
      }
    }
    if (!res.ok) {
      return {
        ok: false,
        line: `FAIL ${probe.name} HTTP ${res.status} ${ms}ms ${body?.error || text.slice(0, 120)}`,
      }
    }
    if (body && body.success === false) {
      return {
        ok: false,
        line: `FAIL ${probe.name} HTTP ${res.status} ${ms}ms success:false ${body.error || ''}`.trim(),
      }
    }
    const assertMsg = probe.assert?.(body) ?? null
    if (assertMsg) {
      return { ok: false, line: `FAIL ${probe.name} HTTP ${res.status} ${ms}ms ${assertMsg}` }
    }
    return { ok: true, line: `OK   ${probe.name} HTTP ${res.status} ${ms}ms` }
  } catch (err) {
    const ms = Date.now() - started
    return {
      ok: false,
      line: `FAIL ${probe.name} ${ms}ms ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

async function main(): Promise<void> {
  console.log(`Explorer API probe → ${BASE}`)
  let failed = 0
  for (const probe of PROBES) {
    const result = await probeOne(probe)
    console.log(`  ${result.line}`)
    if (!result.ok) failed += 1
  }
  if (failed > 0) {
    console.error(`\n${failed}/${PROBES.length} probe(s) failed`)
    process.exitCode = 1
    return
  }
  console.log(`\nAll ${PROBES.length} probes passed`)
}

main()
