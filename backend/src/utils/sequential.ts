/** Run async tasks one at a time (multi-wallet / multi-chain fan-out). */
export async function mapSequential<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (const item of items) {
    out.push(await fn(item));
  }
  return out;
}
