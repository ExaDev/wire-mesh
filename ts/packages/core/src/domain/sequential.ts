/**
 * The first item, in order, for which `predicate` resolves true, or undefined when none does. Items are tested strictly one after another and the search stops at the first match: a later item is never tested once an earlier one has matched, so a check that has to fail closed on the earliest offender, or whose later items must not run after an earlier one decided the outcome, keeps that order.
 */
export async function firstAsync<T>(
  items: readonly T[],
  predicate: (item: T) => Promise<boolean>,
): Promise<T | undefined> {
  const [head, ...remaining] = items;
  if (head === undefined) {
    return undefined;
  }

  return (await predicate(head)) ? head : firstAsync(remaining, predicate);
}

/**
 * Runs `step` for each item, starting each only once the one before it has finished and stopping at the first that rejects, so side effects happen in item order and nothing after a failure runs.
 */
export async function eachInOrder<T>(
  items: readonly T[],
  step: (item: T, index: number) => Promise<void>,
): Promise<void> {
  await items.reduce(async (previous, item, index) => {
    await previous;
    await step(item, index);
  }, Promise.resolve());
}
