let lockTail: Promise<unknown> = Promise.resolve();

/**
 * Runs `task` after every previously queued library task has settled.
 *
 * Everything that reads the catalog (or decision stores) and writes a changed version back goes
 * through this lock, so two writers can never interleave a load/modify/save and lose each other's
 * changes. The lock is not re-entrant: a task must not call withLibraryLock again.
 */
export function withLibraryLock<T>(task: () => Promise<T>): Promise<T> {
  const result = lockTail.catch(() => undefined).then(task);
  lockTail = result.catch(() => undefined);
  return result;
}
