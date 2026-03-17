import { DataFamily, getFamilyDescriptor, normaliseDataFamily } from './stream-registry'

export interface MetricDisplay {
  label: string
  value: string
}

type MetricBuilder = (metrics: Record<string, any>) => MetricDisplay[]

const GENERIC_META_KEYS = new Set([
  'location',
  'location_ascii',
  'timestamp',
  'payload_sha256',
  'db_source_hash',
  'source_hash',
  'source',
  'provider_id',
  'dataset_id',
  'family',
  'station_id',
  'coordinates',
  'attribution',
  'notice',
  'sensor_type',
  'sensor_id',
  'data_license',
  'license',
])

const METRIC_LABELS: Record<string, string> = {
  air_quality_index: 'Air Quality Index',
  fine_particulate_matter_pm25: 'PM2.5',
  coarse_particulate_matter_pm10: 'PM10',
  carbon_monoxide: 'CO',
  nitrogen_dioxide: 'NO2',
  ozone: 'O3',
  sea_level: 'Sea Level',
  river_level: 'River Level',
  tide_height: 'Tide Height',
  wave_height_m: 'Wave Height',
  water_temperature_c: 'Water Temperature',
  salinity_psu: 'Salinity',
  dissolved_oxygen_mg_l: 'Dissolved Oxygen',
  turbidity_ntu: 'Turbidity',
  wind_speed_kph: 'Wind Speed',
  wind_direction_deg: 'Wind Direction',
  pressure_hpa: 'Pressure',
  air_temperature_c: 'Air Temperature',
  dew_point_c: 'Dew Point',
  visibility_nmi: 'Visibility',
  magnitude: 'Magnitude',
  depth: 'Depth',
  depth_km: 'Depth',
  uv_index: 'UV Index',
  soil_moisture: 'Soil Moisture',
  soil_moisture_pct: 'Soil Moisture',
  wildfire_risk: 'Wildfire Risk',
  environmental_quality_score: 'Environmental Score',
  environmental_score: 'Environmental Score',
  temperature_c: 'Temperature',
  humidity_pct: 'Humidity',
  pressure_mb: 'Pressure',
  x: 'Magnetic X',
  y: 'Magnetic Y',
  z: 'Magnetic Z',
  h: 'Horizontal Intensity',
  f: 'Total Intensity',
  d: 'Declination',
  alert_level: 'Alert Level',
  aviation_color_code: 'Aviation Colour',
  eruption_probability: 'Eruption Probability',
  gas_flux: 'Gas Flux',
  speed: 'Speed',
  density: 'Density',
  temperature: 'Temperature',
  bz: 'Bz',
  bt: 'Bt',
  altitude_m: 'Altitude',
  species: 'Species',
  scientific_name: 'Scientific Name',
  taxon_rank: 'Taxon Rank',
  observation_count: 'Observations',
  kingdom: 'Kingdom',
  listing_status: 'Listing Status',
  threat_category: 'Threat Category',
  population_trend: 'Population Trend',
  conservation_rank: 'Conservation Rank',
  discharge_cfs: 'Discharge (cfs)',
  gage_height_ft: 'Gauge Height (ft)',
  ph: 'pH',
  station_name: 'Station',
  station_reference: 'Station Ref',
  river_name: 'River',
  catchment_name: 'Catchment',
  town: 'Town',
  ea_area_name: 'EA Area',
  station_status: 'Station Status',
  parameter_name: 'Parameter',
  qualifier: 'Qualifier',
  unit_name: 'Unit',
  severity_level: 'Severity Level',
  flood_area: 'Flood Area',
  river_level_m: 'River Level',
  is_rising: 'Rising',
  event_type: 'Event Type',
  alert_confidence: 'Alert Confidence',
  tree_cover_loss_ha: 'Tree Cover Loss (ha)',
  disturbance_type: 'Disturbance Type',
  category: 'Category',
  magnitude_value: 'Magnitude',
  magnitude_unit: 'Unit',
  commodity: 'Commodity',
  deposit_type: 'Deposit Type',
  development_status: 'Development Status',
  site_name: 'Site Name',
  callsign: 'Callsign',
  origin_country: 'Origin Country',
  velocity_ms: 'Velocity (m/s)',
  on_ground: 'On Ground',
  icao24: 'ICAO24',
  mmsi: 'MMSI',
  vessel_name: 'Vessel Name',
  ship_type: 'Ship Type',
  heading: 'Heading',
  course: 'Course',
  application_ref: 'Application Ref',
  proposal: 'Proposal',
  decision_date: 'Decision Date',
}

