import { type NextRequest, NextResponse } from "next/server"
import { bsvClient } from "@/lib/bsv-client"

export async function POST(request: NextRequest) {
  try {
    const { dataType, data } = await request.json()

    if (!dataType || !data) {
      return NextResponse.json({ error: "Missing dataType or data" }, { status: 400 })
    }

    const transaction = await bsvClient.recordEnvironmentalData(dataType, data)

    return NextResponse.json({
      success: true,
      transaction,
    })
  } catch (error) {
    console.error("Blockchain record error:", error)
    return NextResponse.json({ error: "Failed to record data on blockchain" }, { status: 500 })
  }
}
