/**
 * Orders the home page's first fetches from the top of the page downward.
 *
 * Stage 0 (hero and live metrics) starts immediately. Each later stage starts
 * once every section in the stage above has finished its first fetch. Repeat
 * polls do not hold the queue, and nothing waits for the user to scroll.
 *
 * A release is deferred by one microtask so React strict mode's
 * mount → cleanup → mount does not open the next stage in the gap.
 */

type Stage = {
  pending: number
  opened: boolean
  settled: Promise<void>
  resolve: () => void
  resolved: boolean
}

const stages = new Map<number, Stage>()

function stage(order: number): Stage {
  const existing = stages.get(order)
  if (existing) return existing

  let resolve!: () => void
  const settled = new Promise<void>((done) => {
    resolve = done
  })
  const created: Stage = {
    pending: 0,
    opened: false,
    settled,
    resolved: false,
    resolve: () => {
      if (created.resolved) return
      created.resolved = true
      resolve()
    },
  }
  stages.set(order, created)
  return created
}

/** Join a stage. Call the returned function once the first fetch has settled. */
export function holdHomepageStage(order: number): () => void {
  const current = stage(order)
  current.opened = true
  current.pending += 1
  let released = false

  return () => {
    if (released) return
    released = true
    current.pending -= 1
    if (current.pending <= 0) {
      queueMicrotask(() => {
        if (current.pending <= 0) current.resolve()
      })
    }
  }
}

/** Resolves when every holder of the previous stage has finished its first fetch. */
export function whenHomepageStageOpen(order: number): Promise<void> {
  if (order <= 0) return Promise.resolve()
  const previous = stage(order - 1)
  return Promise.resolve().then(() => {
    if (!previous.opened) previous.resolve()
    return previous.settled
  })
}
