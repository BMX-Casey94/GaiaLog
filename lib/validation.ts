/**
 * GaiaLog Data Validation Layer
 * 
 * Validates environmental data before persistence and blockchain writes.
 * Designed for DB-less operation - all validation metadata is embedded in payloads.
 */

import {
  ValidationResult,
  ValidationError,
  QualityScore,
  QualityFactors,
  VALIDATION_RANGES,
  SOURCE_RELIABILITY,
  getCurrentSchemaVersion,
} from './types/credibility'
import { VALIDATOR_VERSION } from './constants'

// =============================================================================
// Core Validator Class
// =============================================================================

export class DataValidator {
  private readonly validatorVersion = VALIDATOR_VERSION

  /**
   * Validate air quality data
   */
  validateAirQuality(data: Record<string, unknown>): ValidationResult {
    const errors: ValidationError[] = []
    const warnings: ValidationError[] = []
    const ranges = VALIDATION_RANGES.air_quality

    // Required fields
    if (!data.location) {
      errors.push({ field: 'location', message: 'Location is required', severity: 'error' })
    }
    if (!data.timestamp) {
      errors.push({ field: 'timestamp', message: 'Timestamp is required', severity: 'error' })
    }

    // AQI validation
    const aqi = this.toNumber(data.aqi)
    if (aqi !== null) {
      this.validateRange('aqi', aqi, ranges.aqi, errors, warnings)
    }

    // PM2.5 validation
    const pm25 = this.toNumber(data.pm25)
    if (pm25 !== null) {
      this.validateRange('pm25', pm25, ranges.pm25, errors, warnings)
    }

    // PM10 validation
    const pm10 = this.toNumber(data.pm10)
    if (pm10 !== null) {
      this.validateRange('pm10', pm10, ranges.pm10, errors, warnings)
    }

    // CO validation
    const co = this.toNumber(data.co)
    if (co !== null) {
      this.validateRange('co', co, ranges.co, errors, warnings)
    }

    // NO2 validation
    const no2 = this.toNumber(data.no2)
    if (no2 !== null) {
      this.validateRange('no2', no2, ranges.no2, errors, warnings)
    }

    // O3 validation
    const o3 = this.toNumber(data.o3)
    if (o3 !== null) {
      this.validateRange('o3', o3, ranges.o3, errors, warnings)
    }

    // Temperature validation
    const temp = this.toNumber(data.temperature ?? data.temperature_c)
    if (temp !== null) {
      this.validateRange('temperature_c', temp, ranges.temperature_c, errors, warnings)
    }

    // Humidity validation
    const humidity = this.toNumber(data.humidity ?? data.humidity_pct)
    if (humidity !== null) {
      this.validateRange('humidity_pct', humidity, ranges.humidity_pct, errors, warnings)
    }

    // Coordinates validation
    const coords = data.coordinates as { lat?: number; lon?: number } | undefined
    if (coords) {
      if (coords.lat !== undefined) {
        this.validateRange('latitude', coords.lat, ranges.latitude, errors, warnings)
      }
      if (coords.lon !== undefined) {
        this.validateRange('longitude', coords.lon, ranges.longitude, errors, warnings)
      }
    }

    // Temporal validation
    this.validateTimestamp(data.timestamp, errors, warnings)

    return this.buildResult(errors, warnings)
  }

