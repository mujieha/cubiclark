// Keys of plain objects that come from outside (file names, ids in a hook line, record types).
// `world.agents` and the diagnostics maps are ordinary objects, so a key such as `constructor` or
// `__proto__` finds something that is not an entry. Such a name is never a real Claude Code id: the
// reducer ignores an agent called that, and a count under that name goes to '(invalid)'.

/** False for '' and for any name every plain object already has (`constructor`, `__proto__`,
 * `hasOwnProperty`, `toString`, ...). */
export function isSafeKey(key: string): boolean {
  return key.length > 0 && !(key in Object.prototype)
}

/** record[key] when it is the record's own entry; never an inherited member such as `constructor` or
 * `toString` (a task id comes from a folder name, R2-5). */
export function ownEntry<T>(record: Readonly<Record<string, T>>, key: string | undefined): T | undefined {
  return key !== undefined && Object.hasOwn(record, key) ? record[key] : undefined
}

/** The key a count is kept under: the name itself, or '(invalid)' when the name is not safe. */
export function countKey(key: string): string {
  return isSafeKey(key) ? key : '(invalid)'
}

/** Most distinct names a diagnostics map keeps; every further name is counted under '(other)'. */
export const MAX_COUNTED_NAMES = 50

/** map[key] += by, reading and writing an own property only. With `max`, a name that would be the
 * (max + 1)th distinct one is counted under '(other)' instead. */
export function bump(map: Record<string, number>, key: string, by = 1, max = Number.POSITIVE_INFINITY): void {
  let safe = countKey(key)
  if (!Object.hasOwn(map, safe) && Object.keys(map).length >= max) safe = '(other)'
  map[safe] = (Object.hasOwn(map, safe) ? (map[safe] as number) : 0) + by
}
