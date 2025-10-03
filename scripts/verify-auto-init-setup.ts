/**
 * Verify Auto-Init Setup Script
 * 
 * This script checks that all required files and configurations
 * are in place for the auto-initialization system.
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
    message: exists ? `✅ Found: ${filePath}` : `❌ Missing: ${filePath}`
  })
  
  return exists
}

function checkFileContains(filePath: string, searchString: string, description: string): boolean {
  const fullPath = path.join(ROOT, filePath)
  
  if (!fs.existsSync(fullPath)) {
    results.push({
      name: description,
      passed: false,
      message: `❌ File not found: ${filePath}`
    })
    return false
  }
  
  const content = fs.readFileSync(fullPath, 'utf-8')
  const contains = content.includes(searchString)
  
  results.push({
    name: description,
    passed: contains,
    message: contains 
      ? `✅ ${description}` 
      : `❌ ${description} - not found in ${filePath}`
  })
  
  return contains
}

async function verifySetup() {
  console.log('🔍 Verifying Auto-Initialization Setup\n')
  console.log('='.repeat(70))
  
  // Check core modules
  console.log('\n📦 Core Modules:')
  checkFile('lib/worker-auto-init.ts', 'Worker auto-init module')
  checkFile('lib/worker-bootstrap.ts', 'Worker bootstrap module')
  
  // Check API endpoints
  console.log('\n🌐 API Endpoints:')
  checkFile('app/api/workers/auto-start/route.ts', 'Auto-start endpoint')
  checkFile('app/api/workers/status/route.ts', 'Status endpoint')
  checkFile('app/api/warmup/route.ts', 'Warmup endpoint')
  
  // Check Vercel configuration
  console.log('\n⚙️  Vercel Configuration:')
  checkFile('vercel.json', 'Vercel config file')
  checkFileContains('vercel.json', 'crons', 'Cron job configuration')
  checkFileContains('vercel.json', '/api/workers/auto-start', 'Auto-start cron path')
  
  // Check integration points
  console.log('\n🔗 Integration Points:')
  checkFileContains('app/layout.tsx', 'worker-bootstrap', 'Bootstrap import in layout')
  checkFileContains('app/api/bsv/init/route.ts', 'autoInitializeWorkers', 'Centralized init in BSV endpoint')
  
  // Check test scripts
  console.log('\n🧪 Test Scripts:')
  checkFile('scripts/test-auto-init.ts', 'Test script')
  checkFileContains('package.json', 'test:auto-init', 'Test command in package.json')
  
  // Check documentation
  console.log('\n📚 Documentation:')
  checkFile('WORKER_AUTO_INITIALIZATION.md', 'Technical documentation')
  checkFile('DEPLOYMENT_QUICKSTART.md', 'Deployment guide')
  checkFile('README_AUTO_INIT.md', 'Overview README')
  checkFile('CHANGES_AUTO_INIT.md', 'Change log')
  
  // Summary
  console.log('\n' + '='.repeat(70))
  console.log('\n📊 Summary:\n')
  
  const passed = results.filter(r => r.passed).length
  const total = results.length
  const percentage = Math.round((passed / total) * 100)
  
  console.log(`Total Checks: ${total}`)
  console.log(`Passed: ${passed}`)
  console.log(`Failed: ${total - passed}`)
  console.log(`Success Rate: ${percentage}%\n`)
  
  if (passed === total) {
    console.log('✅ All checks passed! Auto-initialization system is properly set up.')
    console.log('\n📝 Next Steps:')
    console.log('   1. Test locally: npm run test:auto-init')
    console.log('   2. Deploy to Vercel: vercel --prod')
    console.log('   3. Verify status: curl https://your-app.vercel.app/api/workers/status')
    console.log('\n📖 Read DEPLOYMENT_QUICKSTART.md for deployment instructions.')
    process.exit(0)
  } else {
    console.log('❌ Some checks failed. Review the output above.')
    console.log('\n🔧 Failed Checks:')
    results.filter(r => !r.passed).forEach(r => {
      console.log(`   ${r.message}`)
    })
    console.log('\n💡 Tip: Make sure all files were created correctly.')
    process.exit(1)
  }
}

// Run verification
verifySetup().catch(error => {
  console.error('❌ Verification failed with error:')
  console.error(error)
  process.exit(1)
})

