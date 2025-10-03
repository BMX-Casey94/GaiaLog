"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ExternalLink, Wallet, Activity, Clock } from "lucide-react"
import { useBlockchain } from "@/hooks/use-blockchain"

export function BlockchainStatus() {
  const { wallet, transactions, connectionStatus, getExplorerUrl } = useBlockchain()

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5" />
            BSV Network Status
          </CardTitle>
          <CardDescription>Blockchain connection and network information</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-sm font-medium">Connection Status</p>
              <Badge variant={connectionStatus?.connected ? "secondary" : "destructive"} className="mt-1 rounded-sm">
                {connectionStatus?.connected ? "Connected" : "Disconnected"}
              </Badge>
            </div>
            <div>
              <p className="text-sm font-medium">Block Height</p>
              <p className="text-lg font-mono">{connectionStatus?.blockHeight?.toLocaleString()}</p>
            </div>
            <div>
              <p className="text-sm font-medium">Network Fee</p>
              <p className="text-sm">{connectionStatus?.networkFee} BSV</p>
            </div>
            <div>
              <p className="text-sm font-medium">Transactions</p>
              <p className="text-lg font-semibold">{transactions.length}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wallet className="h-5 w-5" />
            Wallet Information
          </CardTitle>
          <CardDescription>Current wallet details and balance</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div>
              <p className="text-sm font-medium">Address</p>
              <p className="text-sm font-mono bg-muted p-2 rounded">{wallet?.address}</p>
            </div>
            <div>
              <p className="text-sm font-medium">Balance</p>
              <p className="text-lg font-semibold">{wallet?.balance} BSV</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent Transactions</CardTitle>
          <CardDescription>Latest blockchain transactions from this session</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {transactions.slice(0, 5).map((tx) => (
              <div key={tx.txid} className="flex items-center justify-between p-3 bg-muted rounded-lg">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-sm">{tx.data.dataType.replace("_", " ").toUpperCase()}</p>
                    <Badge
                      variant={
                        tx.status === "confirmed" ? "secondary" : tx.status === "pending" ? "outline" : "destructive"
                      }
                      className="text-xs"
                    >
                      {tx.status}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-1 mt-1">
                    <Clock className="h-3 w-3 text-muted-foreground" />
                    <p className="text-xs text-muted-foreground">{new Date(tx.timestamp).toLocaleString()}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <p className="text-xs font-mono">{tx.txid.substring(0, 8)}...</p>
                  <Button variant="ghost" size="sm" onClick={() => window.open(getExplorerUrl(tx.txid), "_blank")}>
                    <ExternalLink className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            ))}
            {transactions.length === 0 && <p className="text-muted-foreground text-center py-4">No transactions yet</p>}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
