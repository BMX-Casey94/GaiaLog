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
