import { query } from '@/lib/db'

export function calculateSourceHash(obj: any): string {
  const str = JSON.stringify(obj)
  return Buffer.from(str, 'utf8').toString('base64').slice(0, 64)
}

export async function insertAirQuality(row: {
  provider: string
  station_code?: string | null
  city?: string | null
  lat?: number | null
  lon?: number | null
  aqi?: number | null
  pm25?: number | null
  pm10?: number | null
  co?: number | null
  no2?: number | null
  o3?: number | null
  so2?: number | null
  temperature_c?: number | null
  humidity_pct?: number | null
  pressure_mb?: number | null
  wind_kph?: number | null
  wind_deg?: number | null
  source: string
  source_hash: string
  collected_at: Date
}) {
  await query(
    `INSERT INTO air_quality_readings (
      provider, station_code, city, lat, lon, aqi, pm25, pm10, co, no2, o3, so2,
      temperature_c, humidity_pct, pressure_mb, wind_kph, wind_deg,
      source, source_hash, collected_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20
    ) ON CONFLICT (source_hash) DO NOTHING`,
    [
      row.provider,
      row.station_code ?? null,
      row.city ?? null,
      row.lat ?? null,
      row.lon ?? null,
      row.aqi ?? null,
      row.pm25 ?? null,
      row.pm10 ?? null,
      row.co ?? null,
      row.no2 ?? null,
      row.o3 ?? null,
      row.so2 ?? null,
      row.temperature_c ?? null,
      row.humidity_pct ?? null,
      row.pressure_mb ?? null,
      row.wind_kph ?? null,
      row.wind_deg ?? null,
      row.source,
      row.source_hash,
      row.collected_at,
    ],
  )
}

export async function setAirQualityTxId(source_hash: string, txid: string): Promise<void> {
  try {
    await query(
      `INSERT INTO tx_log (txid, type, provider, collected_at, status, onchain_at)
       VALUES ($1, 'air_quality', 'unknown', now(), 'confirmed', now())
       ON CONFLICT (txid) DO NOTHING`,
      [txid],
    )
  } catch {}
  await query(
    `UPDATE air_quality_readings
     SET txid = $1
     WHERE source_hash = $2
       AND (txid IS NULL OR txid LIKE 'local_%' OR txid LIKE 'error_%')`,
    [txid, source_hash],
  )
}

export async function insertWaterLevel(row: {
  provider: string
  station_code?: string | null
  location?: string | null
  lat?: number | null
  lon?: number | null
  level_m?: number | null
  tide_height_m?: number | null
  wave_height_m?: number | null
  salinity_psu?: number | null
  dissolved_oxygen_mg_l?: number | null
  turbidity_ntu?: number | null
  current_speed_ms?: number | null
  current_direction_deg?: number | null
  wind_kph?: number | null
  wind_deg?: number | null
  source: string
  source_hash: string
  collected_at: Date
}) {
  await query(
    `INSERT INTO water_level_readings (
      provider, station_code, location, lat, lon, level_m, tide_height_m, wave_height_m,
      salinity_psu, dissolved_oxygen_mg_l, turbidity_ntu, current_speed_ms, current_direction_deg,
      wind_kph, wind_deg, source, source_hash, collected_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18
    ) ON CONFLICT (source_hash) DO NOTHING`,
    [
      row.provider,
      row.station_code ?? null,
      row.location ?? null,
      row.lat ?? null,
      row.lon ?? null,
      row.level_m ?? null,
      row.tide_height_m ?? null,
      row.wave_height_m ?? null,
      row.salinity_psu ?? null,
      row.dissolved_oxygen_mg_l ?? null,
      row.turbidity_ntu ?? null,
      row.current_speed_ms ?? null,
      row.current_direction_deg ?? null,
      row.wind_kph ?? null,
      row.wind_deg ?? null,
      row.source,
      row.source_hash,
      row.collected_at,
    ],
  )
}

