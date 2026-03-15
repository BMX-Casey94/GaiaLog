export type QueueLane = 'throughput' | 'coverage'
export type QueuePriority = 'high' | 'normal'
export type ProviderKind = 'poll' | 'bulk' | 'push'
export type ThroughputClass = 'very_high' | 'high' | 'medium' | 'low'

export const PROVIDER_IDS = [
  'waqi',
  'weatherapi',
  'noaa',
  'noaa_ndbc',
  'noaa_space_weather',
  'usgs',
  'usgs_geomagnetism',
  'usgs_volcanoes',
  'owm',
  'sensor_community',
  'emsc',
  'geonet',
  'iris',
  'opensensemap',
  'intermagnet',
  'copernicus_cams',
  'nasa_power',
  'igra2',
] as const

export type ProviderId = (typeof PROVIDER_IDS)[number]

export const DATA_FAMILY_DESCRIPTORS = {
  air_quality: {
    id: 'air_quality',
    label: 'Air Quality',
    icon: 'Database',
    color: 'blue',
    glowColor: 'blue',
    accent: 'text-blue-400',
    metricPreviewKeys: ['air_quality_index', 'aqi', 'pm25', 'pm10', 'temperature_c', 'humidity_pct'],
  },
  water_levels: {
    id: 'water_levels',
    label: 'Water Levels',
    icon: 'Droplets',
    color: 'cyan',
    glowColor: 'cyan',
    accent: 'text-cyan-400',
    metricPreviewKeys: ['sea_level', 'river_level', 'level_m', 'wave_height_m', 'water_temperature_c'],
  },
  seismic_activity: {
    id: 'seismic_activity',
    label: 'Seismic Activity',
    icon: 'Activity',
    color: 'orange',
    glowColor: 'orange',
    accent: 'text-orange-400',
    metricPreviewKeys: ['magnitude', 'depth', 'depth_km', 'latitude', 'longitude'],
  },
  advanced_metrics: {
    id: 'advanced_metrics',
    label: 'Advanced Metrics',
    icon: 'Thermometer',
    color: 'purple',
    glowColor: 'purple',
    accent: 'text-purple-400',
    metricPreviewKeys: ['uv_index', 'soil_moisture', 'temperature_c', 'humidity_pct', 'pressure_mb'],
  },
  geomagnetism: {
    id: 'geomagnetism',
    label: 'Geomagnetism',
    icon: 'Magnet',
    color: 'emerald',
    glowColor: 'blue',
    accent: 'text-emerald-400',
    metricPreviewKeys: ['x', 'y', 'z', 'f', 'h', 'd'],
  },
  volcanic_activity: {
    id: 'volcanic_activity',
    label: 'Volcanic Activity',
    icon: 'Mountain',
    color: 'rose',
    glowColor: 'orange',
    accent: 'text-rose-400',
    metricPreviewKeys: ['alert_level', 'aviation_color_code', 'eruption_probability', 'gas_flux'],
  },
  space_weather: {
    id: 'space_weather',
    label: 'Space Weather',
    icon: 'Orbit',
    color: 'indigo',
    glowColor: 'purple',
    accent: 'text-indigo-400',
    metricPreviewKeys: ['speed', 'density', 'temperature', 'bz', 'bt'],
  },
  upper_atmosphere: {
    id: 'upper_atmosphere',
    label: 'Upper Atmosphere',
    icon: 'Cloud',
    color: 'sky',
    glowColor: 'cyan',
    accent: 'text-sky-400',
    metricPreviewKeys: ['temperature_c', 'humidity_pct', 'wind_kph', 'pressure_mb', 'altitude_m'],
  },
} as const

export type DataFamily = keyof typeof DATA_FAMILY_DESCRIPTORS

