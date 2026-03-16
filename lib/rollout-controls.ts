export type RolloutGate = 'gate_a' | 'gate_b' | 'gate_c' | 'gate_d'

export interface RolloutRule {
  phase: 1 | 2 | 3
  minimumGate: RolloutGate
  recommendedOrder?: number | null
  note: string
}

const ROLLOUT_GATE_ORDER: RolloutGate[] = ['gate_a', 'gate_b', 'gate_c', 'gate_d']

const ROLLOUT_GATE_LABELS: Record<RolloutGate, string> = {
  gate_a: 'Gate A',
  gate_b: 'Gate B',
  gate_c: 'Gate C',
  gate_d: 'Gate D',
}

const ROLLOUT_GATE_DESCRIPTIONS: Record<RolloutGate, string> = {
  gate_a: 'Sustain the current utility with no regression while adding the first provider-isolated pipelines.',
  gate_b: 'Sustain at least 1M/day projected accepted throughput before widening the rollout.',
  gate_c: 'Sustain at least 1M/day projected confirmed throughput before widening the rollout further.',
  gate_d: 'Only widen into lower-yield or higher-complexity sources once the confirmed throughput gate is healthy.',
}

const DEFAULT_REQUESTED_GATE: RolloutGate = 'gate_b'

function normaliseGate(value: string | undefined | null): RolloutGate | null {
  const normalised = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_')
  switch (normalised) {
    case 'a':
    case 'gate_a':
      return 'gate_a'
    case 'b':
    case 'gate_b':
      return 'gate_b'
    case 'c':
    case 'gate_c':
      return 'gate_c'
    case 'd':
    case 'gate_d':
      return 'gate_d'
    default:
      return null
  }
}

export function getRequestedRolloutGate(): RolloutGate {
  return normaliseGate(process.env.GAIALOG_ROLLOUT_GATE) || DEFAULT_REQUESTED_GATE
}

export function compareRolloutGates(left: RolloutGate, right: RolloutGate): number {
  return ROLLOUT_GATE_ORDER.indexOf(left) - ROLLOUT_GATE_ORDER.indexOf(right)
}

export function isRolloutGateEnabled(minimumGate: RolloutGate, requestedGate: RolloutGate = getRequestedRolloutGate()): boolean {
  return compareRolloutGates(minimumGate, requestedGate) <= 0
}

export function getRolloutGateTargets(): {
  acceptedPerDay: number
  confirmedPerDay: number
} {
  const accepted = Number(process.env.GAIALOG_GATE_B_ACCEPTED_PER_DAY || 1_000_000)
  const confirmed = Number(process.env.GAIALOG_GATE_C_CONFIRMED_PER_DAY || 1_000_000)
  return {
    acceptedPerDay: Number.isFinite(accepted) && accepted > 0 ? accepted : 1_000_000,
    confirmedPerDay: Number.isFinite(confirmed) && confirmed > 0 ? confirmed : 1_000_000,
  }
}

export function getHighestUnlockedGate(projectedAcceptedPerDay: number, projectedConfirmedPerDay: number): RolloutGate {
  const targets = getRolloutGateTargets()
  if (projectedConfirmedPerDay >= targets.confirmedPerDay) return 'gate_d'
  if (projectedAcceptedPerDay >= targets.acceptedPerDay) return 'gate_b'
  return 'gate_a'
}

export function buildRolloutGateStatus(projectedAcceptedPerDay: number, projectedConfirmedPerDay: number): {
  requestedGate: RolloutGate
  highestUnlockedGate: RolloutGate
  targets: {
    acceptedPerDay: number
    confirmedPerDay: number
  }
  gates: Array<{
    id: RolloutGate
    label: string
    description: string
    unlocked: boolean
    targetPerDay: number | null
  }>
} {
  const targets = getRolloutGateTargets()
  const requestedGate = getRequestedRolloutGate()
  const gateBUnlocked = projectedAcceptedPerDay >= targets.acceptedPerDay
  const gateCUnlocked = projectedConfirmedPerDay >= targets.confirmedPerDay
  const highestUnlockedGate = getHighestUnlockedGate(projectedAcceptedPerDay, projectedConfirmedPerDay)

  return {
    requestedGate,
    highestUnlockedGate,
    targets,
    gates: [
      {
        id: 'gate_a',
        label: ROLLOUT_GATE_LABELS.gate_a,
        description: ROLLOUT_GATE_DESCRIPTIONS.gate_a,
        unlocked: true,
        targetPerDay: null,
      },
      {
        id: 'gate_b',
        label: ROLLOUT_GATE_LABELS.gate_b,
        description: ROLLOUT_GATE_DESCRIPTIONS.gate_b,
        unlocked: gateBUnlocked,
        targetPerDay: targets.acceptedPerDay,
      },
      {
        id: 'gate_c',
        label: ROLLOUT_GATE_LABELS.gate_c,
        description: ROLLOUT_GATE_DESCRIPTIONS.gate_c,
        unlocked: gateCUnlocked,
        targetPerDay: targets.confirmedPerDay,
      },
      {
        id: 'gate_d',
        label: ROLLOUT_GATE_LABELS.gate_d,
        description: ROLLOUT_GATE_DESCRIPTIONS.gate_d,
        unlocked: gateCUnlocked,
        targetPerDay: targets.confirmedPerDay,
      },
    ],
  }
}