export async function setWaterLevelTxId(source_hash: string, txid: string): Promise<void> {
  // Ensure txid exists in tx_log before linking to satisfy FK
  try {
    await query(
      `INSERT INTO tx_log (txid, type, provider, collected_at, status, onchain_at)
       VALUES ($1, 'water_levels', 'unknown', now(), 'confirmed', now())
       ON CONFLICT (txid) DO NOTHING`,
      [txid],
    )
  } catch {}
  await query(
    `UPDATE water_level_readings w
     SET txid = $1
     WHERE w.source_hash = $2
       AND (w.txid IS NULL OR w.txid LIKE 'local_%' OR w.txid LIKE 'error_%')`,
    [txid, source_hash],
  )
}

export async function insertSeismic(row: {
  provider: string
  event_id?: string | null
  location?: string | null
  magnitude?: number | null
  depth_km?: number | null
  lat?: number | null
  lon?: number | null
  source_hash: string
  collected_at: Date
}) {
  await query(
    `INSERT INTO seismic_readings (
      provider, event_id, location, magnitude, depth_km, lat, lon, source_hash, collected_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9
    ) ON CONFLICT (source_hash) DO NOTHING`,
    [
      row.provider,
      row.event_id ?? null,
      row.location ?? null,
      row.magnitude ?? null,
      row.depth_km ?? null,
      row.lat ?? null,
      row.lon ?? null,
      row.source_hash,
      row.collected_at,
    ],
  )
}

export async function setSeismicTxId(source_hash: string, txid: string): Promise<void> {
  try {
    await query(
      `INSERT INTO tx_log (txid, type, provider, collected_at, status, onchain_at)
       VALUES ($1, 'seismic_activity', 'unknown', now(), 'confirmed', now())
       ON CONFLICT (txid) DO NOTHING`,
      [txid],
    )
  } catch {}
  await query(
    `UPDATE seismic_readings
     SET txid = $1
     WHERE source_hash = $2
       AND (txid IS NULL OR txid LIKE 'local_%' OR txid LIKE 'error_%')`,
    [txid, source_hash],
  )
}

export async function insertAdvanced(row: {
  provider: string
  city?: string | null
  lat?: number | null
  lon?: number | null
  uv_index?: number | null
  soil_moisture_pct?: number | null
  wildfire_risk?: number | null
  environmental_score?: number | null
  temperature_c?: number | null
  humidity_pct?: number | null
  pressure_mb?: number | null
  wind_kph?: number | null
  wind_deg?: number | null
  source_hash: string
  collected_at: Date
}) {
  await query(
    `INSERT INTO advanced_metrics_readings (
      provider, city, lat, lon, uv_index, soil_moisture_pct, wildfire_risk, environmental_score,
      temperature_c, humidity_pct, pressure_mb, wind_kph, wind_deg, source_hash, collected_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
    ) ON CONFLICT (source_hash) DO NOTHING`,
    [
      row.provider,
      row.city ?? null,
      row.lat ?? null,
      row.lon ?? null,
      row.uv_index ?? null,
      row.soil_moisture_pct ?? null,
      row.wildfire_risk ?? null,
      row.environmental_score ?? null,
      row.temperature_c ?? null,
      row.humidity_pct ?? null,
      row.pressure_mb ?? null,
      row.wind_kph ?? null,
      row.wind_deg ?? null,
      row.source_hash,
      row.collected_at,
    ],
  )
}

export async function setAdvancedTxId(source_hash: string, txid: string): Promise<void> {
  try {
    await query(
      `INSERT INTO tx_log (txid, type, provider, collected_at, status, onchain_at)
       VALUES ($1, 'advanced_metrics', 'unknown', now(), 'confirmed', now())
       ON CONFLICT (txid) DO NOTHING`,
      [txid],
    )
  } catch {}
  await query(
    `UPDATE advanced_metrics_readings
     SET txid = $1
     WHERE source_hash = $2
       AND (txid IS NULL OR txid LIKE 'local_%' OR txid LIKE 'error_%')`,
    [txid, source_hash],
  )
}