function num(metrics: Record<string, any>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = metrics[key]
    if (value !== null && value !== undefined && Number.isFinite(Number(value))) return Number(value)
  }
  return null
}

function kmToMiles(km: number | null): number | null {
  return km !== null ? km * 0.621371 : null
}

function formatMetricValue(key: string, value: any): string {
  if (value === null || value === undefined) return '-'
  if (typeof value === 'number') {
    if (key.includes('lat') || key.includes('lon') || key.includes('latitude') || key.includes('longitude')) {
      return value.toFixed(4)
    }
    if (Number.isInteger(value)) return String(value)
    return value.toFixed(2)
  }
  return String(value)
}

function pick(entries: Array<MetricDisplay | null | undefined>): MetricDisplay[] {
  return entries.filter(Boolean) as MetricDisplay[]
}

const FAMILY_METRIC_BUILDERS: Record<DataFamily, MetricBuilder> = {
  air_quality: (metrics) => {
    const aqi = num(metrics, 'air_quality_index', 'aqi')
    const pm25 = num(metrics, 'fine_particulate_matter_pm25', 'pm25')
    const pm10 = num(metrics, 'coarse_particulate_matter_pm10', 'pm10')
    const co = num(metrics, 'carbon_monoxide', 'co')
    const no2 = num(metrics, 'nitrogen_dioxide', 'no2')
    const o3 = num(metrics, 'ozone', 'o3')
    return pick([
      aqi !== null ? { label: 'AQI', value: aqi.toFixed(0) } : null,
      pm25 !== null ? { label: 'PM2.5', value: `${pm25.toFixed(1)} ug/m3` } : null,
      pm10 !== null ? { label: 'PM10', value: `${pm10.toFixed(1)} ug/m3` } : null,
      co !== null ? { label: 'CO', value: co.toFixed(2) } : null,
      no2 !== null ? { label: 'NO2', value: no2.toFixed(2) } : null,
      o3 !== null ? { label: 'O3', value: o3.toFixed(2) } : null,
    ])
  },
  water_levels: (metrics) => {
    const level = num(metrics, 'river_level', 'sea_level', 'level')
    const tide = num(metrics, 'tide_height')
    const wave = num(metrics, 'wave_height_m')
    const temp = num(metrics, 'water_temperature_c', 'air_temperature_c')
    const salinity = num(metrics, 'salinity_psu')
    const pressure = num(metrics, 'pressure_hpa')
    return pick([
      level !== null ? { label: 'Level', value: `${level.toFixed(2)} m` } : null,
      tide !== null ? { label: 'Tide', value: `${tide.toFixed(2)} m` } : null,
      wave !== null ? { label: 'Wave', value: `${wave.toFixed(2)} m` } : null,
      temp !== null ? { label: 'Temp', value: `${temp.toFixed(1)} C` } : null,
      salinity !== null ? { label: 'Salinity', value: `${salinity.toFixed(1)} PSU` } : null,
      pressure !== null ? { label: 'Pressure', value: `${pressure.toFixed(1)} hPa` } : null,
    ])
  },
  seismic_activity: (metrics) => {
    const magnitude = num(metrics, 'magnitude')
    const depthKm = num(metrics, 'depth', 'depth_km')
    const depthMi = kmToMiles(depthKm)
    const lat = num(metrics, 'latitude', 'lat')
    const lon = num(metrics, 'longitude', 'lon')
    return pick([
      magnitude !== null ? { label: 'Magnitude', value: `${magnitude.toFixed(1)} M` } : null,
      depthMi !== null ? { label: 'Depth', value: `${depthMi.toFixed(1)} mi` } : null,
      lat !== null ? { label: 'Latitude', value: lat.toFixed(4) } : null,
      lon !== null ? { label: 'Longitude', value: lon.toFixed(4) } : null,
    ])
  },
  advanced_metrics: (metrics) => {
    const uv = num(metrics, 'uv_index')
    const soilRaw = num(metrics, 'soil_moisture_pct', 'soil_moisture')
    const soilPct = soilRaw !== null ? (soilRaw <= 1 ? soilRaw * 100 : soilRaw) : null
    const wildfire = num(metrics, 'wildfire_risk')
    const envScore = num(metrics, 'environmental_quality_score', 'environmental_score')
    const temp = num(metrics, 'temperature_c')
    const humidity = num(metrics, 'humidity_pct')
    return pick([
      uv !== null ? { label: 'UV Index', value: uv.toFixed(1) } : null,
      soilPct !== null ? { label: 'Soil Moisture', value: `${soilPct.toFixed(0)}%` } : null,
      wildfire !== null ? { label: 'Wildfire Risk', value: `${wildfire.toFixed(0)}/10` } : null,
      envScore !== null ? { label: 'Env Score', value: `${envScore.toFixed(0)}/100` } : null,
      temp !== null ? { label: 'Temp', value: `${temp.toFixed(1)} C` } : null,
      humidity !== null ? { label: 'Humidity', value: `${humidity.toFixed(0)}%` } : null,
    ])
  },
  geomagnetism: (metrics) => pick([
    num(metrics, 'x') !== null ? { label: 'X', value: num(metrics, 'x')!.toFixed(1) } : null,
    num(metrics, 'y') !== null ? { label: 'Y', value: num(metrics, 'y')!.toFixed(1) } : null,
    num(metrics, 'z') !== null ? { label: 'Z', value: num(metrics, 'z')!.toFixed(1) } : null,
    num(metrics, 'h') !== null ? { label: 'H', value: num(metrics, 'h')!.toFixed(1) } : null,
    num(metrics, 'f') !== null ? { label: 'F', value: num(metrics, 'f')!.toFixed(1) } : null,
    num(metrics, 'd') !== null ? { label: 'Declination', value: num(metrics, 'd')!.toFixed(1) } : null,
  ]),
  volcanic_activity: (metrics) => pick([
    metrics.alert_level != null ? { label: 'Alert Level', value: String(metrics.alert_level) } : null,
    metrics.aviation_color_code ? { label: 'Aviation Colour', value: String(metrics.aviation_color_code) } : null,
    num(metrics, 'eruption_probability') !== null ? { label: 'Eruption Risk', value: `${num(metrics, 'eruption_probability')!.toFixed(0)}%` } : null,
    num(metrics, 'gas_flux') !== null ? { label: 'Gas Flux', value: formatMetricValue('gas_flux', num(metrics, 'gas_flux')) } : null,
  ]),
  space_weather: (metrics) => pick([
    num(metrics, 'speed') !== null ? { label: 'Speed', value: `${num(metrics, 'speed')!.toFixed(0)} km/s` } : null,
    num(metrics, 'density') !== null ? { label: 'Density', value: num(metrics, 'density')!.toFixed(2) } : null,
    num(metrics, 'bz') !== null ? { label: 'Bz', value: num(metrics, 'bz')!.toFixed(2) } : null,
    num(metrics, 'bt') !== null ? { label: 'Bt', value: num(metrics, 'bt')!.toFixed(2) } : null,
    num(metrics, 'temperature') !== null ? { label: 'Temp', value: num(metrics, 'temperature')!.toFixed(0) } : null,
  ]),
  upper_atmosphere: (metrics) => pick([
    num(metrics, 'altitude_m') !== null ? { label: 'Altitude', value: `${num(metrics, 'altitude_m')!.toFixed(0)} m` } : null,
    num(metrics, 'temperature_c') !== null ? { label: 'Temp', value: `${num(metrics, 'temperature_c')!.toFixed(1)} C` } : null,
    num(metrics, 'humidity_pct') !== null ? { label: 'Humidity', value: `${num(metrics, 'humidity_pct')!.toFixed(0)}%` } : null,
    num(metrics, 'wind_kph') !== null ? { label: 'Wind', value: `${num(metrics, 'wind_kph')!.toFixed(1)} kph` } : null,
    num(metrics, 'pressure_mb') !== null ? { label: 'Pressure', value: `${num(metrics, 'pressure_mb')!.toFixed(1)} mb` } : null,
  ]),
  biodiversity: (metrics) => pick([
    metrics.species ? { label: 'Species', value: String(metrics.species) } : null,
    metrics.scientific_name ? { label: 'Scientific Name', value: String(metrics.scientific_name) } : null,
    metrics.taxon_rank ? { label: 'Taxon Rank', value: String(metrics.taxon_rank) } : null,
    num(metrics, 'observation_count') !== null ? { label: 'Observations', value: num(metrics, 'observation_count')!.toFixed(0) } : null,
    metrics.kingdom ? { label: 'Kingdom', value: String(metrics.kingdom) } : null,
  ]),
  conservation_status: (metrics) => pick([
    metrics.species ? { label: 'Species', value: String(metrics.species) } : null,
    metrics.listing_status ? { label: 'Listing Status', value: String(metrics.listing_status) } : null,
    metrics.threat_category ? { label: 'Threat Category', value: String(metrics.threat_category) } : null,
    metrics.population_trend ? { label: 'Population Trend', value: String(metrics.population_trend) } : null,
    metrics.conservation_rank ? { label: 'Conservation Rank', value: String(metrics.conservation_rank) } : null,
  ]),
  hydrology: (metrics) => pick([
    num(metrics, 'river_level_m') !== null ? { label: 'River Level', value: `${num(metrics, 'river_level_m')!.toFixed(2)} m` } : null,
    num(metrics, 'discharge_cfs') !== null ? { label: 'Discharge', value: `${num(metrics, 'discharge_cfs')!.toFixed(1)} cfs` } : null,
    num(metrics, 'gage_height_ft') !== null ? { label: 'Gauge Height', value: `${num(metrics, 'gage_height_ft')!.toFixed(2)} ft` } : null,
    num(metrics, 'water_temperature_c') !== null ? { label: 'Water Temp', value: `${num(metrics, 'water_temperature_c')!.toFixed(1)} C` } : null,
    num(metrics, 'dissolved_oxygen_mg_l') !== null ? { label: 'Dissolved O2', value: `${num(metrics, 'dissolved_oxygen_mg_l')!.toFixed(1)} mg/L` } : null,
    num(metrics, 'ph') !== null ? { label: 'pH', value: num(metrics, 'ph')!.toFixed(1) } : null,
    num(metrics, 'turbidity_ntu') !== null ? { label: 'Turbidity', value: `${num(metrics, 'turbidity_ntu')!.toFixed(1)} NTU` } : null,
    metrics.river_name ? { label: 'River', value: String(metrics.river_name) } : null,
    metrics.station_name ? { label: 'Station', value: String(metrics.station_name) } : null,
  ]),
  flood_risk: (metrics) => pick([
    metrics.severity_level ? { label: 'Severity', value: String(metrics.severity_level) } : null,
    metrics.flood_area ? { label: 'Flood Area', value: String(metrics.flood_area) } : null,
    num(metrics, 'river_level_m') !== null ? { label: 'River Level', value: `${num(metrics, 'river_level_m')!.toFixed(2)} m` } : null,
    metrics.is_rising != null ? { label: 'Rising', value: String(metrics.is_rising) } : null,
  ]),
  land_use_change: (metrics) => pick([
    metrics.event_type ? { label: 'Event Type', value: String(metrics.event_type) } : null,
    metrics.alert_confidence ? { label: 'Confidence', value: String(metrics.alert_confidence) } : null,
    num(metrics, 'tree_cover_loss_ha') !== null ? { label: 'Tree Loss', value: `${num(metrics, 'tree_cover_loss_ha')!.toFixed(1)} ha` } : null,
    metrics.disturbance_type ? { label: 'Disturbance', value: String(metrics.disturbance_type) } : null,
  ]),
  natural_events: (metrics) => pick([
    metrics.event_type ? { label: 'Event Type', value: String(metrics.event_type) } : null,
    metrics.category ? { label: 'Category', value: String(metrics.category) } : null,
    num(metrics, 'magnitude_value') !== null ? { label: 'Magnitude', value: formatMetricValue('magnitude_value', num(metrics, 'magnitude_value')) } : null,
    metrics.magnitude_unit ? { label: 'Unit', value: String(metrics.magnitude_unit) } : null,
  ]),
  mining_activity: (metrics) => pick([
    metrics.commodity ? { label: 'Commodity', value: String(metrics.commodity) } : null,
    metrics.deposit_type ? { label: 'Deposit Type', value: String(metrics.deposit_type) } : null,
    metrics.development_status ? { label: 'Status', value: String(metrics.development_status) } : null,
    metrics.site_name ? { label: 'Site', value: String(metrics.site_name) } : null,
  ]),
  transport_tracking: (metrics) => pick([
    metrics.callsign ? { label: 'Callsign', value: String(metrics.callsign) } : null,
    metrics.origin_country ? { label: 'Origin', value: String(metrics.origin_country) } : null,
    num(metrics, 'velocity_ms') !== null ? { label: 'Velocity', value: `${num(metrics, 'velocity_ms')!.toFixed(0)} m/s` } : null,
    num(metrics, 'altitude_m') !== null ? { label: 'Altitude', value: `${num(metrics, 'altitude_m')!.toFixed(0)} m` } : null,
    metrics.on_ground != null ? { label: 'On Ground', value: String(metrics.on_ground) } : null,
  ]),
  planning_development: (metrics) => pick([
    metrics.application_ref ? { label: 'Reference', value: String(metrics.application_ref) } : null,
    metrics.proposal ? { label: 'Proposal', value: String(metrics.proposal).slice(0, 80) } : null,
    metrics.status ? { label: 'Status', value: String(metrics.status) } : null,
    metrics.decision_date ? { label: 'Decision Date', value: String(metrics.decision_date) } : null,
  ]),
}