  /**
   * Validate water level data
   */
  validateWaterLevel(data: Record<string, unknown>): ValidationResult {
    const errors: ValidationError[] = []
    const warnings: ValidationError[] = []
    const ranges = VALIDATION_RANGES.water_levels

    // Required fields
    if (!data.location) {
      errors.push({ field: 'location', message: 'Location is required', severity: 'error' })
    }
    if (!data.timestamp) {
      errors.push({ field: 'timestamp', message: 'Timestamp is required', severity: 'error' })
    }

    // Level validation
    const level = this.toNumber(data.sea_level ?? data.river_level ?? data.level_m)
    if (level !== null) {
      this.validateRange('level_m', level, ranges.level_m, errors, warnings)
    }

    // Tide height validation
    const tideHeight = this.toNumber(data.tide_height ?? data.tide_height_m)
    if (tideHeight !== null) {
      this.validateRange('tide_height_m', tideHeight, ranges.tide_height_m, errors, warnings)
    }

    // Wave height validation
    const waveHeight = this.toNumber(data.wave_height_m)
    if (waveHeight !== null) {
      this.validateRange('wave_height_m', waveHeight, ranges.wave_height_m, errors, warnings)
    }

    // Salinity validation
    const salinity = this.toNumber(data.salinity_psu)
    if (salinity !== null) {
      this.validateRange('salinity_psu', salinity, ranges.salinity_psu, errors, warnings)
    }

    // Dissolved oxygen validation
    const do_mgl = this.toNumber(data.dissolved_oxygen_mg_l)
    if (do_mgl !== null) {
      this.validateRange('dissolved_oxygen_mg_l', do_mgl, ranges.dissolved_oxygen_mg_l, errors, warnings)
    }

    // Coordinates validation
    const coords = data.coordinates as { lat?: number; lon?: number } | undefined
    if (coords) {
      if (coords.lat !== undefined) {
        this.validateRange('latitude', coords.lat, ranges.latitude, errors, warnings)
      }
      if (coords.lon !== undefined) {
        this.validateRange('longitude', coords.lon, ranges.longitude, errors, warnings)
      }
    }

    // Temporal validation
    this.validateTimestamp(data.timestamp, errors, warnings)

    return this.buildResult(errors, warnings)
  }

  /**
   * Validate seismic data
   */
  validateSeismic(data: Record<string, unknown>): ValidationResult {
    const errors: ValidationError[] = []
    const warnings: ValidationError[] = []
    const ranges = VALIDATION_RANGES.seismic

    // Required fields
    if (!data.location) {
      errors.push({ field: 'location', message: 'Location is required', severity: 'error' })
    }
    if (!data.timestamp) {
      errors.push({ field: 'timestamp', message: 'Timestamp is required', severity: 'error' })
    }

    // Magnitude validation (required for seismic)
    const magnitude = this.toNumber(data.magnitude)
    if (magnitude === null) {
      errors.push({ field: 'magnitude', message: 'Magnitude is required', severity: 'error' })
    } else {
      this.validateRange('magnitude', magnitude, ranges.magnitude, errors, warnings)
    }

    // Depth validation
    const depth = this.toNumber(data.depth ?? data.depth_km)
    if (depth !== null) {
      this.validateRange('depth_km', depth, ranges.depth_km, errors, warnings)
    }

    // Coordinates validation (required for seismic)
    const coords = data.coordinates as { lat?: number; lon?: number } | undefined
    if (!coords || coords.lat === undefined || coords.lon === undefined) {
      errors.push({ field: 'coordinates', message: 'Coordinates are required for seismic data', severity: 'error' })
    } else {
      this.validateRange('latitude', coords.lat, ranges.latitude, errors, warnings)
      this.validateRange('longitude', coords.lon, ranges.longitude, errors, warnings)
    }

    // Temporal validation
    this.validateTimestamp(data.timestamp, errors, warnings)

    return this.buildResult(errors, warnings)
  }

