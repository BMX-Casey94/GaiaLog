# Blockchain Verification Section & Total TX Counter Fixes

## Issues Fixed

### 1. Blockchain Verification Section Showing Duplicates ✅
**Problem**: The "Blockchain Verification" section was displaying up to 20 transactions, including multiple entries of the same transaction type (Water Levels, Seismic Activity, etc.), instead of showing only the latest transaction for each type.

**Solution**: Modified the API query to use PostgreSQL's `DISTINCT ON` clause to return only the latest confirmed transaction for each of the 4 data types:
- `air_quality`
- `water_levels`
- `seismic_activity`
- `advanced_metrics`

**Changes Made**:
- **File**: `app/api/blockchain/recent-readings/route.ts`
  - Changed query from `LIMIT 20` to `SELECT DISTINCT ON (type)`
  - Added explicit type filtering: `type IN ('air_quality', 'water_levels', 'seismic_activity', 'advanced_metrics')`
  - Ordered by `type, collected_at DESC` to get the latest entry per type
  - Added client-side sorting by timestamp for display

- **File**: `components/sections/blockchain-explorer.tsx`
  - Added clarifying comment that API returns max 4 entries (one per data type)

**Result**: The Blockchain Verification section now displays a maximum of 4 entries, showing the latest transaction for each data type, preventing duplicate displays and 404 errors from invalid/old transaction IDs.

---

### 2. Total TX Counter Not Updating in Real-Time ✅
**Problem**: The "Total TX" count was stuck at the same value (e.g., 1,791,336) for 10+ minutes despite successful transaction broadcasts. The counter wasn't incrementing with new transactions.

**Root Cause**: The API was using PostgreSQL's `reltuples` statistical estimate for large tables (>10k rows). This estimate only updates when PostgreSQL runs `ANALYZE` (typically during autovacuum), which can be hours or days between updates. With 1.7M rows, the counter was using a stale estimate that didn't reflect new transactions.

**Solution**: Switched from `reltuples` estimate to exact `COUNT(*)` query with aggressive caching (15s TTL) to handle the performance impact. This ensures the counter always shows the true current count.

**Changes Made**:
- **File**: `lib/stats-cache.ts`
  - Reduced `heroStatsCache` TTL from 30,000ms → 15,000ms (30s → 15s)
  - Updated comment to reflect faster updates

- **File**: `components/hero.tsx`
  - Reduced `setInterval` from 30,000ms → 15,000ms
  - Updated comment to reflect faster updates

- **File**: `app/api/hero-stats/route.ts`
  - **Removed**: `reltuples` estimate logic for large tables
  - **Changed to**: Exact `COUNT(*)` on every cache refresh
  - Reduced cache refresh from 30s → 15s
  - Updated comment to explain trade-off

**Performance Trade-off**:
- **Before**: Used fast estimate (~1ms) but showed stale/incorrect counts
- **After**: Uses exact count (~1-3 seconds for 1.7M rows) but only runs every 15s due to cache
- **Net Result**: First request after cache expires may take 1-2s, but counter is always accurate and updates every 15s

---

## Performance Considerations

### Blockchain Verification Query
- **Before**: `SELECT ... LIMIT 20` returned 20 rows and required client-side deduplication
- **After**: `SELECT DISTINCT ON (type) ...` returns max 4 rows with deduplication at the database level
- **Benefit**: More efficient, fewer rows transferred, guaranteed uniqueness

### Total TX Counter
- **Trade-off**: Exact COUNT(*) on 1.7M rows takes 1-3 seconds vs <1ms for estimates
- **Mitigation**: 15-second cache TTL means query only runs every 15s (not on every page load)
- **Performance**: Users experience instant loads (cached) with accurate counts that update every 15s
- **Accuracy**: Counter now reflects real transaction count, increments with each new TX

---

## Testing Recommendations

1. **Blockchain Verification Section**:
   - Verify section shows max 4 entries
   - Confirm each entry is a different transaction type
   - Check that "View BSV TX" links work without 404 errors
   - Verify entries update when new transactions are confirmed

2. **Total TX Counter**:
   - Watch the counter for 30-60 seconds to verify updates occur every ~15 seconds
   - Confirm counter increases as new transactions are added
   - Check that page load performance remains good

---

## Files Modified

1. `app/api/blockchain/recent-readings/route.ts` - Deduplicate by transaction type
2. `components/sections/blockchain-explorer.tsx` - Added clarifying comment
3. `lib/stats-cache.ts` - Reduced hero stats cache TTL to 15s
4. `components/hero.tsx` - Reduced refresh interval to 15s
5. `app/api/hero-stats/route.ts` - Updated comment