export function getFamilyUiConfig(dataType: string) {
  const family = normaliseDataFamily(dataType)
  return family ? getFamilyDescriptor(family) : null
}

export function getMetricLabel(key: string): string {
  return METRIC_LABELS[key] || key.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

export function getKeyMetrics(dataType: string, metrics: Record<string, any>, maxItems: number = 6): MetricDisplay[] {
  const family = normaliseDataFamily(dataType)
  if (!family) return getRenderableMetricEntries(metrics, maxItems)
  const builder = FAMILY_METRIC_BUILDERS[family]
  const items = builder ? builder(metrics) : []
  if (items.length > 0) return items.slice(0, maxItems)
  return getRenderableMetricEntries(metrics, maxItems)
}

export function getRenderableMetricEntries(metrics: Record<string, any>, maxItems: number = 24): MetricDisplay[] {
  return Object.entries(metrics || {})
    .filter(([key, value]) => !GENERIC_META_KEYS.has(key) && value !== null && value !== undefined && typeof value !== 'object')
    .slice(0, maxItems)
    .map(([key, value]) => ({
      label: getMetricLabel(key),
      value: formatMetricValue(key, value),
    }))
}

export function getFamilyTitle(dataType: string): string {
  const descriptor = getFamilyUiConfig(dataType)
  return descriptor?.label || dataType
}
