import { NextResponse } from "next/server"
import { bsvClient } from "@/lib/bsv-client"

export async function GET() {
  try {
    const status = await bsvClient.getConnectionStatus()
    const wallet = bsvClient.getWalletInfo()
    const transactions = bsvClient.getTransactionHistory()

    return NextResponse.json({
      connection: status,
      wallet,
      recentTransactions: transactions.slice(0, 10),
    })
  } catch (error) {
    console.error("Blockchain status error:", error)
    return NextResponse.json({ error: "Failed to get blockchain status" }, { status: 500 })
  }
}
