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

export const ISO_COUNTRIES: Array<{ code: string; name: string }> = [
  { code: 'US', name: 'United States' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'CA', name: 'Canada' },
  { code: 'AU', name: 'Australia' },
  { code: 'NZ', name: 'New Zealand' },
  { code: 'IN', name: 'India' },
  { code: 'JP', name: 'Japan' },
  { code: 'KR', name: 'South Korea' },
  { code: 'DE', name: 'Germany' },
  { code: 'FR', name: 'France' },
  { code: 'ES', name: 'Spain' },
  { code: 'IT', name: 'Italy' },
  { code: 'SE', name: 'Sweden' },
  { code: 'NO', name: 'Norway' },
  { code: 'FI', name: 'Finland' },
  { code: 'RU', name: 'Russia' },
  { code: 'CN', name: 'China' },
  { code: 'BR', name: 'Brazil' },
  { code: 'MX', name: 'Mexico' },
  { code: 'ZA', name: 'South Africa' },
]


