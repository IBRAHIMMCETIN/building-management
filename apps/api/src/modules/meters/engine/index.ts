/** Finans 2.3 - Sayac / endeks dagitim motoru (saf fonksiyonlar). */
export * from './types.js';
export { daysBetween, isIndex, isSpike, isValidFactor, resolveSegments, segmentDelta, suggestEstimate } from './consumption.js';
export type { ResolveInput, ResolveResult } from './consumption.js';
export { assertDistributionInvariants, calculateDistribution, formatScaled } from './distribute.js';
export { CALC_HASH_VERSION, canonical, distributionHash } from './hash.js';
