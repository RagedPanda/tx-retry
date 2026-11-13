import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AfterCommitError, AfterRollbackError, runTransaction, type RetryEvent, type RollbackEvent} from '../src/index.ts';
import {recordingTransact, sqlError} from './helpers.ts';

/** Fails each listed attempt with its error, then returns the attempt number. */
const failingAttempts = (errors: readonly unknown[]) => async (_transaction: string, hooks: {attempt: number}): Promise<number> => {
	const error = errors[hooks.attempt - 1];
	if (error !== undefined) {
		throw error;
	}

	return hooks.attempt;
};

test('a transaction that commits runs once and returns its result', async () => {
	const log: string[] = [];
	const result = await runTransaction(recordingTransact(log), async (transaction, hooks) => `${transaction} ${hooks.attempt}`);
	assert.equal(result, 'tx 1');
	assert.deepEqual(log, ['begin', 'commit']);
});

test('serialization failures and deadlocks rerun the whole transaction until it commits', async () => {
	const log: string[] = [];
	const retries: RetryEvent[] = [];
	const result = await runTransaction(recordingTransact(log), failingAttempts([sqlError('40001'), sqlError('40P01')]), {
		baseDelay: 4,
		random: () => 0.5,
		onRetry: event => retries.push(event),
	});
	assert.equal(result, 3);
	assert.deepEqual(log, ['begin', 'rollback', 'begin', 'rollback', 'begin', 'commit']);
	assert.deepEqual(retries.map(({attempt, delay}) => ({attempt, delay})), [{attempt: 1, delay: 2}, {attempt: 2, delay: 4}]);
	assert.deepEqual(retries.map(({error}) => (error as {code: string}).code), ['40001', '40P01']);
});

test('afterCommit callbacks run once, in order, from the attempt that commits', async () => {
	const calls: string[] = [];
	const log: string[] = [];
	await runTransaction(
		recordingTransact(log),
		async (_transaction, hooks) => {
			hooks.afterCommit(() => calls.push(`first from attempt ${hooks.attempt}`));
			hooks.afterCommit(async () => {
				await Promise.resolve();
				calls.push(`second from attempt ${hooks.attempt}`);
			});
			calls.push(`work ${hooks.attempt}`);
			if (hooks.attempt < 3) {
				throw sqlError('40001');
			}
		},
		{baseDelay: 0},
	);
	assert.deepEqual(calls, ['work 1', 'work 2', 'work 3', 'first from attempt 3', 'second from attempt 3']);
});

test('afterRollback callbacks run for every failed attempt and say whether it is retried', async () => {
	const events: Array<Omit<RollbackEvent, 'error'> & {code: string}> = [];
	const failure = runTransaction(
		recordingTransact([]),
		async (_transaction, hooks) => {
			hooks.afterRollback(({error, attempt, willRetry}) => events.push({code: (error as {code: string}).code, attempt, willRetry}));
			throw sqlError('40001');
		},
		{maxAttempts: 3, baseDelay: 0},
	);
	await assert.rejects(failure, {code: '40001'});
	assert.deepEqual(events, [
		{code: '40001', attempt: 1, willRetry: true},
		{code: '40001', attempt: 2, willRetry: true},
		{code: '40001', attempt: 3, willRetry: false},
	]);
});

test('an error that is not retryable is rethrown as is after one attempt', async () => {
	const log: string[] = [];
	const error = new TypeError('a bug');
	await assert.rejects(
		runTransaction(recordingTransact(log), async () => {
			throw error;
		}),
		thrown => thrown === error,
	);
	assert.deepEqual(log, ['begin', 'rollback']);
});

test('when attempts run out the last error is rethrown', async () => {
	const last = sqlError('40P01', 'the last one');
	const log: string[] = [];
	await assert.rejects(
		runTransaction(recordingTransact(log), failingAttempts([sqlError('40001'), last]), {maxAttempts: 2, baseDelay: 0}),
		thrown => thrown === last,
	);
	assert.equal(log.filter(entry => entry === 'begin').length, 2);
});

