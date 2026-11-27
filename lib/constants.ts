export const APP_NAME = 'GaiaLog'

/**
 * Schema version for blockchain payloads
 * 
 * Version history:
 * - 1.0.0: Initial schema (air_quality, water_levels, seismic_activity, advanced_metrics)
 * - 1.1.0: Added credibility metadata (_credibility block with validation, quality scoring, pipeline checksums)
 * 
 * Breaking changes increment major version. New fields increment minor version.
 */
export const SCHEMA_VERSION = '1.1.0'

/**
 * Validator version - tracks changes to validation rules
 */
export const VALIDATOR_VERSION = '1.0.0'
