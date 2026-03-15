export type SingleWriterMode = 'off' | 'run-workers'
export type MutatorRole = 'primary' | 'secondary'

const WARNED_SCOPES = new Set<string>()

function normaliseSingleWriterMode(value: string | undefined): SingleWriterMode {
  switch (String(value || '').trim().toLowerCase()) {
    case 'run-workers':
    case 'run_workers':
      return 'run-workers'
    default:
      return 'off'
  }
}

function normaliseMutatorRole(value: string | undefined): MutatorRole {
  return String(value || '').trim().toLowerCase() === 'primary' ? 'primary' : 'secondary'
}

export function getSingleWriterMode(): SingleWriterMode {
  return normaliseSingleWriterMode(process.env.GAIALOG_SINGLE_WRITER_MODE)
}

export function getMutatorRole(): MutatorRole {
  return normaliseMutatorRole(process.env.GAIALOG_MUTATOR_ROLE)
}

export function getMutatorControlState(): {
  mode: SingleWriterMode
  role: MutatorRole
  mutatorsEnabled: boolean
  reason: string | null
} {
  const mode = getSingleWriterMode()
  const role = getMutatorRole()
  const mutatorsEnabled = mode === 'off' || role === 'primary'
  return {
    mode,
    role,
    mutatorsEnabled,
    reason: mutatorsEnabled ? null : 'single-writer rollout mode delegates queue and splitter mutation to the primary run-workers process',
  }
}

export function applyPrimaryMutatorRole(): void {
  try {
    process.env.GAIALOG_MUTATOR_ROLE = 'primary'
  } catch {
    // Non-fatal in environments where process.env is immutable.
  }
}

export function logMutatorSkip(scope: string): void {
  const state = getMutatorControlState()
  if (state.mutatorsEnabled) return
  const key = `${scope}:${state.mode}:${state.role}`
  if (WARNED_SCOPES.has(key)) return
  WARNED_SCOPES.add(key)
  console.warn(
    `⏸️ ${scope}: background mutators disabled (${state.mode}, role=${state.role}). Start scripts/run-workers.ts to own queue and splitter mutation.`
  )
}