export async function upsertStation(station: {
  provider: string
  station_code: string
  name?: string | null
  city?: string | null
  country?: string | null
  lat?: number | null
  lon?: number | null
  metadata?: any
}): Promise<void> {
  await query(
    `INSERT INTO stations (provider, station_code, name, city, country, lat, lon, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (provider, station_code) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, stations.name),
       city = COALESCE(EXCLUDED.city, stations.city),
       country = COALESCE(EXCLUDED.country, stations.country),
       lat = COALESCE(EXCLUDED.lat, stations.lat),
       lon = COALESCE(EXCLUDED.lon, stations.lon),
       metadata = COALESCE(EXCLUDED.metadata, stations.metadata)`,
    [
      station.provider,
      station.station_code,
      station.name ?? null,
      station.city ?? null,
      station.country ?? null,
      station.lat ?? null,
      station.lon ?? null,
      station.metadata ?? null,
    ],
  )
}

export async function getOwmStationsPage(params: {
  countries?: string[]
  offset: number
  limit: number
}): Promise<Array<{ station_code: string; name: string | null; country: string | null; lat: number | null; lon: number | null }>> {
  const where: string[] = ["provider = 'owm'"]
  const values: any[] = []
  if (params.countries && params.countries.length > 0) {
    where.push(`country = ANY($${values.length + 1})`)
    values.push(params.countries.map((c) => c.toUpperCase()))
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  values.push(params.limit, params.offset)
  const sql = `SELECT station_code, name, country, lat, lon
               FROM stations
               ${whereSql}
               ORDER BY station_code
               LIMIT $${values.length - 1}
               OFFSET $${values.length}`
  const rows = await query<any>(sql, values)
  return rows.rows as any
}

export async function getNearestOwmCountry(lat: number, lon: number): Promise<string | null> {
  // Quick bounding-box prefilter (±1.5°), then pick nearest by squared distance
  const sql = `SELECT country, lat, lon
               FROM stations
               WHERE provider = 'owm'
                 AND lat BETWEEN $1 - 1.5 AND $1 + 1.5
                 AND lon BETWEEN $2 - 1.5 AND $2 + 1.5
               ORDER BY (lat - $1) * (lat - $1) + (lon - $2) * (lon - $2)
               LIMIT 1`
  const res = await query<any>(sql, [lat, lon])
  const row = res.rows?.[0]
  return row?.country || null
}

export async function getStationsByProviderPage(params: {
  provider: string
  countries?: string[]
  offset: number
  limit: number
}): Promise<Array<{ station_code: string; name: string | null; country: string | null; lat: number | null; lon: number | null }>> {
  const where: string[] = ['provider = $1']
  const values: any[] = [params.provider]
  if (params.countries && params.countries.length > 0) {
    where.push(`country = ANY($${values.length + 1})`)
    values.push(params.countries.map((c) => c.toUpperCase()))
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  values.push(params.limit, params.offset)
  const sql = `SELECT station_code, name, country, lat, lon
               FROM stations
               ${whereSql}
               ORDER BY station_code
               LIMIT $${values.length - 1}
               OFFSET $${values.length}`
  const rows = await query<any>(sql, values)
  return rows.rows as any
}

export async function readCursor(provider: string, country: string | null, resource: string): Promise<number> {
  const res = await query<any>(
    `SELECT cursor FROM provider_cursors WHERE provider=$1 AND country=$2 AND resource=$3`,
    [provider, country ?? '', resource],
  )
  return res.rows?.[0]?.cursor ?? 0
}

export async function writeCursor(provider: string, country: string | null, resource: string, value: number): Promise<void> {
  await query(
    `INSERT INTO provider_cursors (provider, country, resource, cursor)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (provider, country, resource) DO UPDATE SET cursor=EXCLUDED.cursor, updated_at=now()`,
    [provider, country ?? '', resource, value],
  )
}

export async function upsertTxLog(entry: {
  txid: string
  type: string
  provider: string
  collected_at: Date
  status: 'pending' | 'confirmed' | 'failed'
  onchain_at?: Date | null
  fee_sats?: number | null
  wallet_index?: number | null
  retries?: number | null
  error?: string | null
}) {
  await query(
    `INSERT INTO tx_log (txid, type, provider, collected_at, status, onchain_at, fee_sats, wallet_index, retries, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (txid) DO UPDATE SET
       status=EXCLUDED.status,
       onchain_at=EXCLUDED.onchain_at,
       fee_sats=COALESCE(EXCLUDED.fee_sats, tx_log.fee_sats),
       wallet_index=COALESCE(EXCLUDED.wallet_index, tx_log.wallet_index),
       retries=COALESCE(EXCLUDED.retries, tx_log.retries),
       error=COALESCE(EXCLUDED.error, tx_log.error)`,
    [
      entry.txid,
      entry.type,
      entry.provider,
      entry.collected_at,
      entry.status,
      entry.onchain_at ?? null,
      entry.fee_sats ?? null,
      entry.wallet_index ?? null,
      entry.retries ?? 0,
      entry.error ?? null,
    ],
  )
}


// On-chain per-transaction copies (non-destructive; created lazily)
async function ensureOnchainTables(): Promise<void> {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS air_quality_onchain (
        txid text PRIMARY KEY,
        provider text,
        collected_at timestamptz,
        payload jsonb
      );
      CREATE TABLE IF NOT EXISTS water_levels_onchain (
        txid text PRIMARY KEY,
        provider text,
        collected_at timestamptz,
        payload jsonb
      );
      CREATE TABLE IF NOT EXISTS seismic_onchain (
        txid text PRIMARY KEY,
        provider text,
        collected_at timestamptz,
        payload jsonb
      );
      CREATE TABLE IF NOT EXISTS advanced_metrics_onchain (
        txid text PRIMARY KEY,
        provider text,
        collected_at timestamptz,
        payload jsonb
      );
    `)
  } catch {}
}

export async function upsertAirQualityOnchain(txid: string, provider: string, collectedAt: Date, payload: any): Promise<void> {
  await ensureOnchainTables()
  await query(
    `INSERT INTO air_quality_onchain (txid, provider, collected_at, payload)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (txid) DO NOTHING`,
    [txid, provider, collectedAt, JSON.stringify(payload)],
  )
}

export async function upsertWaterLevelsOnchain(txid: string, provider: string, collectedAt: Date, payload: any): Promise<void> {
  await ensureOnchainTables()
  await query(
    `INSERT INTO water_levels_onchain (txid, provider, collected_at, payload)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (txid) DO NOTHING`,
    [txid, provider, collectedAt, JSON.stringify(payload)],
  )
}

export async function upsertSeismicOnchain(txid: string, provider: string, collectedAt: Date, payload: any): Promise<void> {
  await ensureOnchainTables()
  await query(
    `INSERT INTO seismic_onchain (txid, provider, collected_at, payload)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (txid) DO NOTHING`,
    [txid, provider, collectedAt, JSON.stringify(payload)],
  )
}

export async function upsertAdvancedOnchain(txid: string, provider: string, collectedAt: Date, payload: any): Promise<void> {
  await ensureOnchainTables()
  await query(
    `INSERT INTO advanced_metrics_onchain (txid, provider, collected_at, payload)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (txid) DO NOTHING`,
    [txid, provider, collectedAt, JSON.stringify(payload)],
  )
}


// Contact messages
export type ContactMessage = {
  id?: number
  name: string
  email: string
  message: string
  created_at?: Date
  read_at?: Date | null
  archived?: boolean
}

export async function insertContactMessage(input: { name: string; email: string; message: string }): Promise<void> {
  await query(
    `INSERT INTO contact_messages (name, email, message) VALUES ($1,$2,$3)`,
    [input.name, input.email, input.message],
  )
}

export async function getContactMessagesPage(params: { offset: number; limit: number }): Promise<ContactMessage[]> {
  const res = await query<ContactMessage>(
    `SELECT id, name, email, message, created_at, read_at, archived
     FROM contact_messages
     ORDER BY created_at DESC
     LIMIT $1 OFFSET $2`,
    [params.limit, params.offset],
  )
  return res.rows
}

export async function markContactMessageRead(id: number): Promise<void> {
  await query(`UPDATE contact_messages SET read_at = now() WHERE id = $1`, [id])
}

export async function setContactMessageArchived(id: number, archived: boolean): Promise<void> {
  await query(`UPDATE contact_messages SET archived = $2 WHERE id = $1`, [id, archived])
}

