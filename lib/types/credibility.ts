/**
 * GaiaLog Data Credibility Types
 * 
 * These types support scientific credibility and audit-readiness
 * without requiring a database. All metadata is embedded in blockchain payloads.
 */

import { SCHEMA_VERSION } from '../constants'

// =============================================================================
// Validation Types
// =============================================================================

export interface ValidationError {
  field: string
  message: string
  value?: unknown
  severity: 'error' | 'warning'
}

export interface ValidationResult {
  valid: boolean
  errors: ValidationError[]
  warnings: ValidationError[]
  timestamp: string
  validatorVersion: string
}

// =============================================================================
// Quality Scoring Types
// =============================================================================

export interface QualityFactors {
  dataCompleteness: number     // 0-100: How complete is the data?
  dataFreshness: number        // 0-100: How recent is the data?
  dataConsistency: number      // 0-100: Does it match expected patterns?
  sourceReliability: number    // 0-100: How reliable is the source?
  validationScore: number      // 0-100: Did it pass validation?
}

export interface QualityScore {
  overall: number              // 0-100 composite score
  factors: QualityFactors
  grade: 'A' | 'B' | 'C' | 'D' | 'F'  // Letter grade for quick reference
  timestamp: string
}

// =============================================================================
// Pipeline Integrity Types
// =============================================================================

export interface PipelineStage {
  stage: string
  timestamp: string
  inputChecksum: string
  outputChecksum: string
  metadata?: Record<string, unknown>
}

export interface PipelineIntegrityChain {
  stages: PipelineStage[]
  finalChecksum: string
  verified: boolean
}

// =============================================================================
// Credibility Metadata (embedded in blockchain payload)
// =============================================================================

export interface CredibilityMetadata {
  schema_version: string
  quality_score: number
  quality_grade: 'A' | 'B' | 'C' | 'D' | 'F'
  validation_status: 'passed' | 'passed_with_warnings' | 'failed'
  validation_warnings?: string[]
  pipeline_checksum: string
  collected_at: string
  processed_at: string
}

// =============================================================================
// Enhanced Blockchain Payload (what gets written on-chain)
// =============================================================================

export interface EnhancedBlockchainPayload {
  app: string
  schema_version: string
  data_type: string
  timestamp: number
  provider?: string
  payload: Record<string, unknown>
  _credibility: CredibilityMetadata
}

// =============================================================================
// Sensor/Station Metadata Types (for future calibration support)
// =============================================================================

export interface SensorMetadata {
  sensor_id?: string
  station_code?: string
  provider: string
  last_calibration?: string
  calibration_type?: 'initial' | 'scheduled' | 'repair' | 'replacement'
  sensor_model?: string
  firmware_version?: string
}

export interface CalibrationRecord {
  id: string
  sensor_id: string
  station_code: string
  provider: string
  calibration_date: string
  calibration_type: 'initial' | 'scheduled' | 'repair' | 'replacement'
  calibrated_by?: string
  certificate_url?: string
  notes?: string
}

// =============================================================================
// Data Type Specific Validation Ranges
// =============================================================================

export const VALIDATION_RANGES = {
  air_quality: {
    aqi: { min: 0, max: 500, warnMax: 300 },
    pm25: { min: 0, max: 1000, warnMax: 500 },
    pm10: { min: 0, max: 1000, warnMax: 500 },
    co: { min: 0, max: 100, warnMax: 50 },
    no2: { min: 0, max: 500, warnMax: 200 },
    o3: { min: 0, max: 500, warnMax: 200 },
    so2: { min: 0, max: 500, warnMax: 200 },
    temperature_c: { min: -90, max: 60, warnMin: -50, warnMax: 55 },
    humidity_pct: { min: 0, max: 100 },
    pressure_mb: { min: 870, max: 1084 },
    wind_kph: { min: 0, max: 500, warnMax: 200 },
    latitude: { min: -90, max: 90 },
    longitude: { min: -180, max: 180 },
  },
  water_levels: {
    level_m: { min: -100, max: 100 },
    tide_height_m: { min: -20, max: 20 },
    wave_height_m: { min: 0, max: 50, warnMax: 25 },
    salinity_psu: { min: 0, max: 50 },
    dissolved_oxygen_mg_l: { min: 0, max: 20 },
    turbidity_ntu: { min: 0, max: 1000 },
    current_speed_ms: { min: 0, max: 10 },
    current_direction_deg: { min: 0, max: 360 },
    water_temperature_c: { min: -5, max: 40 },
    latitude: { min: -90, max: 90 },
    longitude: { min: -180, max: 180 },
  },
  seismic: {
    magnitude: { min: -2, max: 10, warnMax: 8 },
    depth_km: { min: 0, max: 800, warnMax: 700 },
    latitude: { min: -90, max: 90 },
    longitude: { min: -180, max: 180 },
  },
  advanced_metrics: {
    uv_index: { min: 0, max: 15, warnMax: 11 },
    soil_moisture: { min: 0, max: 1 },
    wildfire_risk: { min: 1, max: 10, warnMax: 8 },
    environmental_score: { min: 0, max: 100 },
    temperature_c: { min: -90, max: 60 },
    humidity_pct: { min: 0, max: 100 },
    pressure_mb: { min: 870, max: 1084 },
    latitude: { min: -90, max: 90 },
    longitude: { min: -180, max: 180 },
  },
} as const

// =============================================================================
// Source Reliability Ratings
// =============================================================================

export const SOURCE_RELIABILITY: Record<string, number> = {
  // Government/official sources - highest reliability
  'USGS Earthquake API': 95,
  'NOAA Tides & Currents': 95,
  
  // Established commercial APIs with quality controls
  'WAQI': 85,
  'WeatherAPI.com': 80,
  'WeatherAPI-derived metrics': 75,
  'OWM-derived metrics': 75,
  
  // Default for unknown sources
  'unknown': 50,
}

// =============================================================================
// Helper to get current schema version
// =============================================================================

export function getCurrentSchemaVersion(): string {
  return SCHEMA_VERSION
}

