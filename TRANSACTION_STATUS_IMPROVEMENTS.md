# Transaction Status & Confirmation Improvements

## Issue
Transaction IDs (TXIDs) were not appearing on WhatOnChain (WOC) immediately after being displayed in the UI. This was because:

1. Transactions were marked as "confirmed" immediately upon broadcast, but they were actually only in the mempool (pending)
2. WOC typically takes 2-30 seconds to index new transactions
3. Only "confirmed" transactions were shown in the UI, excluding genuinely pending ones

## Root Cause
**`lib/blockchain.ts` line 410**:
```typescript
status: 'confirmed',  // ❌ WRONG - Transaction is only broadcast, not confirmed!
```

When a transaction is broadcast to the BSV network:
- It enters the mempool (unconfirmed/pending state)
- WOC needs time to index it (usually 2-10 seconds, up to 30 seconds)
- It then needs to be included in a block to be truly "confirmed"
- The UI was marking it as confirmed immediately, creating confusion

## Solutions Implemented

### 1. Correct Transaction Status on Broadcast
**File: `lib/blockchain.ts` (lines 403-422)**

Changed transaction status from 'confirmed' to 'pending' when initially broadcast:

```typescript
await upsertTxLog({
  txid,
  type: data.stream,
  provider: (data as any)?.payload?.source || 'unknown',
  collected_at: new Date(data.timestamp),
  status: 'pending',  // ✅ Correct - Transaction is broadcast but not confirmed
  onchain_at: new Date(),
  fee_sats: null,
  wallet_index: walletIndexForLog,
  retries: 0,
  error: null,
})

// Schedule confirmation check after a delay to update status
this.scheduleConfirmationCheck(txid, data.stream).catch(() => {})
```

### 2. Automatic Confirmation Polling
**File: `lib/blockchain.ts` (lines 732-779)**

Added `scheduleConfirmationCheck()` method that:
- Waits 30 seconds for transaction to propagate
- Queries WOC to check confirmation status
- Updates database status to 'confirmed' once it has confirmations
- Retries if transaction is still in mempool
- Handles 404 errors gracefully (transaction not yet indexed)

```typescript
private async scheduleConfirmationCheck(txid: string, streamType: string): Promise<void> {
  setTimeout(async () => {
    try {
      const network = WOC_NETWORK
      const wocUrl = `https://api.whatsonchain.com/v1/bsv/${network}/tx/${txid}`
      const response = await fetch(wocUrl, { headers })
      
      if (response.ok) {
        const txData = await response.json()
        const confirmations = txData.confirmations || 0
        
        if (confirmations > 0) {
          await upsertTxLog({ txid, status: 'confirmed', ... })
          console.log(`✅ Transaction ${txid.substring(0, 12)}... confirmed`)
        } else {
          // Still in mempool, check again later
          setTimeout(() => this.scheduleConfirmationCheck(txid, streamType), 60000)
        }
      }
    } catch (error) {
      // Silently fail - confirmation checking is best-effort
    }
  }, 30000) // Initial check after 30 seconds
}
```

### 3. Include Pending Transactions in API
**File: `app/api/blockchain/recent-readings/route.ts` (lines 28 & 47)**

Updated the database query to include both pending and confirmed transactions:

```sql
WHERE status IN ('confirmed', 'pending')  -- Instead of just 'confirmed'
```

Added status field to API response:
```typescript
const readings = result.rows.map((tx) => ({
  txid: tx.txid,
  type: tx.type,
  timestamp: tx.onchain_at || tx.collected_at,
  status: tx.status,  // ✅ Include status in response
  data: { provider: tx.provider },
}))
```

### 4. Visual Status Distinction in UI
**File: `components/sections/blockchain-explorer.tsx`**

Added visual distinction between pending and confirmed transactions:

**Interface update (line 24):**
```typescript
interface Reading {
  txid: string
  type: string
  timestamp: string
  status?: string  // ✅ Added status field
  data: ReadingData
}
```

**Status badge with colour coding (lines 174-181):**
```tsx
<Badge 
  variant="secondary" 
  className={tx.status === 'pending' 
    ? "bg-yellow-900/50 text-yellow-400 rounded-sm"   // Yellow for pending
    : "bg-green-900/50 text-green-400 rounded-sm"}    // Green for confirmed
>
  {tx.status}
</Badge>
```

**Use actual status from API (line 62):**
```typescript
status: reading.status || 'confirmed',  // Use actual status from backend
```

## Benefits

1. **Accurate Status Display**: Transactions show as "pending" until actually confirmed on-chain
2. **Automatic Updates**: Status automatically updates from pending → confirmed
3. **Better UX**: Users see yellow "pending" badges that turn green when confirmed
4. **WOC Link Timing**: Users understand that pending transactions may take a moment to appear on WOC
5. **Retry Logic**: If WOC hasn't indexed a transaction yet, the system checks again later

## Timeline

When a transaction is broadcast:
- **T+0s**: Transaction broadcast, marked as "pending" (yellow badge)
- **T+2-10s**: Transaction appears on WhatOnChain
- **T+30s**: First confirmation check runs
- **T+30s-10min**: Transaction gets mined into a block
- **T+30s+**: Status updates to "confirmed" (green badge)

## Monitoring

Console logs now show:
```
✅ Transaction abc123def456... confirmed (1 confirmations)
⏳ Transaction abc123def456... still in mempool, will check again
⚠️ Transaction abc123def456... not found on WOC (may still be propagating or rejected)
```

## Related Files Modified

1. `lib/blockchain.ts` - Status marking and confirmation polling
2. `app/api/blockchain/recent-readings/route.ts` - Include pending transactions and status in API
3. `components/sections/blockchain-explorer.tsx` - UI status badges and visual distinction

## Network Configuration

Ensure your `.env` file has the correct network setting:
```bash
BSV_NETWORK=testnet  # or mainnet
```

The wallet keys must match this network, or transactions will appear on the wrong WOC instance:
- Testnet: `test.whatsonchain.com`
- Mainnet: `whatsonchain.com`

---

*Created: 3 October 2025*
*Issue: TXIDs not appearing on WOC due to premature "confirmed" status*
