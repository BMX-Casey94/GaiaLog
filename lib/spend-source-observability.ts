export interface LatencySummary {
  samples: number
  avgMs: number | null
  p50Ms: number | null
  p95Ms: number | null
}

export interface SpendSourceMetricsSnapshot {
  lookup: {
    attempts: number
    successes: number
    failures: number
    latency: LatencySummary
  }
  submit: {
    attempts: number
    successes: number
    failures: number
    latency: LatencySummary
  }
  shadow: {
    countComparisons: number
    listComparisons: number
    exactMatches: number
    mismatches: number
    lastMismatchAt: number | null
    lastMismatchTopic: string | null
    lastMismatchReason: string | null
  }
  wallets: Array<{
    topic: string
    walletLabel: string
    lookup: {
      attempts: number
      successes: number
      failures: number
      latency: LatencySummary
    }
    submit: {
      attempts: number
      successes: number
      failures: number
      latency: LatencySummary
    }
    shadow: {
      countComparisons: number
      listComparisons: number
      exactMatches: number
      mismatches: number
      lastMismatchAt: number | null
      lastMismatchReason: string | null
    }
  }>
}

type LatencyBucket = {
  attempts: number
  successes: number
  failures: number
  samples: number[]
}

const MAX_LATENCY_SAMPLES = 256

function createLatencyBucket(): LatencyBucket {
  return {
    attempts: 0,
    successes: 0,
    failures: 0,
    samples: [],
  }
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))
  return sorted[idx]
}

function summariseLatency(bucket: LatencyBucket): LatencySummary {
  if (bucket.samples.length === 0) {
    return {
      samples: 0,
      avgMs: null,
      p50Ms: null,
      p95Ms: null,
    }
  }
  const sorted = [...bucket.samples].sort((left, right) => left - right)
  const total = sorted.reduce((sum, value) => sum + value, 0)
  return {
    samples: sorted.length,
    avgMs: Math.round(total / sorted.length),
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
  }
}

class SpendSourceObservability {
  private lookup = createLatencyBucket()
  private submit = createLatencyBucket()
  private shadow = {
    countComparisons: 0,
    listComparisons: 0,
    exactMatches: 0,
    mismatches: 0,
    lastMismatchAt: null as number | null,
    lastMismatchTopic: null as string | null,
    lastMismatchReason: null as string | null,
  }
  private wallets = new Map<string, {
    lookup: LatencyBucket
    submit: LatencyBucket
    shadow: {
      countComparisons: number
      listComparisons: number
      exactMatches: number
      mismatches: number
      lastMismatchAt: number | null
      lastMismatchReason: string | null
    }
  }>()

  private getWalletBucket(topic: string) {
    let bucket = this.wallets.get(topic)
    if (!bucket) {
      bucket = {
        lookup: createLatencyBucket(),
        submit: createLatencyBucket(),
        shadow: {
          countComparisons: 0,
          listComparisons: 0,
          exactMatches: 0,
          mismatches: 0,
          lastMismatchAt: null,
          lastMismatchReason: null,
        },
      }
      this.wallets.set(topic, bucket)
    }
    return bucket
  }

  private recordLatency(bucket: LatencyBucket, ms: number, success: boolean): void {
    bucket.attempts += 1
    if (success) bucket.successes += 1
    else bucket.failures += 1
    if (Number.isFinite(ms) && ms >= 0) {
      bucket.samples.push(Math.round(ms))
      if (bucket.samples.length > MAX_LATENCY_SAMPLES) {
        bucket.samples.splice(0, bucket.samples.length - MAX_LATENCY_SAMPLES)
      }
    }
  }

  recordLookup(ms: number, success: boolean): void {
    this.recordLatency(this.lookup, ms, success)
  }

  recordLookupForTopic(topic: string, ms: number, success: boolean): void {
    this.recordLatency(this.getWalletBucket(topic).lookup, ms, success)
  }

  recordSubmit(ms: number, success: boolean): void {
    this.recordLatency(this.submit, ms, success)
  }

  recordSubmitForTopic(topic: string, ms: number, success: boolean): void {
    this.recordLatency(this.getWalletBucket(topic).submit, ms, success)
  }

  recordShadowComparison(kind: 'count' | 'list', topic: string, exactMatch: boolean, reason: string | null = null): void {
    if (kind === 'count') this.shadow.countComparisons += 1
    else this.shadow.listComparisons += 1

    if (exactMatch) {
      this.shadow.exactMatches += 1
      const walletShadow = this.getWalletBucket(topic).shadow
      if (kind === 'count') walletShadow.countComparisons += 1
      else walletShadow.listComparisons += 1
      walletShadow.exactMatches += 1
      return
    }

    this.shadow.mismatches += 1
    this.shadow.lastMismatchAt = Date.now()
    this.shadow.lastMismatchTopic = topic
    this.shadow.lastMismatchReason = reason
    const walletShadow = this.getWalletBucket(topic).shadow
    if (kind === 'count') walletShadow.countComparisons += 1
    else walletShadow.listComparisons += 1
    walletShadow.mismatches += 1
    walletShadow.lastMismatchAt = Date.now()
    walletShadow.lastMismatchReason = reason
  }

  snapshot(): SpendSourceMetricsSnapshot {
    return {
      lookup: {
        attempts: this.lookup.attempts,
        successes: this.lookup.successes,
        failures: this.lookup.failures,
        latency: summariseLatency(this.lookup),
      },
      submit: {
        attempts: this.submit.attempts,
        successes: this.submit.successes,
        failures: this.submit.failures,
        latency: summariseLatency(this.submit),
      },
      shadow: { ...this.shadow },
      wallets: Array.from(this.wallets.entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([topic, metrics]) => ({
          topic,
          walletLabel: /^.+:W(\d+)$/i.exec(topic)?.[1]
            ? `W${/^.+:W(\d+)$/i.exec(topic)?.[1]}`
            : topic,
          lookup: {
            attempts: metrics.lookup.attempts,
            successes: metrics.lookup.successes,
            failures: metrics.lookup.failures,
            latency: summariseLatency(metrics.lookup),
          },
          submit: {
            attempts: metrics.submit.attempts,
            successes: metrics.submit.successes,
            failures: metrics.submit.failures,
            latency: summariseLatency(metrics.submit),
          },
          shadow: { ...metrics.shadow },
        })),
    }
  }
}

const _g = globalThis as any
if (!_g.__GAIALOG_SPEND_SOURCE_OBSERVABILITY__) {
  _g.__GAIALOG_SPEND_SOURCE_OBSERVABILITY__ = new SpendSourceObservability()
}

export const spendSourceObservability: SpendSourceObservability = _g.__GAIALOG_SPEND_SOURCE_OBSERVABILITY__
