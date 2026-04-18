"use client"

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Loader2, CheckCircle, XCircle, Wallet, Database, Activity } from 'lucide-react'

interface TestResult {
  success: boolean
  message: string
  data?: any
}

export function BlockchainTest() {
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<TestResult[]>([])

  const addResult = (result: TestResult) => {
    setResults(prev => [result, ...prev.slice(0, 4)]) // Keep last 5 results
  }

  const testWalletBalance = async () => {
    setLoading(true)
    try {
      const response = await fetch('/api/blockchain/balance')
      const data = await response.json()
      
      if (data.success) {
        addResult({
          success: true,
          message: `Wallet Balance: ${data.balance} BSV`,
          data
        })
      } else {
        addResult({
          success: false,
          message: `Balance Check Failed: ${data.error}`,
          data
        })
      }
    } catch (error) {
      addResult({
        success: false,
        message: `Network Error: ${error instanceof Error ? error.message : 'Unknown error'}`
      })
    }
    setLoading(false)
  }

  const testTransactionHistory = async () => {
    setLoading(true)
    try {
      const response = await fetch('/api/blockchain/transactions?limit=5')
      const data = await response.json()
      
      if (data.success) {
        addResult({
          success: true,
          message: `Found ${data.count} transactions`,
          data
        })
      } else {
        addResult({
          success: false,
          message: `Transaction History Failed: ${data.error}`,
          data
        })
      }
    } catch (error) {
      addResult({
        success: false,
        message: `Network Error: ${error instanceof Error ? error.message : 'Unknown error'}`
      })
    }
    setLoading(false)
  }

  const testDataCollection = async () => {
    setLoading(true)
    try {
      const response = await fetch('/api/data/collect', { method: 'POST' })
      const data = await response.json()
      
      if (data.success) {
        addResult({
          success: true,
          message: 'Environmental data collected successfully',
          data: data.summary
        })
      } else {
        addResult({
          success: false,
          message: `Data Collection Failed: ${data.error}`,
          data
        })
      }
    } catch (error) {
      addResult({
        success: false,
        message: `Network Error: ${error instanceof Error ? error.message : 'Unknown error'}`
      })
    }
    setLoading(false)
  }

  const testBlockchainWrite = async () => {
    setLoading(true)
    try {
      const testData = {
        stream: 'test_stream',
        payload: {
          message: 'Test blockchain write',
          timestamp: new Date().toISOString(),
          test: true
        }
      }

      const response = await fetch('/api/blockchain/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(testData)
      })
      
      const data = await response.json()
      
      if (data.success) {
        addResult({
          success: true,
          message: `Data written to blockchain: ${data.txid?.slice(0, 8)}...`,
          data
        })
      } else {
        addResult({
          success: false,
          message: `Blockchain Write Failed: ${data.error}`,
          data
        })
      }
    } catch (error) {
      addResult({
        success: false,
        message: `Network Error: ${error instanceof Error ? error.message : 'Unknown error'}`
      })
    }
    setLoading(false)
  }

  return (
    <Card className="p-6 bg-slate-900/50 border-slate-700">
      <div className="flex items-center space-x-2 mb-4">
        <Database className="h-5 w-5 text-blue-400" />
        <h3 className="text-lg font-semibold text-white">Blockchain Integration Test</h3>
      </div>
      
      <div className="grid grid-cols-2 gap-3 mb-6">
        <Button 
          onClick={testWalletBalance} 
          disabled={loading}
          variant="outline" 
          className="border-slate-600 text-slate-300 hover:bg-slate-800"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wallet className="h-4 w-4" />}
          Check Balance
        </Button>
        
        <Button 
          onClick={testTransactionHistory} 
          disabled={loading}
          variant="outline" 
          className="border-slate-600 text-slate-300 hover:bg-slate-800"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Activity className="h-4 w-4" />}
          View Transactions
        </Button>
        
        <Button 
          onClick={testDataCollection} 
          disabled={loading}
          variant="outline" 
          className="border-slate-600 text-slate-300 hover:bg-slate-800"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Database className="h-4 w-4" />}
          Collect Data
        </Button>
        
        <Button 
          onClick={testBlockchainWrite} 
          disabled={loading}
          variant="outline" 
          className="border-slate-600 text-slate-300 hover:bg-slate-800"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />}
          Test Write
        </Button>
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-medium text-slate-300 mb-3">Test Results:</h4>
        {results.length === 0 ? (
          <p className="text-sm text-slate-500">No tests run yet. Click a button above to test the blockchain integration.</p>
        ) : (
          results.map((result, index) => (
            <div key={index} className="flex items-start space-x-2 p-2 rounded bg-slate-800/50">
              {result.success ? (
                <CheckCircle className="h-4 w-4 text-green-400 mt-0.5" />
              ) : (
                <XCircle className="h-4 w-4 text-red-400 mt-0.5" />
              )}
              <div className="flex-1">
                <p className="text-sm text-slate-200">{result.message}</p>
                {result.data && (
                  <details className="mt-1">
                    <summary className="text-xs text-slate-400 cursor-pointer">View Details</summary>
                    <pre className="text-xs text-slate-500 mt-1 p-2 bg-slate-900/50 rounded overflow-x-auto">
                      {JSON.stringify(result.data, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="mt-4 p-3 bg-slate-800/30 rounded border border-slate-700">
        <p className="text-xs text-slate-400">
          <strong>Note:</strong> This test component requires proper environment variables and API keys to be configured. 
          Start with <code className="bg-slate-900 px-1 rounded">env.example</code> for the minimum local setup and use <code className="bg-slate-900 px-1 rounded">env.template</code> for the full configuration surface.
        </p>
      </div>
    </Card>
  )
}