  /**
   * Validate advanced metrics data
   */
  validateAdvancedMetrics(data: Record<string, unknown>): ValidationResult {
    const errors: ValidationError[] = []
    const warnings: ValidationError[] = []
    const ranges = VALIDATION_RANGES.advanced_metrics

    // Required fields
    if (!data.location) {
      errors.push({ field: 'location', message: 'Location is required', severity: 'error' })
    }
    if (!data.timestamp) {
      errors.push({ field: 'timestamp', message: 'Timestamp is required', severity: 'error' })
    }

    // UV Index validation
    const uvIndex = this.toNumber(data.uv_index)
    if (uvIndex !== null) {
      this.validateRange('uv_index', uvIndex, ranges.uv_index, errors, warnings)
    }

    // Soil moisture validation
    const soilMoisture = this.toNumber(data.soil_moisture)
    if (soilMoisture !== null) {
      this.validateRange('soil_moisture', soilMoisture, ranges.soil_moisture, errors, warnings)
    }

    // Wildfire risk validation
    const wildfireRisk = this.toNumber(data.wildfire_risk)
    if (wildfireRisk !== null) {
      this.validateRange('wildfire_risk', wildfireRisk, ranges.wildfire_risk, errors, warnings)
    }

    // Environmental score validation
    const envScore = this.toNumber(data.environmental_quality_score ?? data.environmental_score)
    if (envScore !== null) {
      this.validateRange('environmental_score', envScore, ranges.environmental_score, errors, warnings)
    }

    // Coordinates validation
    const coords = data.coordinates as { lat?: number; lon?: number } | undefined
    if (coords) {
      if (coords.lat !== undefined) {
        this.validateRange('latitude', coords.lat, ranges.latitude, errors, warnings)
      }
      if (coords.lon !== undefined) {
        this.validateRange('longitude', coords.lon, ranges.longitude, errors, warnings)
      }
    }

    // Temporal validation
    this.validateTimestamp(data.timestamp, errors, warnings)

    return this.buildResult(errors, warnings)
  }

  validateGeomagnetism(data: Record<string, unknown>): ValidationResult {
    return this.validateGenericScientificData(
      data,
      VALIDATION_RANGES.geomagnetism,
      ['x', 'y', 'z', 'h', 'f', 'd'],
      true,
    )
  }

  validateVolcanicActivity(data: Record<string, unknown>): ValidationResult {
    return this.validateGenericScientificData(
      data,
      VALIDATION_RANGES.volcanic_activity,
      ['alert_level', 'eruption_probability', 'gas_flux'],
      false,
    )
  }

  validateSpaceWeather(data: Record<string, unknown>): ValidationResult {
    return this.validateGenericScientificData(
      data,
      VALIDATION_RANGES.space_weather,
      ['speed', 'density', 'temperature', 'bz', 'bt'],
      false,
    )
  }

  validateUpperAtmosphere(data: Record<string, unknown>): ValidationResult {
    return this.validateGenericScientificData(
      data,
      VALIDATION_RANGES.upper_atmosphere,
      ['temperature_c', 'humidity_pct', 'wind_kph', 'pressure_mb', 'altitude_m'],
      true,
    )
  }

  /**
   * Validate data based on stream type
   */
  validate(stream: string, data: Record<string, unknown>): ValidationResult {
    switch (stream) {
      case 'air_quality':
        return this.validateAirQuality(data)
      case 'water_levels':
        return this.validateWaterLevel(data)
      case 'seismic_activity':
      case 'seismic':
        return this.validateSeismic(data)
      case 'advanced_metrics':
        return this.validateAdvancedMetrics(data)
      case 'geomagnetism':
        return this.validateGeomagnetism(data)
      case 'volcanic_activity':
        return this.validateVolcanicActivity(data)
      case 'space_weather':
        return this.validateSpaceWeather(data)
      case 'upper_atmosphere':
        return this.validateUpperAtmosphere(data)
      default:
        // Unknown stream type - return passed with warning
        return this.buildResult([], [{
          field: 'stream',
          message: `Unknown stream type: ${stream}`,
          value: stream,
          severity: 'warning'
        }])
    }
  }

  // ===========================================================================
  // Private helper methods
  // ===========================================================================

