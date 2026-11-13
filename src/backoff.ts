/** What the delay before the next attempt depends on. */
export type BackoffOptions = {
	/** The cap on the delay before the second attempt, in milliseconds. */
	readonly baseDelay: number;
	/** The largest delay, in milliseconds, however many attempts have failed. */
	readonly maxDelay: number;
};

/**
 * Exponential backoff with full jitter: a uniform draw between 0 and `min(maxDelay, baseDelay * 2 ** (failedAttempt - 1))`.
 * Full jitter spreads out transactions that collided, so they do not collide again on the next attempt.
 * `random` is a number in [0, 1), like `Math.random()`.
 */
export const backoffDelay = (failedAttempt: number, options: BackoffOptions, random: number): number =>
	Math.floor(random * Math.min(options.maxDelay, options.baseDelay * 2 ** (failedAttempt - 1)));
