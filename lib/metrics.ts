type DomainKey = string

export interface DomainMetrics {
  domain: DomainKey
  attempts: number
  successes: number
  notModified304: number
  errors4xx: number
  errors5xx: number
  backoffs: number
  avgLatencyMs: number
  lastStatus?: number
  lastUpdated: number
}

class FetchMetricsStore {
  private byDomain = new Map<DomainKey, DomainMetrics>()

  private getDomain(url: string): DomainKey {
    try {
      const u = new URL(url)
      return u.host
    } catch {
      return 'unknown'
    }
  }

  private get(dm: DomainKey): DomainMetrics {
    let m = this.byDomain.get(dm)
    if (!m) {
      m = {
        domain: dm,
        attempts: 0,
        successes: 0,
        notModified304: 0,
        errors4xx: 0,
        errors5xx: 0,
        backoffs: 0,
        avgLatencyMs: 0,
        lastUpdated: Date.now(),
      }
      this.byDomain.set(dm, m)
    }
    return m
  }

  recordAttempt(url: string): void {
    const m = this.get(this.getDomain(url))
    m.attempts++
    m.lastUpdated = Date.now()
  }

  recordSuccess(url: string, status: number, ms: number): void {
    const m = this.get(this.getDomain(url))
    if (status === 304) m.notModified304++
    else m.successes++
    // Exponential moving average for latency
    const alpha = 0.2
    m.avgLatencyMs = m.avgLatencyMs === 0 ? ms : (alpha * ms + (1 - alpha) * m.avgLatencyMs)
    m.lastStatus = status
    m.lastUpdated = Date.now()
  }

  recordError(url: string, statusOrMsg: unknown): void {
    const m = this.get(this.getDomain(url))
    if (typeof statusOrMsg === 'number') {
      if (statusOrMsg >= 500) m.errors5xx++
      else if (statusOrMsg >= 400) m.errors4xx++
    } else {
      m.errors4xx++
    }
    m.lastUpdated = Date.now()
  }

  recordBackoff(url: string): void {
    const m = this.get(this.getDomain(url))
    m.backoffs++
    m.lastUpdated = Date.now()
  }

  snapshot(): { totalDomains: number; domains: DomainMetrics[] } {
    return { totalDomains: this.byDomain.size, domains: Array.from(this.byDomain.values()) }
  }
}

export const fetchMetricsStore = new FetchMetricsStore()