export interface ProviderDescriptor {
  id: ProviderId
  displayName: string
  primaryFamily: DataFamily
  kind: ProviderKind
  queueLane: QueueLane
  throughputClass: ThroughputClass
  keyRequired: boolean
  blockchainFriendly: boolean
  attributionRequired?: boolean
  attributionText?: string
  sourceAliases: string[]
}

export interface ProviderDatasetDescriptor {
  id: string
  providerId: ProviderId
  family: DataFamily
  displayName: string
  sourceLabel: string
  kind: ProviderKind
  queueLane: QueueLane
  defaultPriority: QueuePriority
  defaultIntervalMs: number
  defaultChunkSize: number
  keyRequired: boolean
  blockchainFriendly: boolean
  metricPreviewKeys?: string[]
  aliases?: string[]
}

export const PROVIDER_DESCRIPTORS = {
  waqi: {
    id: 'waqi',
    displayName: 'WAQI',
    primaryFamily: 'air_quality',
    kind: 'poll',
    queueLane: 'coverage',
    throughputClass: 'medium',
    keyRequired: true,
    blockchainFriendly: true,
    sourceAliases: ['WAQI'],
  },
  weatherapi: {
    id: 'weatherapi',
    displayName: 'WeatherAPI',
    primaryFamily: 'advanced_metrics',
    kind: 'poll',
    queueLane: 'coverage',
    throughputClass: 'medium',
    keyRequired: true,
    blockchainFriendly: true,
    sourceAliases: ['WeatherAPI.com', 'WeatherAPI-derived metrics', 'WeatherAPI'],
  },
  noaa: {
    id: 'noaa',
    displayName: 'NOAA CO-OPS',
    primaryFamily: 'water_levels',
    kind: 'poll',
    queueLane: 'throughput',
    throughputClass: 'high',
    keyRequired: false,
    blockchainFriendly: true,
    sourceAliases: ['NOAA Tides & Currents'],
  },
  noaa_ndbc: {
    id: 'noaa_ndbc',
    displayName: 'NOAA NDBC',
    primaryFamily: 'water_levels',
    kind: 'bulk',
    queueLane: 'throughput',
    throughputClass: 'very_high',
    keyRequired: false,
    blockchainFriendly: true,
    sourceAliases: ['NOAA NDBC', 'NOAA National Data Buoy Center'],
  },
  noaa_space_weather: {
    id: 'noaa_space_weather',
    displayName: 'NOAA Space Weather',
    primaryFamily: 'space_weather',
    kind: 'poll',
    queueLane: 'coverage',
    throughputClass: 'medium',
    keyRequired: false,
    blockchainFriendly: true,
    sourceAliases: ['NOAA Space Weather', 'NOAA DSCOVR', 'NOAA ACE'],
  },
  usgs: {
    id: 'usgs',
    displayName: 'USGS Earthquake',
    primaryFamily: 'seismic_activity',
    kind: 'poll',
    queueLane: 'coverage',
    throughputClass: 'medium',
    keyRequired: false,
    blockchainFriendly: true,
    sourceAliases: ['USGS Earthquake API', 'USGS Earthquake'],
  },
  usgs_geomagnetism: {
    id: 'usgs_geomagnetism',
    displayName: 'USGS Geomagnetism',
    primaryFamily: 'geomagnetism',
    kind: 'poll',
    queueLane: 'coverage',
    throughputClass: 'medium',
    keyRequired: false,
    blockchainFriendly: true,
    sourceAliases: ['USGS Geomagnetism'],
  },
  usgs_volcanoes: {
    id: 'usgs_volcanoes',
    displayName: 'USGS Volcanoes',
    primaryFamily: 'volcanic_activity',
    kind: 'poll',
    queueLane: 'coverage',
    throughputClass: 'low',
    keyRequired: false,
    blockchainFriendly: true,
    sourceAliases: ['USGS Volcanoes', 'USGS Volcano Hazards Program'],
  },
  owm: {
    id: 'owm',
    displayName: 'OpenWeatherMap',
    primaryFamily: 'advanced_metrics',
    kind: 'poll',
    queueLane: 'coverage',
    throughputClass: 'medium',
    keyRequired: true,
    blockchainFriendly: true,
    sourceAliases: ['OWM-derived metrics', 'OpenWeatherMap', 'OWM'],
  },
  sensor_community: {
    id: 'sensor_community',
    displayName: 'Sensor.Community',
    primaryFamily: 'air_quality',
    kind: 'bulk',
    queueLane: 'throughput',
    throughputClass: 'very_high',
    keyRequired: false,
    blockchainFriendly: true,
    attributionRequired: true,
    attributionText: 'Sensor.Community data is shared under ODbL; attribution is required if derived datasets are redistributed.',
    sourceAliases: ['Sensor.Community'],
  },
  emsc: {
    id: 'emsc',
    displayName: 'EMSC',
    primaryFamily: 'seismic_activity',
    kind: 'push',
    queueLane: 'throughput',
    throughputClass: 'high',
    keyRequired: false,
    blockchainFriendly: true,
    attributionRequired: true,
    attributionText: 'EMSC data is open access with attribution required.',
    sourceAliases: ['EMSC', 'European-Mediterranean Seismological Centre'],
  },
  geonet: {
    id: 'geonet',
    displayName: 'GeoNet NZ',
    primaryFamily: 'seismic_activity',
    kind: 'poll',
    queueLane: 'throughput',
    throughputClass: 'high',
    keyRequired: false,
    blockchainFriendly: true,
    attributionRequired: true,
    attributionText: 'GeoNet NZ data is licensed under CC BY 4.0 NZ and requires attribution.',
    sourceAliases: ['GeoNet NZ', 'GeoNet'],
  },
  iris: {
    id: 'iris',
    displayName: 'IRIS EarthScope',
    primaryFamily: 'seismic_activity',
    kind: 'poll',
    queueLane: 'coverage',
    throughputClass: 'high',
    keyRequired: false,
    blockchainFriendly: true,
    attributionRequired: true,
    attributionText: 'IRIS EarthScope data is open and should be attributed to the source network.',
    sourceAliases: ['IRIS', 'EarthScope', 'IRIS EarthScope'],
  },
  opensensemap: {
    id: 'opensensemap',
    displayName: 'openSenseMap',
    primaryFamily: 'air_quality',
    kind: 'bulk',
    queueLane: 'coverage',
    throughputClass: 'high',
    keyRequired: false,
    blockchainFriendly: true,
    attributionRequired: true,
    attributionText: 'openSenseMap data is shared under ODbL; attribution is required if derived datasets are redistributed.',
    sourceAliases: ['openSenseMap'],
  },
  intermagnet: {
    id: 'intermagnet',
    displayName: 'INTERMAGNET',
    primaryFamily: 'geomagnetism',
    kind: 'poll',
    queueLane: 'coverage',
    throughputClass: 'medium',
    keyRequired: false,
    blockchainFriendly: true,
    attributionRequired: true,
    attributionText: 'INTERMAGNET data is open scientific data and requires attribution.',
    sourceAliases: ['INTERMAGNET'],
  },
  copernicus_cams: {
    id: 'copernicus_cams',
    displayName: 'Copernicus CAMS',
    primaryFamily: 'air_quality',
    kind: 'poll',
    queueLane: 'coverage',
    throughputClass: 'low',
    keyRequired: true,
    blockchainFriendly: true,
    attributionRequired: true,
    attributionText: 'Copernicus CAMS data is licensed under CC BY 4.0 and requires attribution.',
    sourceAliases: ['Copernicus CAMS', 'CAMS'],
  },
  nasa_power: {
    id: 'nasa_power',
    displayName: 'NASA POWER',
    primaryFamily: 'advanced_metrics',
    kind: 'poll',
    queueLane: 'coverage',
    throughputClass: 'low',
    keyRequired: false,
    blockchainFriendly: true,
    sourceAliases: ['NASA POWER'],
  },
  igra2: {
    id: 'igra2',
    displayName: 'IGRA v2',
    primaryFamily: 'upper_atmosphere',
    kind: 'poll',
    queueLane: 'coverage',
    throughputClass: 'medium',
    keyRequired: false,
    blockchainFriendly: true,
    sourceAliases: ['IGRA v2', 'IGRA2'],
  },
} as const satisfies Record<ProviderId, ProviderDescriptor>