test('maxAttempts 1 never retries', async () => {
	const log: string[] = [];
	await assert.rejects(runTransaction(recordingTransact(log), failingAttempts([sqlError('40001')]), {maxAttempts: 1}), {code: '40001'});
	assert.deepEqual(log, ['begin', 'rollback']);
});

test('isRetryable replaces the built-in classification and receives the attempt', async () => {
	const seen: Array<[string, number]> = [];
	const result = await runTransaction(recordingTransact([]), failingAttempts([new Error('custom'), sqlError('40001')]), {
		baseDelay: 0,
		isRetryable: (error, attempt) => {
			seen.push([(error as Error).message, attempt]);
			return (error as Error).message === 'custom';
		},
	}).catch((error: unknown) => (error as {code: string}).code);
	assert.equal(result, '40001');
	assert.deepEqual(seen, [['custom', 1], ['failed with 40001', 2]]);
});

test('the default jitter draws from Math.random and stays under the cap', async () => {
	const delays: number[] = [];
	await runTransaction(recordingTransact([]), failingAttempts([sqlError('40001'), sqlError('40001')]), {
		baseDelay: 2,
		maxDelay: 3,
		onRetry: ({delay}) => delays.push(delay),
	});
	assert.equal(delays.length, 2);
	assert.ok(delays.every(delay => delay >= 0 && delay <= 3), String(delays));
});

test('onRetry is awaited before the next attempt, and an error from it stops the retries', async () => {
	const log: string[] = [];
	await runTransaction(recordingTransact(log), failingAttempts([sqlError('40001')]), {
		baseDelay: 0,
		onRetry: async () => {
			await new Promise(resolve => setTimeout(resolve, 5));
			log.push('onRetry done');
		},
	});
	assert.deepEqual(log, ['begin', 'rollback', 'onRetry done', 'begin', 'commit']);

	const hookError = new Error('metrics down');
	await assert.rejects(
		runTransaction(recordingTransact([]), failingAttempts([sqlError('40001')]), {
			onRetry: () => {
				throw hookError;
			},
		}),
		thrown => thrown === hookError,
	);
});

test('a throwing afterCommit callback gives AfterCommitError with the result, after every callback ran', async () => {
	const ran: number[] = [];
	const first = new Error('email failed');
	const second = new Error('cache failed');
	const log: string[] = [];
	const error = await runTransaction(recordingTransact(log), async (_transaction, hooks) => {
		hooks.afterCommit(() => {
			ran.push(1);
			throw first;
		});
		hooks.afterCommit(async () => {
			ran.push(2);
			throw second;
		});
		hooks.afterCommit(() => ran.push(3));
		return 'saved';
	}).catch((caught: unknown) => caught);
	assert.ok(error instanceof AfterCommitError);
	assert.ok(error instanceof AggregateError);
	assert.equal(error.name, 'AfterCommitError');
	assert.equal(error.result, 'saved');
	assert.deepEqual(error.errors, [first, second]);
	assert.match(error.message, /committed, but 2 afterCommit/);
	assert.deepEqual(ran, [1, 2, 3]);
	assert.deepEqual(log, ['begin', 'commit']);
});

test('a throwing afterRollback callback gives AfterRollbackError and stops retrying', async () => {
	const cleanup = new Error('cleanup failed');
	const log: string[] = [];
	const error = await runTransaction(recordingTransact(log), async (_transaction, hooks) => {
		hooks.afterRollback(() => {
			throw cleanup;
		});
		throw sqlError('40001');
	}).catch((caught: unknown) => caught);
	assert.ok(error instanceof AfterRollbackError);
	assert.equal(error.name, 'AfterRollbackError');
	assert.deepEqual(error.errors, [cleanup]);
	assert.equal((error.cause as {code: string}).code, '40001');
	assert.deepEqual(log, ['begin', 'rollback']);
});

