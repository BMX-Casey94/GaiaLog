/**
 * Canonical Explorer Decoder
 *
 * Converts a StoredReading (produced by all three ingest paths) into the
 * overlay explorer row format.  The key responsibility is:
 *   1. Normalise data_family via stream-registry
 *   2. Normalise location to lowercase for trigram indexing
 *   3. Resolve provider_id from the raw source label where possible
 *   4. Build a compact metrics_preview containing only the keys the explorer
 *      UI needs (pre-computed once at write time, never re-extracted at read time)
 */

import { normaliseDataFamily, resolveProviderIdFromSource, DATA_FAMILY_DESCRIPTORS, type DataFamily } from './stream-registry'
import type { StoredReading } from './supabase-explorer'
import { reverseGeocode, buildDisplayLocation, locationNeedsGeocoding } from './reverse-geocoder'

// ─── Public Types ────────────────────────────────────────────────────────────

export interface OverlayExplorerReading {
  txid: string
  dataFamily: string
  providerId: string | null
  datasetId: string | null
  location: string | null
  normalizedLocation: string | null
  lat: number | null
  lon: number | null
  readingTs: Date
  blockHeight: number
  blockTime: Date | null
  confirmed: boolean
  metricsPreview: Record<string, unknown>
}

// ─── Metric Preview Keys ─────────────────────────────────────────────────────
// Superset of every metric key surfaced in the explorer UI.  Matches the
// SEARCH_METRIC_KEYS array in supabase-explorer.ts so the API response shape
// is byte-identical after the switchover.

const METRIC_PREVIEW_KEYS = new Set([
  'air_quality_index', 'aqi', 'fine_particulate_matter_pm25', 'pm25',
  'coarse_particulate_matter_pm10', 'pm10', 'carbon_monoxide', 'co',
  'nitrogen_dioxide', 'no2', 'ozone', 'o3',
  'river_level', 'sea_level', 'level', 'tide_height',
  'wave_height_m', 'water_temperature_c', 'air_temperature_c',
  'salinity_psu', 'pressure_hpa',
  'magnitude', 'depth', 'depth_km', 'latitude', 'lat', 'longitude', 'lon',
  'uv_index', 'soil_moisture_pct', 'soil_moisture', 'wildfire_risk',
  'environmental_quality_score', 'environmental_score',
  'temperature_c', 'humidity_pct',
  'x', 'y', 'z', 'h', 'f', 'd',
  'alert_level', 'aviation_color_code', 'eruption_probability', 'gas_flux',
  'speed', 'density', 'temperature', 'bz', 'bt',
  'altitude_m', 'wind_kph', 'pressure_mb',
  // biodiversity
  'species', 'scientific_name', 'taxon_rank', 'observation_count',
  'kingdom', 'phylum', 'class', 'order', 'family', 'genus',
  'locality', 'event_date', 'recorded_by', 'institution_code', 'accepted_scientific_name',
  'region', 'county', 'city', 'continent', 'country_code', 'catalog_number', 'basis_of_record', 'dataset_name',
  'iconic_taxon', 'quality_grade', 'description', 'captive', 'threatened', 'endemic', 'introduced',
  'observed_on_string', 'positional_accuracy_m', 'photo_url', 'identifications_count', 'num_identification_agreements',
  'depth',
  // conservation
  'listing_status', 'threat_category', 'population_trend', 'conservation_rank',
  // hydrology
  'discharge_cfs', 'gage_height_ft', 'water_temperature_c', 'dissolved_oxygen_mg_l',
  'specific_conductance', 'ph', 'turbidity_ntu', 'river_level_m', 'typical_range_high', 'typical_range_low',
  'station_id', 'station_name', 'river_name', 'town', 'catchment_name',
  'ea_area_name', 'station_status', 'parameter', 'parameter_name', 'qualifier', 'unit_name', 'measure_id',
  // flood risk
  'severity_level', 'flood_area', 'river_level_m', 'is_rising',
  // land-use change
  'alert_confidence', 'tree_cover_loss_ha', 'disturbance_type',
  // natural events
  'event_type', 'category', 'magnitude_value', 'magnitude_unit',
  // mining
  'commodity', 'deposit_type', 'development_status', 'site_name',
  // transport
  'callsign', 'origin_country', 'velocity_ms', 'on_ground', 'icao24',
  'mmsi', 'vessel_name', 'ship_type', 'heading', 'course',
  // planning & development
  'application_ref', 'proposal', 'status', 'decision_date',
])

