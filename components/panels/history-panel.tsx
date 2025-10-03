"use client"

import { useState, useMemo } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useBlockchain } from "@/hooks/use-blockchain"
import { BlockchainStatus } from "@/components/blockchain-status"
import {
  ExternalLink,
  Search,
  Download,
  GitCommit,
  Clock,
  CheckCircle,
  AlertCircle,
  Loader,
  Wind,
  Droplets,
  Activity,
  BarChart3,
} from "lucide-react"

const getDataTypeIcon = (dataType: string) => {
  switch (dataType) {
    case "air_quality":
      return <Wind className="h-4 w-4" />
    case "water_levels":
      return <Droplets className="h-4 w-4" />
    case "seismic_activity":
      return <Activity className="h-4 w-4" />
    case "advanced_metrics":
      return <BarChart3 className="h-4 w-4" />
    default:
      return <GitCommit className="h-4 w-4" />
  }
}

const getStatusIcon = (status: string) => {
  switch (status) {
    case "confirmed":
      return <CheckCircle className="h-4 w-4 text-green-500" />
    case "pending":
      return <Loader className="h-4 w-4 text-yellow-500 animate-spin" />
    case "failed":
      return <AlertCircle className="h-4 w-4 text-red-500" />
    default:
      return <Clock className="h-4 w-4 text-gray-500" />
  }
}

const getStatusColor = (status: string) => {
  switch (status) {
    case "confirmed":
      return "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
    case "pending":
      return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200"
    case "failed":
      return "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
    default:
      return "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200"
  }
}

