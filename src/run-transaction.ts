import {backoffDelay} from './backoff.ts';
import {AfterCommitError, AfterRollbackError} from './errors.ts';
import {createAttemptHooks, runCallbacks} from './hooks.ts';
import {resolveOptions, shouldRetry, type ResolvedOptions} from './options.ts';
import {sleep} from './sleep.ts';
import type {RunTransactionOptions, Transact, TransactionHooks} from './types.ts';

/** How one attempt ended. */
type AttemptOutcome<Result> =
	| {readonly committed: true; readonly result: Result}
	| {readonly committed: false; readonly error: unknown};

const settleAttempt = async <Transaction, Result>(
	transact: Transact<Transaction>,
	work: (transaction: Transaction, hooks: TransactionHooks) => Promise<Result>,
	hooks: TransactionHooks,
): Promise<AttemptOutcome<Result>> => {
	try {
		return {committed: true, result: await transact(async transaction => work(transaction, hooks))};
	} catch (error) {
		return {committed: false, error};
	}
};

/** Settles one attempt: the committed result, or the error that ended it and whether to run it again. */
const runAttempt = async <Transaction, Result>(
	transact: Transact<Transaction>,
	work: (transaction: Transaction, hooks: TransactionHooks) => Promise<Result>,
	options: ResolvedOptions,
	attempt: number,
): Promise<AttemptOutcome<Result> & {readonly willRetry: boolean}> => {
	options.signal?.throwIfAborted();
	const attemptHooks = createAttemptHooks(attempt, options.signal);
	const outcome = await settleAttempt(transact, work, attemptHooks.hooks);
	const callbacks = attemptHooks.close();

	if (outcome.committed) {
		const errors = await runCallbacks(callbacks.afterCommit, undefined);
		if (errors.length > 0) {
			throw new AfterCommitError(errors, outcome.result);
		}

		return {...outcome, willRetry: false};
	}

	const willRetry = shouldRetry(outcome.error, attempt, options);
	const errors = await runCallbacks(callbacks.afterRollback, {error: outcome.error, attempt, willRetry});
	if (errors.length > 0) {
		throw new AfterRollbackError(errors, outcome.error);
	}

	return {...outcome, willRetry};
};

/**
 * Runs `work` in a transaction from `transact`, and runs the whole transaction again when it fails
 * with a serialization failure, deadlock, lock wait timeout or busy database. Each attempt gets a new
 * transaction and fresh hooks; `afterCommit` callbacks run once, after the attempt that commits.
 * The last error is rethrown as is when attempts run out or the error is not retryable.
 */
export const runTransaction = async <Transaction, Result>(
	transact: Transact<Transaction>,
	work: (transaction: Transaction, hooks: TransactionHooks) => Promise<Result>,
	options: RunTransactionOptions = {},
): Promise<Result> => {
	const resolved = resolveOptions(options);
	let attempt = 1;
	let outcome = await runAttempt(transact, work, resolved, attempt);
	while (!outcome.committed) {
		if (!outcome.willRetry) {
			throw outcome.error;
		}

		const delay = backoffDelay(attempt, resolved, resolved.random());
		await resolved.onRetry?.({error: outcome.error, attempt, delay});
		await sleep(delay, resolved.signal);
		attempt++;
		outcome = await runAttempt(transact, work, resolved, attempt);
	}

	return outcome.result;
};