export const DATASET_DESCRIPTORS = {
  waqi_station_feed: {
    id: 'waqi_station_feed',
    providerId: 'waqi',
    family: 'air_quality',
    displayName: 'WAQI Station Feed',
    sourceLabel: 'WAQI',
    kind: 'poll',
    queueLane: 'coverage',
    defaultPriority: 'normal',
    defaultIntervalMs: 10 * 60 * 1000,
    defaultChunkSize: 150,
    keyRequired: true,
    blockchainFriendly: true,
    metricPreviewKeys: ['aqi', 'pm25', 'pm10', 'co', 'no2', 'o3'],
  },
  weatherapi_air_quality: {
    id: 'weatherapi_air_quality',
    providerId: 'weatherapi',
    family: 'air_quality',
    displayName: 'WeatherAPI Air Quality',
    sourceLabel: 'WeatherAPI.com',
    kind: 'poll',
    queueLane: 'coverage',
    defaultPriority: 'normal',
    defaultIntervalMs: 10 * 60 * 1000,
    defaultChunkSize: 100,
    keyRequired: true,
    blockchainFriendly: true,
  },
  weatherapi_advanced_metrics: {
    id: 'weatherapi_advanced_metrics',
    providerId: 'weatherapi',
    family: 'advanced_metrics',
    displayName: 'WeatherAPI Advanced Metrics',
    sourceLabel: 'WeatherAPI-derived metrics',
    kind: 'poll',
    queueLane: 'coverage',
    defaultPriority: 'normal',
    defaultIntervalMs: 10 * 60 * 1000,
    defaultChunkSize: 100,
    keyRequired: true,
    blockchainFriendly: true,
  },
  owm_advanced_metrics: {
    id: 'owm_advanced_metrics',
    providerId: 'owm',
    family: 'advanced_metrics',
    displayName: 'OWM Advanced Metrics',
    sourceLabel: 'OWM-derived metrics',
    kind: 'poll',
    queueLane: 'coverage',
    defaultPriority: 'normal',
    defaultIntervalMs: 10 * 60 * 1000,
    defaultChunkSize: 100,
    keyRequired: true,
    blockchainFriendly: true,
  },
  noaa_coops_water_levels: {
    id: 'noaa_coops_water_levels',
    providerId: 'noaa',
    family: 'water_levels',
    displayName: 'NOAA CO-OPS Water Levels',
    sourceLabel: 'NOAA Tides & Currents',
    kind: 'poll',
    queueLane: 'throughput',
    defaultPriority: 'normal',
    defaultIntervalMs: 10 * 60 * 1000,
    defaultChunkSize: 500,
    keyRequired: false,
    blockchainFriendly: true,
  },
  noaa_ndbc_latest_obs: {
    id: 'noaa_ndbc_latest_obs',
    providerId: 'noaa_ndbc',
    family: 'water_levels',
    displayName: 'NOAA NDBC Latest Observations',
    sourceLabel: 'NOAA NDBC',
    kind: 'bulk',
    queueLane: 'throughput',
    defaultPriority: 'normal',
    defaultIntervalMs: 5 * 60 * 1000,
    defaultChunkSize: 1000,
    keyRequired: false,
    blockchainFriendly: true,
  },
  usgs_earthquakes: {
    id: 'usgs_earthquakes',
    providerId: 'usgs',
    family: 'seismic_activity',
    displayName: 'USGS Earthquakes',
    sourceLabel: 'USGS Earthquake API',
    kind: 'poll',
    queueLane: 'coverage',
    defaultPriority: 'high',
    defaultIntervalMs: 10 * 60 * 1000,
    defaultChunkSize: 1000,
    keyRequired: false,
    blockchainFriendly: true,
  },
  sensor_community_air_quality: {
    id: 'sensor_community_air_quality',
    providerId: 'sensor_community',
    family: 'air_quality',
    displayName: 'Sensor.Community Air Quality',
    sourceLabel: 'Sensor.Community',
    kind: 'bulk',
    queueLane: 'throughput',
    defaultPriority: 'normal',
    defaultIntervalMs: 5 * 60 * 1000,
    defaultChunkSize: 5000,
    keyRequired: false,
    blockchainFriendly: true,
  },
  emsc_realtime_events: {
    id: 'emsc_realtime_events',
    providerId: 'emsc',
    family: 'seismic_activity',
    displayName: 'EMSC Real-time Events',
    sourceLabel: 'EMSC',
    kind: 'push',
    queueLane: 'throughput',
    defaultPriority: 'high',
    defaultIntervalMs: 60 * 1000,
    defaultChunkSize: 500,
    keyRequired: false,
    blockchainFriendly: true,
  },
  geonet_realtime_events: {
    id: 'geonet_realtime_events',
    providerId: 'geonet',
    family: 'seismic_activity',
    displayName: 'GeoNet Real-time Events',
    sourceLabel: 'GeoNet NZ',
    kind: 'poll',
    queueLane: 'throughput',
    defaultPriority: 'high',
    defaultIntervalMs: 5 * 60 * 1000,
    defaultChunkSize: 1000,
    keyRequired: false,
    blockchainFriendly: true,
  },
  opensensemap_boxes: {
    id: 'opensensemap_boxes',
    providerId: 'opensensemap',
    family: 'air_quality',
    displayName: 'openSenseMap Boxes',
    sourceLabel: 'openSenseMap',
    kind: 'bulk',
    queueLane: 'coverage',
    defaultPriority: 'normal',
    defaultIntervalMs: 15 * 60 * 1000,
    defaultChunkSize: 5000,
    keyRequired: false,
    blockchainFriendly: true,
  },
  noaa_space_weather_rtsw: {
    id: 'noaa_space_weather_rtsw',
    providerId: 'noaa_space_weather',
    family: 'space_weather',
    displayName: 'NOAA Space Weather RTSW',
    sourceLabel: 'NOAA Space Weather',
    kind: 'poll',
    queueLane: 'coverage',
    defaultPriority: 'high',
    defaultIntervalMs: 60 * 1000,
    defaultChunkSize: 200,
    keyRequired: false,
    blockchainFriendly: true,
  },
  usgs_geomagnetism_observatories: {
    id: 'usgs_geomagnetism_observatories',
    providerId: 'usgs_geomagnetism',
    family: 'geomagnetism',
    displayName: 'USGS Geomagnetism Observatories',
    sourceLabel: 'USGS Geomagnetism',
    kind: 'poll',
    queueLane: 'coverage',
    defaultPriority: 'normal',
    defaultIntervalMs: 60 * 1000,
    defaultChunkSize: 100,
    keyRequired: false,
    blockchainFriendly: true,
  },
  intermagnet_observatories: {
    id: 'intermagnet_observatories',
    providerId: 'intermagnet',
    family: 'geomagnetism',
    displayName: 'INTERMAGNET Observatories',
    sourceLabel: 'INTERMAGNET',
    kind: 'poll',
    queueLane: 'coverage',
    defaultPriority: 'normal',
    defaultIntervalMs: 60 * 1000,
    defaultChunkSize: 200,
    keyRequired: false,
    blockchainFriendly: true,
  },
  usgs_volcano_alerts: {
    id: 'usgs_volcano_alerts',
    providerId: 'usgs_volcanoes',
    family: 'volcanic_activity',
    displayName: 'USGS Volcano Alerts',
    sourceLabel: 'USGS Volcanoes',
    kind: 'poll',
    queueLane: 'coverage',
    defaultPriority: 'high',
    defaultIntervalMs: 10 * 60 * 1000,
    defaultChunkSize: 200,
    keyRequired: false,
    blockchainFriendly: true,
  },
  iris_events: {
    id: 'iris_events',
    providerId: 'iris',
    family: 'seismic_activity',
    displayName: 'IRIS EarthScope Events',
    sourceLabel: 'IRIS EarthScope',
    kind: 'poll',
    queueLane: 'coverage',
    defaultPriority: 'normal',
    defaultIntervalMs: 15 * 60 * 1000,
    defaultChunkSize: 2000,
    keyRequired: false,
    blockchainFriendly: true,
  },
  copernicus_cams_grids: {
    id: 'copernicus_cams_grids',
    providerId: 'copernicus_cams',
    family: 'air_quality',
    displayName: 'Copernicus CAMS Grids',
    sourceLabel: 'Copernicus CAMS',
    kind: 'poll',
    queueLane: 'coverage',
    defaultPriority: 'normal',
    defaultIntervalMs: 6 * 60 * 60 * 1000,
    defaultChunkSize: 500,
    keyRequired: true,
    blockchainFriendly: true,
  },
  nasa_power_points: {
    id: 'nasa_power_points',
    providerId: 'nasa_power',
    family: 'advanced_metrics',
    displayName: 'NASA POWER Points',
    sourceLabel: 'NASA POWER',
    kind: 'poll',
    queueLane: 'coverage',
    defaultPriority: 'normal',
    defaultIntervalMs: 12 * 60 * 60 * 1000,
    defaultChunkSize: 250,
    keyRequired: false,
    blockchainFriendly: true,
  },
  igra2_soundings: {
    id: 'igra2_soundings',
    providerId: 'igra2',
    family: 'upper_atmosphere',
    displayName: 'IGRA v2 Soundings',
    sourceLabel: 'IGRA v2',
    kind: 'poll',
    queueLane: 'coverage',
    defaultPriority: 'normal',
    defaultIntervalMs: 12 * 60 * 60 * 1000,
    defaultChunkSize: 2000,
    keyRequired: false,
    blockchainFriendly: true,
  },
} as const satisfies Record<string, ProviderDatasetDescriptor>

