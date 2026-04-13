/**
 * Pick time distribution loading and sampling.
 *
 * Distributions are keyed by (storageType, quantityBucket).
 * Each bucket contains empirical pick time samples in seconds.
 * The DES engine samples from these to model variable PICO pick times.
 */

import type { PickTimeDistribution, PickTimeBucket } from "./des-types";

/**
 * Parse and validate a pick time distribution from JSON.
 */
export function loadPickTimeDistribution(json: unknown): PickTimeDistribution {
  const data = json as { buckets?: unknown[] };
  if (!data.buckets || !Array.isArray(data.buckets)) {
    throw new Error("Invalid pick time distribution: missing 'buckets' array");
  }

  const buckets: PickTimeBucket[] = data.buckets.map((b: any, i: number) => {
    if (!b.storageType || !b.quantityBucket || !Array.isArray(b.samples)) {
      throw new Error(`Invalid bucket at index ${i}: missing storageType, quantityBucket, or samples`);
    }
    return {
      storageType: String(b.storageType),
      quantityBucket: String(b.quantityBucket),
      samples: b.samples.map(Number).filter((n: number) => !isNaN(n) && n > 0),
    };
  });

  return { buckets };
}

/**
 * Parse a quantity bucket string like "1-5" and check if quantity falls in range.
 */
function matchesBucket(bucketStr: string, quantity: number): boolean {
  const parts = bucketStr.split("-");
  if (parts.length === 2) {
    const lo = Number(parts[0]);
    const hi = Number(parts[1]);
    return quantity >= lo && quantity <= hi;
  }
  // Single value bucket
  return quantity === Number(bucketStr);
}

/**
 * Sample a pick time from the distribution.
 *
 * Looks up the bucket matching (storageType, quantity), then returns
 * a random sample. Falls back to the overall median if no match found.
 */
export function samplePickTime(
  dist: PickTimeDistribution,
  storageType: string,
  quantity: number,
): number {
  // Find matching bucket
  let bucket = dist.buckets.find(
    (b) => b.storageType === storageType && matchesBucket(b.quantityBucket, quantity),
  );

  // Fallback: match just by quantity
  if (!bucket) {
    bucket = dist.buckets.find((b) => matchesBucket(b.quantityBucket, quantity));
  }

  // Fallback: match just by storage type
  if (!bucket) {
    bucket = dist.buckets.find((b) => b.storageType === storageType);
  }

  // Last resort: use all samples across all buckets
  if (!bucket || bucket.samples.length === 0) {
    const allSamples = dist.buckets.flatMap((b) => b.samples);
    if (allSamples.length === 0) return 10; // absolute fallback
    return allSamples[Math.floor(Math.random() * allSamples.length)];
  }

  return bucket.samples[Math.floor(Math.random() * bucket.samples.length)];
}
