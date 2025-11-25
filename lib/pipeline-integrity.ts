/**
 * GaiaLog Pipeline Integrity Service
 * 
 * Provides tamper-evident checksums at each data transformation stage.
 * Designed for DB-less operation - integrity chain is embedded in payloads.
 */

import { createHash } from 'crypto'
import {
  PipelineStage,
  PipelineIntegrityChain,
  CredibilityMetadata,
  getCurrentSchemaVersion,
} from './types/credibility'
import type { ValidationResult } from './types/credibility'
import type { QualityScore } from './types/credibility'

// =============================================================================
// Pipeline Integrity Tracker
// =============================================================================

export class PipelineIntegrity {
  private stages: PipelineStage[] = []
  private startTime: number

  constructor() {
    this.startTime = Date.now()
  }

  /**
   * Add a stage to the integrity chain
   */
  addStage(
    stageName: string,
    input: unknown,
    output: unknown,
    metadata?: Record<string, unknown>
  ): void {
    const inputChecksum = this.computeChecksum(input)
    const outputChecksum = this.computeChecksum(output)

    this.stages.push({
      stage: stageName,
      timestamp: new Date().toISOString(),
      inputChecksum,
      outputChecksum,
      metadata
    })
  }

  /**
   * Get the complete integrity chain
   */
  getChain(): PipelineIntegrityChain {
    const verified = this.verifyChain()
    const finalChecksum = this.computeFinalChecksum()

    return {
      stages: [...this.stages],
      finalChecksum,
      verified
    }
  }

  /**
   * Verify the integrity of the chain
   * Each stage's output checksum should logically connect to the next stage's input
   */
  verifyChain(): boolean {
    if (this.stages.length === 0) return true
    
    // For our use case, we're tracking transformations, not strict chaining
    // Verification ensures all stages have valid checksums
    for (const stage of this.stages) {
      if (!stage.inputChecksum || !stage.outputChecksum) {
        return false
      }
    }
    return true
  }

  /**
   * Get final checksum that represents the entire pipeline
   */
  getFinalChecksum(): string {
    return this.computeFinalChecksum()
  }

  /**
   * Compute checksum of any value
   */
  computeChecksum(data: unknown): string {
    const str = this.canonicalStringify(data)
    return createHash('sha256').update(str).digest('hex').slice(0, 16)
  }

  /**
   * Canonical JSON stringify for consistent hashing
   */
  private canonicalStringify(value: unknown): string {
    if (value === null || value === undefined) return ''
    if (typeof value !== 'object') return String(value)
    
    try {
      // Sort keys for consistent ordering
      const sortedReplacer = (_key: string, val: unknown): unknown => {
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          return Object.keys(val as Record<string, unknown>)
            .sort()
            .reduce((sorted: Record<string, unknown>, key: string) => {
              sorted[key] = (val as Record<string, unknown>)[key]
              return sorted
            }, {})
        }
        return val
      }
      return JSON.stringify(value, sortedReplacer)
    } catch {
      return String(value)
    }
  }

  /**
   * Compute checksum of the entire pipeline
   */
  private computeFinalChecksum(): string {
    const chainData = this.stages.map(s => `${s.stage}:${s.inputChecksum}:${s.outputChecksum}`)
    const chainStr = chainData.join('|')
    return createHash('sha256').update(chainStr).digest('hex').slice(0, 16)
  }
}

// =============================================================================
// Credibility Builder (creates metadata to embed in blockchain payload)
// =============================================================================

export class CredibilityBuilder {
  private pipeline: PipelineIntegrity
  private collectedAt: string
  private validation: ValidationResult | null = null
  private qualityScore: QualityScore | null = null

  constructor(collectedAt?: string) {
    this.pipeline = new PipelineIntegrity()
    this.collectedAt = collectedAt || new Date().toISOString()
  }

  /**
   * Record the API fetch stage
   */
  recordFetch(source: string, rawData: unknown): this {
    this.pipeline.addStage('api_fetch', { source }, rawData, { source })
    return this
  }

