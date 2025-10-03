import { NextResponse } from 'next/server'
import { walletManager } from '@/lib/wallet-manager'
import { workerQueue } from '@/lib/worker-queue'
import { workerManager } from '@/lib/worker-threads'
import { bsvTransactionService } from '@/lib/bsv-transaction-service'

export async function POST() {
  try {
    // Initialize wallet manager with test data if not already initialized
    if (!walletManager.isReady()) {
      console.log('Initializing wallet manager with test data...')
      
      // Add some test transactions to the queue
      const testData = [
        {
          type: 'air-quality',
          timestamp: Date.now(),
          location: 'London, UK',
          measurement: { value: 45, unit: 'AQI' },
          source_hash: 'test_hash_1'
        },
        {
          type: 'weather',
          timestamp: Date.now(),
          location: 'Manchester, UK',
          measurement: { temperature: 18, humidity: 65 },
          source_hash: 'test_hash_2'
        },
        {
          type: 'seismic',
          timestamp: Date.now(),
          location: 'Birmingham, UK',
          measurement: { magnitude: 2.5, depth: 10 },
          source_hash: 'test_hash_3'
        }
      ]

      // Add test data to queue
      testData.forEach((data, index) => {
        const priority = index === 0 ? 'high' : 'normal'
        workerQueue.addToQueue(data, priority)
      })

      // Start worker manager if not already started
      if (!workerManager.isReady()) {
        workerManager.startAll()
      }

      console.log('✅ Test data initialized successfully')
    }

    return NextResponse.json({
      success: true,
      message: 'Test data initialized successfully',
      walletCount: walletManager.getWalletCount(),
      queueSize: workerQueue.getQueueStats().totalItems,
      workersRunning: workerManager.getWorkerStats().filter(w => w.isRunning).length
    })
  } catch (error) {
    console.error('Error initializing test data:', error)
    return NextResponse.json(
      { 
        success: false, 
        error: 'Failed to initialize test data'
      },
      { status: 500 }
    )
  }
}

