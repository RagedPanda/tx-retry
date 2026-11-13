/**
 * Runs `work` inside one database transaction: begins it, commits when `work` resolves and rolls back
 * when it rejects, then settles with the outcome. Kysely's `db.transaction().execute`, Drizzle's
 * `db.transaction`, Prisma's `$transaction` and TypeORM's `dataSource.transaction` already have this shape.
 */
export type Transact<Transaction> = <Result>(work: (transaction: Transaction) => Promise<Result>) => Promise<Result>;

/** What an `afterRollback` callback learns about the attempt that failed. */
export type RollbackEvent = {
	/** Why the attempt failed: what `work`, the commit or the driver threw. */
	readonly error: unknown;
	/** The attempt that failed, starting at 1. */
	readonly attempt: number;
	/** Whether runTransaction runs the transaction again after this. */
	readonly willRetry: boolean;
};

/** What `onRetry` learns before the transaction runs again. */
export type RetryEvent = {
	/** The retryable error that ended the attempt. */
	readonly error: unknown;
	/** The attempt that failed, starting at 1. */
	readonly attempt: number;
	/** How long runTransaction waits before the next attempt, in milliseconds. */
	readonly delay: number;
};

/** Passed to `work` next to the transaction. Callbacks belong to the current attempt only. */
export type TransactionHooks = {
	/** The current attempt, starting at 1. */
	readonly attempt: number;
	/** The `signal` from the options, so `work` can pass it on to the queries that take one. */
	readonly signal: AbortSignal | undefined;
	/**
	 * Runs `callback` after this attempt commits. A failed attempt drops its callbacks, so a callback
	 * registered in an attempt that is retried runs once, from the attempt that commits.
	 */
	readonly afterCommit: (callback: () => unknown) => void;
	/** Runs `callback` after this attempt fails and the transaction rolls back, whether or not it is retried. */
	readonly afterRollback: (callback: (event: RollbackEvent) => unknown) => void;
};

export type RunTransactionOptions = {
	/** How many times to run the transaction in total, the first attempt included. Default 5. */
	readonly maxAttempts?: number | undefined;
	/** The cap on the delay before the second attempt, in milliseconds; it doubles with every failure. Default 10. */
	readonly baseDelay?: number | undefined;
	/** The largest delay between attempts, in milliseconds. Default 1000. */
	readonly maxDelay?: number | undefined;
	/** Decides whether an error means the transaction can run again. Default `isRetryableError`. */
	readonly isRetryable?: ((error: unknown, attempt: number) => boolean) | undefined;
	/** Called before waiting for the next attempt, for logging and metrics. runTransaction awaits it. */
	readonly onRetry?: ((event: RetryEvent) => unknown) | undefined;
	/** Stops further attempts: a pending wait rejects with `signal.reason`. A running attempt is not interrupted. */
	readonly signal?: AbortSignal | undefined;
	/** A number in [0, 1) for the jitter. Default `Math.random`; replace it to make delays predictable in tests. */
	readonly random?: (() => number) | undefined;
};
