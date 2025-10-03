# Blockchain Transaction Error Handling Improvements

## Issue
The Blockchain Verification section was displaying malformed URLs for "View TX" links, such as:
```
https://whatsonchain.com/tx/{payload:{...},signature:...,encoding:UTF-8,mimetype:application/json}
```

This occurred because GorillaPool mAPI error responses were being used as transaction IDs instead of being properly detected and handled as errors.

## Root Cause
When GorillaPool's mAPI rejected a transaction (e.g., due to `txn-mempool-conflict`), it returned a JSON response with:
```json
{
  "payload": "{\"returnResult\":\"failure\",\"resultDescription\":\"ERROR: 258: txn-mempool-conflict\",...}",
  "signature": "...",
  "publicKey": "...",
  "encoding": "UTF-8",
  "mimetype": "application/json"
}
```

The code at line 683 of `lib/blockchain.ts` was blindly returning this entire response as the transaction ID: `return gpText.replace(/"/g, '').trim()`

## Solutions Implemented

### 1. Enhanced GorillaPool Error Detection (`lib/blockchain.ts`)
**Lines 659-722**

Added proper parsing and validation of GorillaPool mAPI responses:
- Detects `returnResult: 'failure'` or `returnResult: 'error'` in the payload
- Extracts error descriptions and throws categorised errors:
  - `MEMPOOL_CONFLICT` - Transaction conflicts with existing mempool transaction
  - `ALREADY_KNOWN` - Transaction already broadcast to network
  - `LOW_FEE` - Insufficient transaction fee
- Validates that txids are exactly 64 hexadecimal characters before returning
- Throws descriptive errors instead of returning malformed data

### 2. Txid Validation in API (`app/api/blockchain/recent-readings/route.ts`)
**Lines 33-35**

Added database-level filtering to prevent malformed txids from appearing in the UI:
```sql
AND txid NOT LIKE 'error_%'
AND LENGTH(txid) = 64
AND txid ~ '^[0-9a-fA-F]{64}$'
```

This ensures only valid BSV transaction IDs (64-character hex strings) are displayed.

### 3. Enhanced Re-Queue Logic (`lib/worker-queue.ts`)
**Lines 413-503**

Implemented intelligent retry strategies based on error type:

#### Mempool Conflicts
- **Delay**: Minimum 30 seconds (instead of exponential backoff from low values)
- **Strategy**: Force UTXO lock cleanup to use different inputs on retry
- **Rationale**: Mempool conflicts occur when trying to spend UTXOs that are already in pending transactions. Using different UTXOs resolves this.

#### Already Known Transactions
- **Action**: Immediately mark as completed (no retry)
- **Rationale**: Transaction is already on the blockchain/in mempool, retry would be wasteful

#### Low Fee Errors
- **Delay**: Minimum 60 seconds
- **Strategy**: Wait for mempool to clear
- **Rationale**: Low fee transactions may be accepted when mempool traffic reduces

#### UTXO Exhaustion
- **Delay**: Minimum 45 seconds
- **Strategy**: Force UTXO lock cleanup and wait for confirmations
- **Rationale**: Need time for pending UTXOs to confirm

#### UTXO Lock Conflicts
- **Delay**: Minimum 5 seconds
- **Strategy**: Release expired locks immediately
- **Rationale**: Quick cleanup allows the transaction to proceed with freed UTXOs

## Benefits

1. **Correct Blockchain Explorer Links**: Only valid transaction IDs are used for WhatOnChain links
2. **Better Error Messages**: Users see meaningful error descriptions in logs
3. **Intelligent Retries**: Failed transactions are retried with strategies appropriate to the error type
4. **Reduced Failures**: UTXO lock management prevents conflicts between concurrent transactions
5. **Resource Efficiency**: Transactions already on-chain aren't retried unnecessarily

## Testing Recommendations

1. Monitor worker logs for retry messages showing error categories
2. Verify "View TX" links on the Blockchain Verification section go to valid transactions
3. Check that mempool conflicts are resolved after 30+ second delays
4. Confirm UTXO lock conflicts clear quickly (5-10 seconds)

## Configuration

Retry behaviour can be adjusted via environment variables:
- `BSV_TRANSACTION_RETRY_DELAY_MS`: Base retry delay (default from config)
- `BSV_TRANSACTION_MAX_RETRIES`: Maximum retry attempts (default from config)

## Error Type Detection

The system now categorises errors and applies different strategies:

| Error Pattern | Category | Min Delay | UTXO Lock Cleanup |
|--------------|----------|-----------|-------------------|
| `MEMPOOL_CONFLICT` | Mempool conflict | 30s | Yes |
| `ALREADY_KNOWN` | Duplicate | N/A (complete) | No |
| `LOW_FEE` | Fee too low | 60s | No |
| `No UTXOs available` | UTXO exhaustion | 45s | Yes |
| `already reserved` | Lock conflict | 5s | Yes |
| Other | General error | Exponential backoff | No |

## Related Files Modified

1. `lib/blockchain.ts` - GorillaPool response parsing and error detection
2. `app/api/blockchain/recent-readings/route.ts` - Txid validation in database query
3. `lib/worker-queue.ts` - Enhanced retry logic with error-specific strategies

---

*Created: 3 October 2025*
*Issue: Malformed blockchain verification links displaying error responses as transaction IDs*

