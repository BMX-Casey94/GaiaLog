/**
 * Verify split-runtime deployment setup.
 *
 * The script name is retained for compatibility, but it now validates the
 * Vercel read-only plus VPS single-writer architecture rather than the old
 * Vercel cron-based worker model.
 */

import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.join(__dirname, '..')

interface CheckResult {
  name: string
  passed: boolean
  message: string
}

const results: CheckResult[] = []

function checkFile(filePath: string, description: string): boolean {
  const fullPath = path.join(ROOT, filePath)
  const exists = fs.existsSync(fullPath)

  results.push({
    name: description,
    passed: exists,
    message: exists ? `OK: ${filePath}` : `Missing: ${filePath}`,
  })

  return exists
}

function checkFileMissing(filePath: string, description: string): boolean {
  const fullPath = path.join(ROOT, filePath)
  const missing = !fs.existsSync(fullPath)

  results.push({
    name: description,
    passed: missing,
    message: missing ? `OK: ${filePath} is absent` : `Unexpected file present: ${filePath}`,
  })

  return missing
}

/**
 * Validate that vercel.json contains only the supported read-side cron paths
 * and never reintroduces the retired worker-cron model.
 */
function checkVercelConfig(): boolean {
  const filePath = 'vercel.json'
  const fullPath = path.join(ROOT, filePath)

  if (!fs.existsSync(fullPath)) {
    results.push({
      name: 'Vercel config present',
      passed: true,
      message: `OK: ${filePath} is absent (no Vercel-side crons)`,
    })
    return true
  }

  let parsed: { crons?: Array<{ path?: string; schedule?: string }> } = {}
  try {
    parsed = JSON.parse(fs.readFileSync(fullPath, 'utf-8'))
  } catch (err) {
    results.push({
      name: 'Vercel config parses',
      passed: false,
      message: `Failed to parse ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    })
    return false
  }

  const crons = Array.isArray(parsed.crons) ? parsed.crons : []
  const allowedPaths = new Set(['/api/maintenance/retention'])
  const disallowed = crons.filter((c) => !c.path || !allowedPaths.has(c.path))

  results.push({
    name: 'Vercel config restricted to retention cron',
    passed: disallowed.length === 0,
    message:
      disallowed.length === 0
        ? `OK: ${filePath} only schedules the retention cron`
        : `Disallowed cron paths in ${filePath}: ${disallowed.map((c) => c.path ?? '(no path)').join(', ')}`,
  })

  return disallowed.length === 0
}

function checkFileContains(filePath: string, searchString: string, description: string): boolean {
  const fullPath = path.join(ROOT, filePath)

  if (!fs.existsSync(fullPath)) {
    results.push({
      name: description,
      passed: false,
      message: `File not found: ${filePath}`,
    })
    return false
  }

  const content = fs.readFileSync(fullPath, 'utf-8')
  const contains = content.includes(searchString)

  results.push({
    name: description,
    passed: contains,
    message: contains ? `OK: ${description}` : `Missing expected content in ${filePath}: ${searchString}`,
  })

  return contains
}

async function verifySetup() {
  console.log('Verifying GaiaLog split-runtime setup\n')
  console.log('='.repeat(70))

  console.log('\nCore runtime modules:')
  checkFile('lib/runtime-control.ts', 'Runtime control module')
  checkFile('lib/worker-auto-init.ts', 'Worker auto-init module')
  checkFile('lib/worker-bootstrap.ts', 'Worker bootstrap module')

  console.log('\nRuntime guard integration:')
  checkFileContains('app/layout.tsx', 'worker-bootstrap', 'Bootstrap import in layout')
  checkFileContains('lib/worker-bootstrap.ts', 'GAIALOG_WORKER_PROCESS', 'Bootstrap respects runtime worker flag')
  checkFileContains('lib/worker-auto-init.ts', 'getRuntimeControlState', 'Auto-init respects runtime control')
  checkFileContains('ecosystem.config.cjs', "GAIALOG_WORKER_PROCESS: '0'", 'VPS web process is read-only')
  checkFileContains('ecosystem.config.cjs', "GAIALOG_WORKER_PROCESS: '1'", 'VPS worker process is write-enabled')
  checkFileContains('ecosystem.config.cjs', "GAIALOG_SINGLE_WRITER_MODE: 'run-workers'", 'Single-writer mode configured in PM2')

  console.log('\nDeployment surfaces:')
  checkFile('env.vercel.template', 'Vercel env template')
  checkFile('env.vps.template', 'VPS env template')
  checkFile('docs/deployment.md', 'Deployment guide')
  checkFile('docs/getting-started.md', 'Getting started guide')
  checkFile('docs/operations-and-runbooks.md', 'Operations runbook')
  checkVercelConfig()

  console.log('\nDocumentation alignment:')
  checkFileContains('docs/deployment.md', 'Vercel', 'Deployment guide references Vercel')
  checkFileContains('docs/deployment.md', 'VPS', 'Deployment guide references VPS')
  checkFileContains('docs/deployment.md', 'GAIALOG_WORKER_PROCESS=0', 'Deployment guide documents read-only Vercel')
  checkFileContains('docs/deployment.md', 'GAIALOG_WORKER_PROCESS=1', 'Deployment guide documents worker VPS')

  console.log('\nDeveloper scripts:')
  checkFileContains('package.json', 'verify:auto-init', 'Verification command retained in package.json')
  checkFileContains('package.json', 'workers', 'Worker start command retained in package.json')

  console.log('\n' + '='.repeat(70))
  console.log('\nSummary:\n')

  const passed = results.filter(r => r.passed).length
  const total = results.length
  const percentage = Math.round((passed / total) * 100)

  console.log(`Total checks: ${total}`)
  console.log(`Passed: ${passed}`)
  console.log(`Failed: ${total - passed}`)
  console.log(`Success rate: ${percentage}%\n`)

  if (passed === total) {
    console.log('All checks passed. The split-runtime deployment setup looks consistent.')
    console.log('\nNext steps:')
    console.log('  1. Populate Vercel from env.vercel.template')
    console.log('  2. Populate the VPS from env.vps.template')
    console.log('  3. Start the VPS worker with PM2 or npm run workers')
    console.log('  4. Read docs/deployment.md before rollout')
    process.exit(0)
  } else {
    console.log('Some checks failed. Review the output above.')
    console.log('\nFailed checks:')
    results.filter(r => !r.passed).forEach(r => {
      console.log(`  - ${r.message}`)
    })
    process.exit(1)
  }
}

verifySetup().catch(error => {
  console.error('Verification failed with error:')
  console.error(error)
  process.exit(1)
})
