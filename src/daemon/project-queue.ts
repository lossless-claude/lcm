const queues = new Map<string, { chain: Promise<void>; pending: number }>()

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