// ─── Conversion ──────────────────────────────────────────────────────────────

export function toOverlayExplorerReading(
  reading: StoredReading,
  extra?: { providerId?: string | null; datasetId?: string | null },
): OverlayExplorerReading {
  const dataFamily = normaliseDataFamily(reading.dataType) || reading.dataType
  const resolvedProviderId =
    extra?.providerId ??
    resolveProviderIdFromSource(reading.provider) ??
    null
  const resolvedDatasetId = extra?.datasetId ?? null

  const location = reading.location?.trim() || null
  const normalizedLocation = location ? location.toLowerCase() : null

  let lat = reading.lat
  let lon = reading.lon
  if (lat == null && reading.metrics) {
    lat = reading.metrics.coordinates?.lat
      ?? reading.metrics.coordinates?.latitude
      ?? reading.metrics.latitude
      ?? null
  }
  if (lon == null && reading.metrics) {
    lon = reading.metrics.coordinates?.lon
      ?? reading.metrics.coordinates?.longitude
      ?? reading.metrics.longitude
      ?? null
  }

  const readingTs = new Date(reading.timestamp)
  const blockTime = reading.blockTime ? new Date(reading.blockTime) : null
  const confirmed = reading.blockHeight > 0

  const metricsPreview = buildMetricsPreview(reading.metrics, dataFamily, lat, lon)

  return {
    txid: reading.txid,
    dataFamily,
    providerId: resolvedProviderId,
    datasetId: resolvedDatasetId,
    location,
    normalizedLocation,
    lat: lat != null ? Number(lat) : null,
    lon: lon != null ? Number(lon) : null,
    readingTs,
    blockHeight: reading.blockHeight,
    blockTime,
    confirmed,
    metricsPreview,
  }
}

/**
 * Enrich an OverlayExplorerReading with a reverse-geocoded location when the
 * existing location is missing or coordinate-based.  Returns a new object if
 * enrichment succeeds, or the original unchanged.  Never throws.
 */
export async function enrichWithGeocodedLocation(
  reading: OverlayExplorerReading,
): Promise<OverlayExplorerReading> {
  if (!locationNeedsGeocoding(reading.location)) return reading
  if (reading.lat == null || reading.lon == null) return reading

  try {
    const place = await reverseGeocode(reading.lat, reading.lon)
    if (!place) return reading

    const displayLocation = buildDisplayLocation(place)
    if (!displayLocation) return reading

    return {
      ...reading,
      location: displayLocation,
      normalizedLocation: displayLocation.toLowerCase(),
    }
  } catch {
    return reading
  }
}

// ─── Metrics Preview Builder ─────────────────────────────────────────────────

function buildMetricsPreview(
  metrics: Record<string, unknown> | null | undefined,
  dataFamily: string,
  lat: number | null | undefined,
  lon: number | null | undefined,
): Record<string, unknown> {
  if (!metrics || typeof metrics !== 'object') return {}

  const preview: Record<string, unknown> = {}

  const familyDescriptor = DATA_FAMILY_DESCRIPTORS[dataFamily as DataFamily]
  const priorityKeys = familyDescriptor?.metricPreviewKeys

  if (priorityKeys) {
    for (const key of priorityKeys) {
      const val = metrics[key]
      if (val != null && val !== '') preview[key] = val
    }
  }

  for (const key of METRIC_PREVIEW_KEYS) {
    if (key in preview) continue
    const val = metrics[key]
    if (val != null && val !== '') preview[key] = val
  }

  if (preview.lat == null && lat != null) preview.lat = lat
  if (preview.lon == null && lon != null) preview.lon = lon
  if (preview.latitude == null && lat != null) preview.latitude = lat
  if (preview.longitude == null && lon != null) preview.longitude = lon

  return preview
}
