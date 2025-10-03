import { NextResponse } from 'next/server'
import { dataCollector } from '@/lib/data-collector'

export async function POST() {
  try {
    console.log('🔄 Starting environmental data collection...')
    
    const data = await dataCollector.collectAllData()
    
    console.log('✅ Data collection completed successfully')
    
    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      data,
      summary: {
        airQuality: data.airQuality ? 'Collected' : 'Failed',
        waterLevels: data.waterLevels ? 'Collected' : 'Failed',
        seismic: data.seismic ? 'Collected' : 'Failed',
        advancedMetrics: data.advancedMetrics ? 'Collected' : 'Failed'
      }
    })

  } catch (error) {
    console.error('❌ Error in data collection API:', error)
    
    return NextResponse.json(
      { 
        error: 'Failed to collect environmental data',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    )
  }
}

export async function GET() {
  try {
    // Return the last collected data (this would typically come from a database)
    return NextResponse.json({
      success: true,
      message: 'Use POST to trigger data collection',
      availableEndpoints: [
        'POST /api/data/collect - Collect all environmental data',
        'GET /api/blockchain/balance - Check wallet balance',
        'GET /api/blockchain/transactions - Get transaction history',
        'POST /api/blockchain/write - Write custom data to blockchain'
      ]
    })

  } catch (error) {
    console.error('Error in data collection GET:', error)
    
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