test('registering a callback after its attempt finished throws', async () => {
	let leaked: {afterCommit: (callback: () => unknown) => void; afterRollback: (callback: () => unknown) => void} | undefined;
	await runTransaction(recordingTransact([]), async (_transaction, hooks) => {
		leaked = hooks;
	});
	assert.throws(() => leaked?.afterCommit(() => undefined), /afterCommit\(\) was called after its attempt finished/);
	assert.throws(() => leaked?.afterRollback(() => undefined), /afterRollback\(\) was called after its attempt finished/);
});

test('an aborted signal stops before the first attempt with its reason', async () => {
	const log: string[] = [];
	const reason = new Error('shutting down');
	await assert.rejects(runTransaction(recordingTransact(log), async () => 1, {signal: AbortSignal.abort(reason)}), thrown => thrown === reason);
	assert.deepEqual(log, []);
});

test('aborting during the wait between attempts rejects with the reason', async () => {
	const controller = new AbortController();
	const reason = new Error('request closed');
	const log: string[] = [];
	const failure = runTransaction(recordingTransact(log), failingAttempts([sqlError('40001')]), {
		signal: controller.signal,
		baseDelay: 10_000,
		random: () => 0.99,
		onRetry: () => {
			setTimeout(() => controller.abort(reason), 5);
		},
	});
	await assert.rejects(failure, thrown => thrown === reason);
	assert.deepEqual(log, ['begin', 'rollback']);
});

test('aborting while an attempt runs lets it finish and rethrows its error instead of retrying', async () => {
	const controller = new AbortController();
	const log: string[] = [];
	const failure = runTransaction(
		recordingTransact(log),
		async (_transaction, hooks) => {
			assert.equal(hooks.signal, controller.signal);
			controller.abort();
			throw sqlError('40001');
		},
		{signal: controller.signal},
	);
	await assert.rejects(failure, {code: '40001'});
	assert.deepEqual(log, ['begin', 'rollback']);
});

test('a result that commits is returned even if the signal aborted during the attempt', async () => {
	const controller = new AbortController();
	const result = await runTransaction(
		recordingTransact([]),
		async () => {
			controller.abort();
			return 'kept';
		},
		{signal: controller.signal},
	);
	assert.equal(result, 'kept');
});

test('a work function that throws synchronously still rolls back and is classified', async () => {
	const log: string[] = [];
	let calls = 0;
	const result = await runTransaction(
		recordingTransact(log),
		((_transaction: string, hooks: {attempt: number}) => {
			calls++;
			if (hooks.attempt === 1) {
				throw sqlError('40001');
			}

			return Promise.resolve('ok');
		}) as (transaction: string, hooks: {attempt: number}) => Promise<string>,
		{baseDelay: 0},
	);
	assert.equal(result, 'ok');
	assert.equal(calls, 2);
	assert.deepEqual(log, ['begin', 'rollback', 'begin', 'commit']);
});

test('maxAttempts Infinity keeps going until the transaction commits', async () => {
	const errors = Array.from({length: 20}, () => sqlError('40001'));
	const result = await runTransaction(recordingTransact([]), failingAttempts(errors), {maxAttempts: Infinity, baseDelay: 0});
	assert.equal(result, 21);
});

test('options out of range are rejected before the first attempt', async () => {
	const log: string[] = [];
	const transact = recordingTransact(log);
	for (const maxAttempts of [0, 1.5, -1, Number.NaN]) {
		await assert.rejects(runTransaction(transact, async () => 1, {maxAttempts}), {name: 'RangeError', message: /maxAttempts must be a whole number/});
	}

	await assert.rejects(runTransaction(transact, async () => 1, {baseDelay: -1}), {name: 'RangeError', message: /baseDelay must be/});
	await assert.rejects(runTransaction(transact, async () => 1, {maxDelay: Number.NaN}), {name: 'RangeError', message: /maxDelay must be/});
	assert.deepEqual(log, []);
});