export type DatasetId = keyof typeof DATASET_DESCRIPTORS

export const WORKER_TYPE_TO_FAMILY = {
  'air-quality': 'air_quality',
  'water-level': 'water_levels',
  seismic: 'seismic_activity',
  advanced: 'advanced_metrics',
  geomagnetism: 'geomagnetism',
  volcanic: 'volcanic_activity',
  'space-weather': 'space_weather',
  'upper-atmosphere': 'upper_atmosphere',
} as const satisfies Record<string, DataFamily>

const FAMILY_ALIASES: Record<string, DataFamily> = {
  air_quality: 'air_quality',
  'air-quality': 'air_quality',
  water_levels: 'water_levels',
  water: 'water_levels',
  'water-level': 'water_levels',
  seismic: 'seismic_activity',
  seismic_activity: 'seismic_activity',
  advanced: 'advanced_metrics',
  advanced_metrics: 'advanced_metrics',
  geomagnetism: 'geomagnetism',
  volcanic_activity: 'volcanic_activity',
  volcanic: 'volcanic_activity',
  space_weather: 'space_weather',
  'space-weather': 'space_weather',
  upper_atmosphere: 'upper_atmosphere',
  'upper-atmosphere': 'upper_atmosphere',
}

const SOURCE_ALIAS_TO_PROVIDER_ID = new Map<string, ProviderId>()

