/**
 * A worker pool for the per-mutation model calls in Phases 5 and 6.
 *
 * An 8B model on a laptop answers one mutation in ~15 s, and Ollama serves them serially
 * unless it is configured otherwise. Firing ten at once would not make them finish sooner,
 * it would just make every one of them late - so the callers here run at a width of one and
 * results land in the table as they arrive rather than all at the end. The pool exists so
 * that width is a number in one place rather than an assumption spread across two panels.
 */

export async function runPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length || signal?.aborted) return;
      await worker(items[i], i);
    }
  });
  await Promise.all(workers);
}
