type QueueEntry = { chain: Promise<void>; pending: number; yielded: number }
const queues = new Map<string, QueueEntry>()
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

/** Work that would make a new project request wait, excluding yielded model calls. */
export function hasBlockingProjectWork(projectId: string): boolean {
  const entry = queues.get(projectId)
  return (entry !== undefined && entry.pending > entry.yielded) || mutationTails.has(projectId)
}

function reserveQueueTurn(entry: QueueEntry): { wait: Promise<void>; release: () => void } {
  const wait = entry.chain
  let release!: () => void
  entry.chain = new Promise<void>((resolve) => { release = resolve })
  return { wait, release }
}

export function enqueue<T>(
  projectId: string,
  fn: (turn: { yieldWhile<U>(work: () => Promise<U>): Promise<U> }) => Promise<T>,
): Promise<T> {
  const entry = queues.get(projectId) ?? { chain: Promise.resolve(), pending: 0, yielded: 0 }
  entry.pending++
  queues.set(projectId, entry)

  let turn = reserveQueueTurn(entry)
  let held = true
  return turn.wait.then(async () => {
    try {
      return await fn({
        async yieldWhile<U>(work: () => Promise<U>): Promise<U> {
          if (!held) throw new Error("project queue turn is not held")
          held = false
          entry.yielded++
          turn.release()
          try { return await work() }
          finally {
            entry.yielded--
            turn = reserveQueueTurn(entry)
            await turn.wait
            held = true
          }
        },
      })
    } finally {
      if (held) turn.release()
      entry.pending--
      if (entry.pending === 0) queues.delete(projectId)
    }
  })
}