for (const provider of Object.values(PROVIDER_DESCRIPTORS)) {
  SOURCE_ALIAS_TO_PROVIDER_ID.set(provider.id.toLowerCase(), provider.id)
  SOURCE_ALIAS_TO_PROVIDER_ID.set(provider.displayName.toLowerCase(), provider.id)
  for (const alias of provider.sourceAliases) {
    SOURCE_ALIAS_TO_PROVIDER_ID.set(alias.toLowerCase(), provider.id)
  }
}
for (const dataset of Object.values(DATASET_DESCRIPTORS)) {
  SOURCE_ALIAS_TO_PROVIDER_ID.set(dataset.sourceLabel.toLowerCase(), dataset.providerId)
  for (const alias of dataset.aliases || []) {
    SOURCE_ALIAS_TO_PROVIDER_ID.set(alias.toLowerCase(), dataset.providerId)
  }
}

export function listProviderIds(): ProviderId[] {
  return Object.keys(PROVIDER_DESCRIPTORS) as ProviderId[]
}

export function listDatasetIds(): DatasetId[] {
  return Object.keys(DATASET_DESCRIPTORS) as DatasetId[]
}

export function getFamilyDescriptor(family: DataFamily) {
  return DATA_FAMILY_DESCRIPTORS[family]
}