  private toNumber(value: unknown): number | null {
    if (value === null || value === undefined) return null
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string') {
      const parsed = parseFloat(value)
      if (Number.isFinite(parsed)) return parsed
    }
    return null
  }

  private validateRange(
    field: string,
    value: number,
    range: { min: number; max: number; warnMin?: number; warnMax?: number },
    errors: ValidationError[],
    warnings: ValidationError[]
  ): void {
    if (value < range.min || value > range.max) {
      errors.push({
        field,
        message: `Value ${value} out of valid range [${range.min}, ${range.max}]`,
        value,
        severity: 'error'
      })
    } else {
      // Check warning thresholds
      if (range.warnMin !== undefined && value < range.warnMin) {
        warnings.push({
          field,
          message: `Value ${value} is unusually low (warning threshold: ${range.warnMin})`,
          value,
          severity: 'warning'
        })
      }
      if (range.warnMax !== undefined && value > range.warnMax) {
        warnings.push({
          field,
          message: `Value ${value} is unusually high (warning threshold: ${range.warnMax})`,
          value,
          severity: 'warning'
        })
      }
    }
  }

  private validateTimestamp(timestamp: unknown, errors: ValidationError[], warnings: ValidationError[]): void {
    if (!timestamp) return

    let ts: Date
    if (typeof timestamp === 'number') {
      ts = new Date(timestamp)
    } else if (typeof timestamp === 'string') {
      ts = new Date(timestamp)
    } else {
      errors.push({
        field: 'timestamp',
        message: 'Invalid timestamp format',
        value: timestamp,
        severity: 'error'
      })
      return
    }

    if (isNaN(ts.getTime())) {
      errors.push({
        field: 'timestamp',
        message: 'Invalid timestamp value',
        value: timestamp,
        severity: 'error'
      })
      return
    }

    const now = Date.now()
    const diff = now - ts.getTime()

    // Future timestamps are errors
    if (diff < -60000) { // More than 1 minute in the future
      errors.push({
        field: 'timestamp',
        message: 'Timestamp is in the future',
        value: timestamp,
        severity: 'error'
      })
    }

    // Very old timestamps are warnings
    if (diff > 24 * 60 * 60 * 1000) { // More than 24 hours old
      warnings.push({
        field: 'timestamp',
        message: 'Timestamp is more than 24 hours old',
        value: timestamp,
        severity: 'warning'
      })
    }
  }

  private validateGenericScientificData(
    data: Record<string, unknown>,
    ranges: Record<string, { min: number; max: number; warnMin?: number; warnMax?: number }>,
    numericFields: string[],
    requireCoordinates: boolean,
  ): ValidationResult {
    const errors: ValidationError[] = []
    const warnings: ValidationError[] = []

    if (!data.location) {
      errors.push({ field: 'location', message: 'Location is required', severity: 'error' })
    }
    if (!data.timestamp) {
      errors.push({ field: 'timestamp', message: 'Timestamp is required', severity: 'error' })
    }

    for (const field of numericFields) {
      const value = this.toNumber(data[field])
      if (value !== null && ranges[field]) {
        this.validateRange(field, value, ranges[field], errors, warnings)
      }
    }

    const coords = data.coordinates as { lat?: number; lon?: number } | undefined
    if (requireCoordinates) {
      if (!coords || coords.lat === undefined || coords.lon === undefined) {
        errors.push({ field: 'coordinates', message: 'Coordinates are required', severity: 'error' })
      }
    }
    if (coords) {
      if (coords.lat !== undefined && ranges.latitude) {
        this.validateRange('latitude', coords.lat, ranges.latitude, errors, warnings)
      }
      if (coords.lon !== undefined && ranges.longitude) {
        this.validateRange('longitude', coords.lon, ranges.longitude, errors, warnings)
      }
    }

    this.validateTimestamp(data.timestamp, errors, warnings)
    return this.buildResult(errors, warnings)
  }

  private buildResult(errors: ValidationError[], warnings: ValidationError[]): ValidationResult {
    return {
      valid: errors.length === 0,
      errors,
      warnings,
      timestamp: new Date().toISOString(),
      validatorVersion: this.validatorVersion
    }
  }
}

// =============================================================================
// Quality Scorer Class
// =============================================================================

export class QualityScorer {
  /**
   * Calculate comprehensive quality score
   */
  calculateScore(
    data: Record<string, unknown>,
    validation: ValidationResult,
    source: string
  ): QualityScore {
    const factors = this.calculateFactors(data, validation, source)
    const overall = this.computeOverallScore(factors)
    const grade = this.computeGrade(overall)

    return {
      overall,
      factors,
      grade,
      timestamp: new Date().toISOString()
    }
  }

