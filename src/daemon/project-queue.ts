const queues = new Map<string, { chain: Promise<void>; pending: number }>()
const mutationTails = new Map<string, Promise<void>>()

async function acquireMutation(projectId: string): Promise<() => void> {
  const previous = mutationTails.get(projectId) ?? Promise.resolve()
  let unlock!: () => void
  const current = new Promise<void>((resolve) => { unlock = resolve })
  mutationTails.set(projectId, current)
  await previous
  return () => {
    unlock()
    if (mutationTails.get(projectId) === current) mutationTails.delete(projectId)
  }
}

/** Serialize local database mutations while allowing a queued summary to wait on its LLM. */
export async function acquireProjectMutation(projectId: string): Promise<{
  release(): void
  yieldWhile<T>(work: () => Promise<T>): Promise<T>
}> {
  let unlock = await acquireMutation(projectId)
  let held = true
  return {
    release() {
      if (!held) return
      held = false
      unlock()
    },
    async yieldWhile<T>(work: () => Promise<T>): Promise<T> {
      if (!held) throw new Error("project mutation lease is not held")
      held = false
      unlock()
      try { return await work() }
      finally {
        unlock = await acquireMutation(projectId)
        held = true
      }
    },
  }
}

export async function withProjectMutation<T>(
  projectId: string,
  work: (lease: Awaited<ReturnType<typeof acquireProjectMutation>>) => Promise<T>,
): Promise<T> {
  const lease = await acquireProjectMutation(projectId)
  try { return await work(lease) }
  finally { lease.release() }
}

/**
 * Lets timers and other requests run. `node:sqlite` is synchronous, so a loop whose
 * awaits only wrap SQLite calls never leaves the microtask queue and holds the whole
 * daemon until it ends. A loop that mutates a project's database calls this only while
 * holding that project's mutation lease, so another run cannot interleave at the yield.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

export function hasQueuedProjectWork(projectId: string): boolean {
  return (queues.get(projectId)?.pending ?? 0) > 0
}

export function enqueue<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const entry = queues.get(projectId) ?? { chain: Promise.resolve(), pending: 0 }
  entry.pending++
  queues.set(projectId, entry)

  const result = entry.chain.then(fn, fn) // run fn regardless of previous result
  entry.chain = result.then(() => {}, () => {}) // swallow for chain continuity

  // Clean up when all pending operations complete (swallow rejection to avoid unhandled promise)
  entry.chain.then(() => {
    entry.pending--
    if (entry.pending === 0) {
      queues.delete(projectId)
    }
  })

  return result
}