export function getProviderDescriptor(providerId: ProviderId) {
  return PROVIDER_DESCRIPTORS[providerId]
}

export function getDatasetDescriptor(datasetId: DatasetId) {
  return DATASET_DESCRIPTORS[datasetId]
}

export function getDatasetsForProvider(providerId: ProviderId): ProviderDatasetDescriptor[] {
  return Object.values(DATASET_DESCRIPTORS).filter(dataset => dataset.providerId === providerId)
}

export function normaliseDataFamily(value: string | null | undefined): DataFamily | null {
  if (!value) return null
  return FAMILY_ALIASES[String(value).trim().toLowerCase()] || null
}

export function getDataFamilyFilterValues(value: string | null | undefined): string[] {
  if (!value) return []

  const raw = String(value).trim()
  if (!raw) return []

  const family = normaliseDataFamily(raw)
  if (!family) return [raw]

  const values = new Set<string>([family])
  for (const [alias, mappedFamily] of Object.entries(FAMILY_ALIASES)) {
    if (mappedFamily === family) values.add(alias)
  }
  return Array.from(values)
}

export function mapWorkerTypeToFamily(type: string): DataFamily {
  return WORKER_TYPE_TO_FAMILY[type as keyof typeof WORKER_TYPE_TO_FAMILY] || 'advanced_metrics'
}

export function isKnownProviderId(value: string): value is ProviderId {
  return value in PROVIDER_DESCRIPTORS
}

export function isKnownDatasetId(value: string): value is DatasetId {
  return value in DATASET_DESCRIPTORS
}

export function resolveProviderIdFromSource(source: string | null | undefined): ProviderId | null {
  if (!source) return null
  return SOURCE_ALIAS_TO_PROVIDER_ID.get(String(source).trim().toLowerCase()) || null
}

export function resolveSourceLabel(providerId?: string | null, datasetId?: string | null, fallback?: string | null): string {
  if (datasetId && isKnownDatasetId(datasetId)) return DATASET_DESCRIPTORS[datasetId].sourceLabel
  if (providerId && isKnownProviderId(providerId)) {
    const provider = PROVIDER_DESCRIPTORS[providerId]
    return provider.sourceAliases[0] || provider.displayName
  }
  return fallback || 'unknown'
}

export function resolveAttributionText(providerId?: string | null, source?: string | null): string | null {
  const resolvedProviderId = providerId && isKnownProviderId(providerId)
    ? providerId
    : resolveProviderIdFromSource(source)
  if (!resolvedProviderId) return null
  return PROVIDER_DESCRIPTORS[resolvedProviderId].attributionText || null
}