  private calculateFactors(
    data: Record<string, unknown>,
    validation: ValidationResult,
    source: string
  ): QualityFactors {
    return {
      dataCompleteness: this.scoreCompleteness(data),
      dataFreshness: this.scoreFreshness(data),
      dataConsistency: this.scoreConsistency(data, validation),
      sourceReliability: this.scoreSourceReliability(source),
      validationScore: this.scoreValidation(validation)
    }
  }

  private scoreCompleteness(data: Record<string, unknown>): number {
    let score = 100
    const importantFields = ['location', 'timestamp', 'coordinates', 'source']
    
    for (const field of importantFields) {
      if (!data[field]) {
        score -= 15
      }
    }

    // Check for coordinates specifically
    const coords = data.coordinates as { lat?: number; lon?: number } | undefined
    if (!coords || coords.lat === undefined || coords.lon === undefined) {
      score -= 10
    }

    return Math.max(0, Math.min(100, score))
  }

  private scoreFreshness(data: Record<string, unknown>): number {
    const timestamp = data.timestamp
    if (!timestamp) return 50

    let ts: Date
    if (typeof timestamp === 'number') {
      ts = new Date(timestamp)
    } else if (typeof timestamp === 'string') {
      ts = new Date(timestamp)
    } else {
      return 50
    }

    if (isNaN(ts.getTime())) return 50

    const ageMs = Date.now() - ts.getTime()
    const ageHours = ageMs / (1000 * 60 * 60)

    if (ageHours < 1) return 100
    if (ageHours < 6) return 90
    if (ageHours < 12) return 75
    if (ageHours < 24) return 60
    if (ageHours < 48) return 40
    return 20
  }

  private scoreConsistency(data: Record<string, unknown>, validation: ValidationResult): number {
    let score = 100

    // Deduct for warnings (potential anomalies)
    score -= validation.warnings.length * 5

    // Check for internal consistency
    // e.g., PM2.5 should generally be <= PM10
    const pm25 = this.toNumber(data.pm25)
    const pm10 = this.toNumber(data.pm10)
    if (pm25 !== null && pm10 !== null && pm25 > pm10 * 1.5) {
      score -= 10 // PM2.5 unusually high relative to PM10
    }

    return Math.max(0, Math.min(100, score))
  }

  private scoreSourceReliability(source: string): number {
    return SOURCE_RELIABILITY[source] ?? SOURCE_RELIABILITY['unknown']
  }

  private scoreValidation(validation: ValidationResult): number {
    let score = 100
    
    // Errors are severe
    score -= validation.errors.length * 20
    
    // Warnings are minor
    score -= validation.warnings.length * 5

    return Math.max(0, Math.min(100, score))
  }

  private computeOverallScore(factors: QualityFactors): number {
    // Weighted average
    const weights = {
      dataCompleteness: 0.20,
      dataFreshness: 0.20,
      dataConsistency: 0.20,
      sourceReliability: 0.25,
      validationScore: 0.15
    }

    const weighted =
      factors.dataCompleteness * weights.dataCompleteness +
      factors.dataFreshness * weights.dataFreshness +
      factors.dataConsistency * weights.dataConsistency +
      factors.sourceReliability * weights.sourceReliability +
      factors.validationScore * weights.validationScore

    return Math.round(weighted)
  }

  private computeGrade(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
    if (score >= 90) return 'A'
    if (score >= 80) return 'B'
    if (score >= 70) return 'C'
    if (score >= 60) return 'D'
    return 'F'
  }

  private toNumber(value: unknown): number | null {
    if (value === null || value === undefined) return null
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string') {
      const parsed = parseFloat(value)
      if (Number.isFinite(parsed)) return parsed
    }
    return null
  }
}

// =============================================================================
// Singleton exports
// =============================================================================

export const dataValidator = new DataValidator()
export const qualityScorer = new QualityScorer()