export function HistoryPanel() {
  const { transactions, getExplorerUrl } = useBlockchain()
  const [searchTerm, setSearchTerm] = useState("")
  const [statusFilter, setStatusFilter] = useState("all")
  const [typeFilter, setTypeFilter] = useState("all")

  const filteredTransactions = useMemo(() => {
    return transactions.filter((tx) => {
      const matchesSearch =
        searchTerm === "" ||
        tx.txid.toLowerCase().includes(searchTerm.toLowerCase()) ||
        tx.data.dataType.toLowerCase().includes(searchTerm.toLowerCase())

      const matchesStatus = statusFilter === "all" || tx.status === statusFilter
      const matchesType = typeFilter === "all" || tx.data.dataType === typeFilter

      return matchesSearch && matchesStatus && matchesType
    })
  }, [transactions, searchTerm, statusFilter, typeFilter])

  const exportTransactions = () => {
    const csvContent = [
      ["Timestamp", "Transaction ID", "Data Type", "Status", "Block Height", "Fee"].join(","),
      ...filteredTransactions.map((tx) =>
        [tx.timestamp, tx.txid, tx.data.dataType, tx.status, tx.blockHeight || "N/A", tx.fee || "N/A"].join(","),
      ),
    ].join("\n")

    const blob = new Blob([csvContent], { type: "text/csv" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `gaialog-transactions-${new Date().toISOString().split("T")[0]}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const getDataTypeName = (dataType: string) => {
    return dataType
      .split("_")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ")
  }

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)

    if (diffMins < 1) return "just now"
    if (diffMins < 60) return `${diffMins} minutes ago`
    if (diffHours < 24) return `${diffHours} hours ago`
    if (diffDays < 7) return `${diffDays} days ago`
    return date.toLocaleDateString()
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold font-space-grotesk mb-2">Transaction History</h1>
        <p className="text-muted-foreground">
          Complete history of environmental data transactions recorded on BSV blockchain
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <GitCommit className="h-5 w-5" />
                    Transaction Log
                  </CardTitle>
                  <CardDescription>
                    {filteredTransactions.length} of {transactions.length} transactions
                  </CardDescription>
                </div>
                <Button variant="outline" size="sm" onClick={exportTransactions}>
                  <Download className="h-4 w-4 mr-2" />
                  Export CSV
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-4 mb-6">
                <div className="flex gap-4">
                  <div className="flex-1">
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        placeholder="Search transactions..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="pl-10"
                      />
                    </div>
                  </div>
                  <Select value={statusFilter} onValueChange={setStatusFilter}>
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Status</SelectItem>
                      <SelectItem value="confirmed">Confirmed</SelectItem>
                      <SelectItem value="pending">Pending</SelectItem>
                      <SelectItem value="failed">Failed</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={typeFilter} onValueChange={setTypeFilter}>
                    <SelectTrigger className="w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Types</SelectItem>
                      <SelectItem value="air_quality">Air Quality</SelectItem>
                      <SelectItem value="water_levels">Water Levels</SelectItem>
                      <SelectItem value="seismic_activity">Seismic Activity</SelectItem>
                      <SelectItem value="advanced_metrics">Advanced Metrics</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-4">
                {filteredTransactions.length === 0 ? (
                  <div className="text-center py-12">
                    <GitCommit className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                    <h3 className="text-lg font-semibold mb-2">No transactions found</h3>
                    <p className="text-muted-foreground">
                      {transactions.length === 0
                        ? "Start monitoring environmental data to see transactions here."
                        : "Try adjusting your search or filter criteria."}
                    </p>
                  </div>
                ) : (
                  filteredTransactions.map((tx, index) => (
                    <div key={tx.txid} className="relative">
                      {/* Timeline line */}
                      {index < filteredTransactions.length - 1 && (
                        <div className="absolute left-6 top-12 w-0.5 h-16 bg-border" />
                      )}

                      <div className="flex gap-4 p-4 rounded-lg border bg-card hover:bg-muted/50 transition-colors">
                        <div className="flex-shrink-0 mt-1">
                          <div className="w-8 h-8 rounded-full bg-background border-2 border-border flex items-center justify-center">
                            {getDataTypeIcon(tx.data.dataType)}
                          </div>
                        </div>

                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-4">
                            <div className="flex-1">
                              <div className="flex items-center gap-2 mb-1">
                                <h3 className="font-semibold text-sm">{getDataTypeName(tx.data.dataType)}</h3>
                                <Badge className={`text-xs ${getStatusColor(tx.status)}`}>
                                  {getStatusIcon(tx.status)}
                                  <span className="ml-1">{tx.status}</span>
                                </Badge>
                              </div>

                              <div className="flex items-center gap-4 text-xs text-muted-foreground mb-2">
                                <span className="flex items-center gap-1">
                                  <Clock className="h-3 w-3" />
                                  {formatTimestamp(tx.timestamp)}
                                </span>
                                {tx.blockHeight && <span>Block #{tx.blockHeight.toLocaleString()}</span>}
                                {tx.fee && <span>Fee: {tx.fee} BSV</span>}
                              </div>

                              <div className="font-mono text-xs bg-muted p-2 rounded border">
                                <div className="flex items-center justify-between">
                                  <span className="truncate">{tx.txid}</span>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => window.open(getExplorerUrl(tx.txid), "_blank")}
                                    className="ml-2 h-6 w-6 p-0"
                                  >
                                    <ExternalLink className="h-3 w-3" />
                                  </Button>
                                </div>
                              </div>
                            </div>
                          </div>

                          {/* Transaction data preview */}
                          <details className="mt-3">
                            <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                              View transaction data
                            </summary>
                            <div className="mt-2 p-3 bg-muted rounded text-xs">
                              <pre className="whitespace-pre-wrap overflow-x-auto">
                                {JSON.stringify(tx.data, null, 2)}
                              </pre>
                            </div>
                          </details>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <BlockchainStatus />

          <Card>
            <CardHeader>
              <CardTitle>Transaction Statistics</CardTitle>
              <CardDescription>Summary of blockchain activity</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="flex justify-between items-center">
                  <span className="text-sm font-medium">Total Transactions</span>
                  <span className="text-lg font-semibold">{transactions.length}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-sm font-medium">Confirmed</span>
                  <span className="text-sm text-green-600">
                    {transactions.filter((tx) => tx.status === "confirmed").length}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-sm font-medium">Pending</span>
                  <span className="text-sm text-yellow-600">
                    {transactions.filter((tx) => tx.status === "pending").length}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-sm font-medium">Failed</span>
                  <span className="text-sm text-red-600">
                    {transactions.filter((tx) => tx.status === "failed").length}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Data Type Breakdown</CardTitle>
              <CardDescription>Transactions by environmental data type</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {["air_quality", "water_levels", "seismic_activity", "advanced_metrics"].map((type) => {
                  const count = transactions.filter((tx) => tx.data.dataType === type).length
                  const percentage = transactions.length > 0 ? (count / transactions.length) * 100 : 0
                  return (
                    <div key={type} className="space-y-1">
                      <div className="flex justify-between text-sm">
                        <span className="flex items-center gap-2">
                          {getDataTypeIcon(type)}
                          {getDataTypeName(type)}
                        </span>
                        <span>{count}</span>
                      </div>
                      <div className="w-full bg-muted rounded-full h-2">
                        <div
                          className="bg-primary h-2 rounded-full transition-all"
                          style={{ width: `${percentage}%` }}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
