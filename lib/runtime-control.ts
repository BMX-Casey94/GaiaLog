export type HostingTarget = 'vercel' | 'node'
export type RuntimeRole = 'worker' | 'web'

export interface RuntimeControlState {
  hostingTarget: HostingTarget
  configuredWorkerProcess: 'worker' | 'web' | 'auto'
  workerProcessEnabled: boolean
  role: RuntimeRole
  reason: string | null
}

const WARNED_SCOPES = new Set<string>()

function parseWorkerProcessValue(value: string | undefined): boolean | null {
  const safe = String(value || '').trim().toLowerCase()
  if (!safe) return null
  if (['1', 'true', 'yes', 'on', 'worker'].includes(safe)) return true
  if (['0', 'false', 'no', 'off', 'web', 'disabled'].includes(safe)) return false
  return null
}

export function getHostingTarget(): HostingTarget {
  return process.env.VERCEL ? 'vercel' : 'node'
}

export function getRuntimeControlState(): RuntimeControlState {
  const hostingTarget = getHostingTarget()
  const explicitWorkerProcess = parseWorkerProcessValue(process.env.GAIALOG_WORKER_PROCESS)
  const workerProcessEnabled = explicitWorkerProcess != null
    ? explicitWorkerProcess
    : hostingTarget !== 'vercel'

  let reason: string | null = null
  if (!workerProcessEnabled) {
    reason = explicitWorkerProcess === false
      ? 'GAIALOG_WORKER_PROCESS=0 keeps this runtime read-only; background workers must run in a dedicated worker process'
      : 'Vercel runtimes default to read-only mode; run background workers on the VPS via scripts/run-workers.ts'
  }

  return {
    hostingTarget,
    configuredWorkerProcess: explicitWorkerProcess == null ? 'auto' : (explicitWorkerProcess ? 'worker' : 'web'),
    workerProcessEnabled,
    role: workerProcessEnabled ? 'worker' : 'web',
    reason,
  }
}

export function logWorkerProcessSkip(scope: string): void {
  const state = getRuntimeControlState()
  if (state.workerProcessEnabled) return
  const key = `${scope}:${state.hostingTarget}:${state.configuredWorkerProcess}`
  if (WARNED_SCOPES.has(key)) return
  WARNED_SCOPES.add(key)
  console.warn(`⏸️ ${scope}: ${state.reason}`)
}
