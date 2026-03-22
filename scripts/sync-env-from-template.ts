/**
 * Appends missing variable lines from env.template into .env (never overwrites existing keys).
 * Safe for production secrets: only adds keys that are not already set as active assignments in .env.
 *
 * Usage:
 *   npm run sync:env
 *   npm run sync:env:dry-run
 *   (On Windows, prefer sync:env:dry-run — `npm run sync:env -- --dry-run` may not forward flags.)
 */
import * as fs from 'fs'
import * as path from 'path'

const root = path.resolve(__dirname, '..')
const envPath = path.join(root, '.env')
const templatePath = path.join(root, 'env.template')

/** Keys we never auto-append — dangerous defaults or tri-state semantics (see env.template comments). */
const EXCLUDE_KEYS_FROM_SYNC = new Set<string>(['BSV_ARC_ACCEPT_ORPHAN_MEMPOOL'])

const dryRun =
  process.argv.includes('--dry-run') ||
  process.argv.includes('-n') ||
  process.env.SYNC_ENV_DRY_RUN === '1'

/**
 * Active assignments with empty values can wipe secrets (e.g. WHATSONCHAIN_API_KEY=).
 * Only append uncommented lines when there is a non-empty, non-placeholder value.
 */
function formatAppendedLine(line: string): string {
  const trimmed = line.trimEnd()
  const t = trimmed.trimStart()
  if (t.startsWith('#')) return trimmed
  const eq = t.indexOf('=')
  if (eq < 0) return `# ${t}`
  const val = t.slice(eq + 1).trim()
  if (!val) return `# ${t}`
  if (/replace_me/i.test(val)) return `# ${t}`
  return trimmed
}

/** Active KEY= assignments in .env (ignores whole-line comments). */
function activeKeysInEnv(content: string): Set<string> {
  const keys = new Set<string>()
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const m = t.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/)
    if (m) keys.add(m[1])
  }
  return keys
}

/**
 * For each key, pick the best template line to append: prefer uncommented assignment,
 * else last commented example (verbatim).
 */
function templateLineByKey(template: string): Map<string, string> {
  const byKey = new Map<string, { active?: string; comment?: string }>()
  for (const line of template.split(/\r?\n/)) {
    const trimmed = line.trimEnd()
    if (!trimmed) continue
    const m = trimmed.match(/^\s*#?\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)
    if (!m) continue
    const key = m[1]
    const isComment = /^\s*#/.test(trimmed)
    const prev = byKey.get(key) || {}
    if (isComment) byKey.set(key, { ...prev, comment: trimmed })
    else byKey.set(key, { ...prev, active: trimmed })
  }
  const out = new Map<string, string>()
  for (const [k, e] of byKey) {
    const line = e.active ?? e.comment
    if (line) out.set(k, line)
  }
  return out
}

/** First mention order of each KEY in the template (stable append order). */
function templateKeyOrder(template: string): string[] {
  const order: string[] = []
  const seen = new Set<string>()
  for (const line of template.split(/\r?\n/)) {
    const m = line.match(/^\s*#?\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)
    if (!m) continue
    const k = m[1]
    if (seen.has(k)) continue
    seen.add(k)
    order.push(k)
  }
  return order
}

function main(): void {
  if (!fs.existsSync(templatePath)) {
    console.error('Missing env.template at', templatePath)
    process.exit(1)
  }
  const template = fs.readFileSync(templatePath, 'utf8')

  if (!fs.existsSync(envPath)) {
    if (dryRun) {
      console.log('Would create .env by copying env.template (no .env yet)')
      process.exit(0)
    }
    fs.copyFileSync(templatePath, envPath)
    console.log('Created .env from env.template — edit secrets before starting services.')
    process.exit(0)
  }

  const envContent = fs.readFileSync(envPath, 'utf8')
  const active = activeKeysInEnv(envContent)
  const fromTemplate = templateLineByKey(template)
  const keyOrder = templateKeyOrder(template)

  const missing: { key: string; line: string }[] = []
  for (const key of keyOrder) {
    if (active.has(key) || EXCLUDE_KEYS_FROM_SYNC.has(key)) continue
    const line = fromTemplate.get(key)
    if (line) missing.push({ key, line })
  }

  if (missing.length === 0) {
    console.log('sync:env — no missing keys; .env already defines every variable from env.template.')
    process.exit(0)
  }

  const header =
    `\n# --- appended by npm run sync:env (${new Date().toISOString()}) ---\n` +
    '# Empty or replace_me values stay commented so existing secrets are not cleared.\n'
  const block = header + missing.map((m) => formatAppendedLine(m.line)).join('\n') + '\n'

  if (dryRun) {
    console.log(`sync:env --dry-run — would append ${missing.length} key(s):`)
    for (const m of missing) console.log(`  - ${m.key}`)
    process.exit(0)
  }

  fs.appendFileSync(envPath, block, 'utf8')
  console.log(`sync:env — appended ${missing.length} missing key(s) from env.template:`)
  for (const m of missing) console.log(`  - ${m.key}`)
  console.log('Review the new block at the end of .env, then restart PM2 with --update-env.')
}

main()
