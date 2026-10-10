/**
 * Runs `step` for each item, starting each only once the one before it has finished: the ordered counterpart to `Promise.all`, for steps that depend on the effects of the earlier ones or must not overlap.
 */
export async function inSequence<T>(
  items: readonly T[],
  step: (item: T, index: number) => Promise<void>,
): Promise<void> {
  await items.reduce(async (previous, item, index) => {
    await previous;
    await step(item, index);
  }, Promise.resolve());
}

/** `inSequence` over the indices 0 to `times - 1`. */
export async function repeatInSequence(
  times: number,
  step: (index: number) => Promise<void>,
): Promise<void> {
  await inSequence(
    Array.from({ length: times }, (_, index) => index),
    async (index) => step(index),
  );
}
