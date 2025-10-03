/**
 * Test Auto-Initialization System
 * 
 * This script tests the automatic worker initialization system
 * to ensure it works correctly before deployment.
 */

import { autoInitializeWorkers, getWorkerStatus, resetInitialization } from '../lib/worker-auto-init'

async function testAutoInit() {
  console.log('🧪 Testing Auto-Initialization System\n')
  console.log('=' .repeat(60))
  
  try {
    // Test 1: Initial status (should be uninitialized)
    console.log('\n📋 Test 1: Check initial status')
    const initialStatus = getWorkerStatus()
    console.log('Initial Status:', initialStatus)
    
    // Test 2: First initialization
    console.log('\n📋 Test 2: First initialization')
    const firstInit = await autoInitializeWorkers()
    console.log('First Init Result:', {
      success: firstInit.success,
      message: firstInit.message,
      workersRunning: firstInit.status?.workersRunning,
      totalWorkers: firstInit.status?.totalWorkers
    })
    
    if (!firstInit.success) {
      console.error('❌ First initialization failed!')
      console.error('Error:', firstInit.error)
      process.exit(1)
    }
    
    // Test 3: Check status after initialization
    console.log('\n📋 Test 3: Check status after initialization')
    const statusAfterInit = getWorkerStatus()
    console.log('Status After Init:', {
      initialized: statusAfterInit.initialized,
      workersRunning: statusAfterInit.workersRunning,
      totalWorkers: statusAfterInit.totalWorkers,
      walletCount: statusAfterInit.walletCount,
      queueSize: statusAfterInit.queueSize
    })
    
    // Test 4: Idempotent initialization (should not re-initialize)
    console.log('\n📋 Test 4: Idempotent initialization test')
    const secondInit = await autoInitializeWorkers()
    console.log('Second Init Result:', {
      success: secondInit.success,
      message: secondInit.message
    })
    
    if (secondInit.message !== 'Workers already initialized and running') {
      console.warn('⚠️  Expected idempotent response, got:', secondInit.message)
    }
    
    // Test 5: Verify workers are actually running
    console.log('\n📋 Test 5: Verify workers are running')
    const finalStatus = getWorkerStatus()
    
    const tests = {
      initialized: finalStatus.initialized === true,
      hasWorkers: finalStatus.workersRunning === finalStatus.totalWorkers,
      hasWallets: finalStatus.walletCount > 0,
      workersReady: finalStatus.workerManager === true,
      walletsReady: finalStatus.walletManager === true
    }
    
    console.log('\nTest Results:')
    console.log('  ✓ Initialized:', tests.initialized ? '✅' : '❌')
    console.log('  ✓ All workers running:', tests.hasWorkers ? '✅' : '❌', 
                `(${finalStatus.workersRunning}/${finalStatus.totalWorkers})`)
    console.log('  ✓ Wallets configured:', tests.hasWallets ? '✅' : '❌',
                `(${finalStatus.walletCount})`)
    console.log('  ✓ Worker manager ready:', tests.workersReady ? '✅' : '❌')
    console.log('  ✓ Wallet manager ready:', tests.walletsReady ? '✅' : '❌')
    
    const allTestsPassed = Object.values(tests).every(t => t)
    
    console.log('\n' + '='.repeat(60))
    
    if (allTestsPassed) {
      console.log('✅ All tests passed! Auto-initialization system is working correctly.')
      console.log('\n📊 Final Status:')
      console.log(JSON.stringify(finalStatus, null, 2))
      process.exit(0)
    } else {
      console.error('❌ Some tests failed! Review the output above.')
      console.log('\n📊 Final Status:')
      console.log(JSON.stringify(finalStatus, null, 2))
      process.exit(1)
    }
    
  } catch (error) {
    console.error('\n❌ Test failed with error:')
    console.error(error)
    process.exit(1)
  }
}

// Run tests
testAutoInit()

