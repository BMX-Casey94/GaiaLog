# GaiaLog Data Credibility Features

## Overview

GaiaLog now includes a comprehensive data credibility system designed for scientific and commercial trustworthiness. These features operate **without requiring a database** — all credibility metadata is embedded directly in blockchain payloads, making the data self-documenting and audit-ready.

## Features Implemented

### 1. Validation Layer (`lib/validation.ts`)

A robust validation system that checks all incoming environmental data before blockchain writes:

- **Range validation**: Ensures values fall within physically possible ranges
- **Warning thresholds**: Flags unusually high/low values that may indicate sensor issues
- **Temporal validation**: Checks timestamps aren't in the future or too old
- **Coordinate validation**: Verifies latitude/longitude are valid
- **Required field checks**: Ensures essential data is present

**Supported data types:**
- Air Quality (AQI, PM2.5, PM10, CO, NO₂, O₃, SO₂, temperature, humidity, etc.)
- Water Levels (sea level, tide height, wave height, salinity, dissolved oxygen, etc.)
- Seismic Activity (magnitude, depth, coordinates)
- Advanced Metrics (UV index, soil moisture, wildfire risk, environmental score)

### 2. Quality Scoring (`lib/validation.ts`)

Each data point receives a quality score (0-100) and letter grade (A-F) based on:

| Factor | Weight | Description |
|--------|--------|-------------|
| Data Completeness | 20% | Are all expected fields present? |
| Data Freshness | 20% | How recent is the data? |
| Data Consistency | 20% | Does it match expected patterns? |
| Source Reliability | 25% | How trustworthy is the data source? |
| Validation Score | 15% | Did it pass validation checks? |

**Source Reliability Ratings:**
- USGS Earthquake API: 95%
- NOAA Tides & Currents: 95%
- WAQI: 85%
- WeatherAPI.com: 80%
- Derived metrics: 75%

### 3. Pipeline Integrity (`lib/pipeline-integrity.ts`)

Tamper-evident checksums track data through each transformation stage:

1. **API Fetch** — Records raw data from source
2. **Validation** — Records validation results
3. **Quality Scoring** — Records quality assessment
4. **Transformation** — Records payload sanitisation

Each stage computes SHA-256 checksums of inputs and outputs. The final pipeline checksum provides a unique fingerprint of the entire processing chain.

### 4. Schema Versioning

All blockchain payloads now include:
- `schema_version`: Identifies the payload format version
- Version history tracked in `lib/constants.ts`

**Current version: 1.1.0** (adds credibility metadata)

### 5. Credibility Metadata

When enabled, each blockchain payload includes a `_credibility` block:

```json
{
  "app": "GaiaLog",
  "schema_version": "1.1.0",
  "data_type": "air_quality",
  "timestamp": 1732550400000,
  "provider": "WAQI",
  "payload": { ... },
  "_credibility": {
    "schema_version": "1.1.0",
    "quality_score": 85,
    "quality_grade": "B",
    "validation_status": "passed",
    "pipeline_checksum": "a1b2c3d4e5f67890",
    "collected_at": "2025-11-25T12:00:00.000Z",
    "processed_at": "2025-11-25T12:00:01.234Z"
  }
}
```

## Configuration

Add these to your `.env.local`:

```bash
# Enable credibility metadata in blockchain payloads
GAIALOG_ENABLE_CREDIBILITY=true

# Require validation to pass (logs warnings if false)
GAIALOG_REQUIRE_VALIDATION=false
```

## Files Added/Modified

### New Files
- `lib/types/credibility.ts` — Type definitions for credibility system
- `lib/validation.ts` — Data validation and quality scoring
- `lib/pipeline-integrity.ts` — Tamper-evident pipeline tracking
- `DATA_CREDIBILITY_FEATURES.md` — This documentation

### Modified Files
- `lib/blockchain.ts` — Integrates credibility into blockchain writes
- `lib/constants.ts` — Added schema version and validator version
- `env.template` — Documented new environment variables

## Usage Examples

### Manual Validation

```typescript
import { dataValidator, qualityScorer } from './lib/validation'

// Validate air quality data
const airData = {
  aqi: 45,
  pm25: 12.5,
  location: 'London',
  timestamp: new Date().toISOString(),
  coordinates: { lat: 51.5074, lon: -0.1278 }
}

const validation = dataValidator.validateAirQuality(airData)
console.log('Valid:', validation.valid)
console.log('Errors:', validation.errors)
console.log('Warnings:', validation.warnings)

// Calculate quality score
const quality = qualityScorer.calculateScore(airData, validation, 'WAQI')
console.log('Score:', quality.overall, 'Grade:', quality.grade)
```

### Pipeline Integrity Tracking

```typescript
import { createCredibilityBuilder } from './lib/pipeline-integrity'

const builder = createCredibilityBuilder()

// Track each stage
builder.recordFetch('WAQI', rawApiResponse)
builder.recordValidation(rawData, validationResult)
builder.recordQualityScore(validationResult, qualityScore)
builder.recordTransformation(rawData, sanitisedPayload)

// Get final metadata
const credibility = builder.build()
```

## Validation Ranges

All validation ranges are defined in `lib/types/credibility.ts`:

### Air Quality
| Field | Valid Range | Warning Range |
|-------|-------------|---------------|
| AQI | 0–500 | >300 |
| PM2.5 | 0–1000 | >500 |
| PM10 | 0–1000 | >500 |
| Temperature | -90°C to 60°C | <-50°C or >55°C |

### Seismic
| Field | Valid Range | Warning Range |
|-------|-------------|---------------|
| Magnitude | -2 to 10 | >8 |
| Depth | 0–800 km | >700 km |

### Water Levels
| Field | Valid Range | Warning Range |
|-------|-------------|---------------|
| Wave Height | 0–50 m | >25 m |
| Salinity | 0–50 PSU | — |

## Future Enhancements

These features lay the groundwork for:

1. **Sensor Signatures** — Cryptographic binding of sensor identity to data
2. **Calibration Logs** — Tracking sensor maintenance and calibration
3. **Redundant Validation** — Cross-referencing multiple data sources
4. **Anomaly Detection** — Machine learning-based outlier detection
5. **Third-Party Audit API** — Endpoints for external verification

## DB-Less Operation

All credibility features are designed for database-less operation:

- Validation runs in-memory
- Quality scores are computed on-the-fly
- Pipeline checksums are embedded in payloads
- No external storage required

The blockchain itself becomes the audit trail — every piece of data carries its own credibility proof.

## Backward Compatibility

- Existing payloads without `_credibility` remain valid
- The `schema_version` field enables parsers to handle different formats
- Credibility features are opt-in via environment variables

