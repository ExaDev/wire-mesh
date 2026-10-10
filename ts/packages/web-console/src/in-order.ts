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
