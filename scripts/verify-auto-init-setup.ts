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
  checkFileMissing('vercel.json', 'Retired Vercel worker cron')

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
