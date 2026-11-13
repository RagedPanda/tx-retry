import {isRetryableError} from './classify.ts';
import {invalidOptionError} from './errors.ts';
import type {RetryEvent, RunTransactionOptions} from './types.ts';

/** The options with every default filled in. */
export type ResolvedOptions = {
	readonly maxAttempts: number;
	readonly baseDelay: number;
	readonly maxDelay: number;
	readonly isRetryable: (error: unknown, attempt: number) => boolean;
	readonly onRetry: ((event: RetryEvent) => unknown) | undefined;
	readonly signal: AbortSignal | undefined;
	readonly random: () => number;
};

export const defaultOptions = {
	maxAttempts: 5,
	baseDelay: 10,
	maxDelay: 1000,
} as const;

const isPositiveInteger = (value: number): boolean => Number.isInteger(value) && value >= 1;

const isNonNegative = (value: number): boolean => value >= 0;

/** Fills in the defaults and throws a RangeError for a value that would make the loop misbehave. */
export const resolveOptions = (options: RunTransactionOptions): ResolvedOptions => {
	const resolved: ResolvedOptions = {
		maxAttempts: options.maxAttempts ?? defaultOptions.maxAttempts,
		baseDelay: options.baseDelay ?? defaultOptions.baseDelay,
		maxDelay: options.maxDelay ?? defaultOptions.maxDelay,
		isRetryable: options.isRetryable ?? isRetryableError,
		onRetry: options.onRetry,
		signal: options.signal,
		random: options.random ?? Math.random,
	};

	if (!isPositiveInteger(resolved.maxAttempts) && resolved.maxAttempts !== Infinity) {
		throw invalidOptionError('maxAttempts', resolved.maxAttempts, 'a whole number of 1 or more, or Infinity');
	}

	if (!isNonNegative(resolved.baseDelay)) {
		throw invalidOptionError('baseDelay', resolved.baseDelay, 'a number of milliseconds of 0 or more');
	}

	if (!isNonNegative(resolved.maxDelay)) {
		throw invalidOptionError('maxDelay', resolved.maxDelay, 'a number of milliseconds of 0 or more');
	}

	return resolved;
};

/** Whether the attempt that failed with `error` should be followed by another one. */
export const shouldRetry = (error: unknown, attempt: number, options: ResolvedOptions): boolean =>
	attempt < options.maxAttempts && options.signal?.aborted !== true && options.isRetryable(error, attempt);
