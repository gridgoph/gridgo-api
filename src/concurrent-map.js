/** Preserve input order while bounding independent asynchronous work. */
export async function mapConcurrent(items, concurrency, visit) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError('concurrency must be a positive integer');
  const result = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      result[index] = await visit(items[index], index);
    }
  }));
  return result;
}
