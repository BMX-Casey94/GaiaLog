import { NextResponse } from 'next/server'
import { workerQueue } from '@/lib/worker-queue'

export async function GET() {
  try {
    // Get queue statistics
    const queueStats = workerQueue.getQueueStats()
    
    return NextResponse.json({
      success: true,
      highPriorityItems: queueStats.highPriorityItems,
      normalPriorityItems: queueStats.normalPriorityItems,
      processingItems: queueStats.processingItems || 0,
      completedItems: queueStats.completedItems || 0,
      failedItems: queueStats.failedItems || 0,
      totalItems: queueStats.totalItems,
      processingRate: queueStats.processingRate,
      errorRate: queueStats.errorRate
    })
  } catch (error) {
    console.error('Error fetching queue data:', error)
    return NextResponse.json(
      { 
        success: false, 
        error: 'Failed to fetch queue data',
        highPriorityItems: 0,
        normalPriorityItems: 0,
        processingItems: 0,
        completedItems: 0,
        failedItems: 0,
        totalItems: 0,
        processingRate: 0,
        errorRate: 0
      },
      { status: 500 }
    )
  }
}