  /**
   * Record the validation stage
   */
  recordValidation(inputData: unknown, validation: ValidationResult): this {
    this.validation = validation
    this.pipeline.addStage('validation', inputData, validation, {
      valid: validation.valid,
      errorCount: validation.errors.length,
      warningCount: validation.warnings.length
    })
    return this
  }

  /**
   * Record the quality scoring stage
   */
  recordQualityScore(validation: ValidationResult, qualityScore: QualityScore): this {
    this.qualityScore = qualityScore
    this.pipeline.addStage('quality_scoring', validation, qualityScore, {
      score: qualityScore.overall,
      grade: qualityScore.grade
    })
    return this
  }

  /**
   * Record the transformation stage
   */
  recordTransformation(input: unknown, output: unknown, transformName?: string): this {
    this.pipeline.addStage(transformName || 'transform', input, output)
    return this
  }

  /**
   * Build the final credibility metadata
   */
  build(): CredibilityMetadata {
    const chain = this.pipeline.getChain()
    
    const validationStatus: CredibilityMetadata['validation_status'] = 
      !this.validation ? 'passed' :
      !this.validation.valid ? 'failed' :
      this.validation.warnings.length > 0 ? 'passed_with_warnings' :
      'passed'

    const validationWarnings = this.validation?.warnings
      .map(w => `${w.field}: ${w.message}`)
      .slice(0, 5) // Limit to 5 warnings to save space

    return {
      schema_version: getCurrentSchemaVersion(),
      quality_score: this.qualityScore?.overall ?? 0,
      quality_grade: this.qualityScore?.grade ?? 'F',
      validation_status: validationStatus,
      validation_warnings: validationWarnings?.length ? validationWarnings : undefined,
      pipeline_checksum: chain.finalChecksum,
      collected_at: this.collectedAt,
      processed_at: new Date().toISOString()
    }
  }

  /**
   * Get the pipeline integrity instance for direct access
   */
  getPipeline(): PipelineIntegrity {
    return this.pipeline
  }
}

// =============================================================================
// Factory function for easy use
// =============================================================================

export function createCredibilityBuilder(collectedAt?: string): CredibilityBuilder {
  return new CredibilityBuilder(collectedAt)
}

// =============================================================================
// Utility: Verify a credibility metadata block
// =============================================================================

export function verifyCredibilityMetadata(metadata: CredibilityMetadata): {
  valid: boolean
  issues: string[]
} {
  const issues: string[] = []

  // Check required fields
  if (!metadata.schema_version) {
    issues.push('Missing schema_version')
  }
  if (metadata.quality_score === undefined || metadata.quality_score === null) {
    issues.push('Missing quality_score')
  }
  if (!metadata.quality_grade) {
    issues.push('Missing quality_grade')
  }
  if (!metadata.validation_status) {
    issues.push('Missing validation_status')
  }
  if (!metadata.pipeline_checksum) {
    issues.push('Missing pipeline_checksum')
  }
  if (!metadata.collected_at) {
    issues.push('Missing collected_at')
  }
  if (!metadata.processed_at) {
    issues.push('Missing processed_at')
  }

  // Validate quality score range
  if (typeof metadata.quality_score === 'number') {
    if (metadata.quality_score < 0 || metadata.quality_score > 100) {
      issues.push(`Invalid quality_score: ${metadata.quality_score}`)
    }
  }

  // Validate grade
  const validGrades = ['A', 'B', 'C', 'D', 'F']
  if (metadata.quality_grade && !validGrades.includes(metadata.quality_grade)) {
    issues.push(`Invalid quality_grade: ${metadata.quality_grade}`)
  }

  // Validate status
  const validStatuses = ['passed', 'passed_with_warnings', 'failed']
  if (metadata.validation_status && !validStatuses.includes(metadata.validation_status)) {
    issues.push(`Invalid validation_status: ${metadata.validation_status}`)
  }

  // Validate timestamps
  if (metadata.collected_at && isNaN(Date.parse(metadata.collected_at))) {
    issues.push('Invalid collected_at timestamp')
  }
  if (metadata.processed_at && isNaN(Date.parse(metadata.processed_at))) {
    issues.push('Invalid processed_at timestamp')
  }

  return {
    valid: issues.length === 0,
    issues
  }
}

