// Real serialization failures and deadlocks from concurrent sessions on a real PostgreSQL server.
// Skipped when no PostgreSQL binaries are installed; see test/postgres-server.ts.
import assert from 'node:assert/strict';
import {after, before, describe, test} from 'node:test';
import pg from 'pg';
import {DataSource} from 'typeorm';
import {fromPgPool, fromTypeorm, retryReason, runTransaction, type RetryEvent} from '../src/index.ts';
import {createBarrier} from './helpers.ts';
import {startPostgres, type PostgresServer} from './postgres-server.ts';

const server: PostgresServer | undefined = startPostgres({deadlock_timeout: '50ms'});

describe(`real PostgreSQL server (${server?.version ?? 'not installed, skipped'})`, {skip: server === undefined}, () => {
	let pool: pg.Pool;

	before(async () => {
		pool = new pg.Pool({host: server?.host, user: 'postgres', database: 'postgres', max: 10});
		await pool.query(`
			CREATE TABLE doctors (name text PRIMARY KEY, on_call boolean NOT NULL);
			CREATE TABLE accounts (id text PRIMARY KEY, balance int NOT NULL);
			CREATE TABLE counters (id int PRIMARY KEY, value int NOT NULL);
		`);
	});

	after(async () => {
		await pool.end();
		server?.stop();
	});

	/** Two doctors on call; each goes off call only if the other is still on. Both at once is write skew. */
	const goOffCall = (name: string, lineUp: () => Promise<void>) => async (client: pg.PoolClient, hooks: {attempt: number}): Promise<boolean> => {
		const {rows} = await client.query<{count: string}>('SELECT count(*) FROM doctors WHERE on_call');
		if (hooks.attempt === 1) {
			await lineUp();
		}

		if (Number(rows[0]?.count) < 2) {
			return false;
		}

		await client.query('UPDATE doctors SET on_call = false WHERE name = $1', [name]);
		return true;
	};

	test('write skew under SERIALIZABLE: the real 40001 is retried, and the retry sees the committed data', async () => {
		await pool.query(`TRUNCATE doctors; INSERT INTO doctors VALUES ('alice', true), ('bob', true)`);
		const lineUp = createBarrier(2);
		const retries: RetryEvent[] = [];
		const options = {baseDelay: 5, onRetry: (event: RetryEvent) => retries.push(event)};
		const transact = fromPgPool(pool, {isolationLevel: 'serializable'});

		const wentOff = await Promise.all([
			runTransaction(transact, goOffCall('alice', lineUp), options),
			runTransaction(transact, goOffCall('bob', lineUp), options),
		]);

		assert.deepEqual(wentOff.toSorted(), [false, true]);
		assert.equal(retries.length, 1);
		assert.equal((retries[0]?.error as {code: string}).code, '40001');
		const {rows} = await pool.query('SELECT count(*)::int AS n FROM doctors WHERE on_call');
		assert.equal(rows[0].n, 1, 'one doctor stays on call');
	});

	test('without a retry the same write skew fails one of the two transactions', async () => {
		await pool.query(`TRUNCATE doctors; INSERT INTO doctors VALUES ('alice', true), ('bob', true)`);
		const lineUp = createBarrier(2);
		const transact = fromPgPool(pool, {isolationLevel: 'serializable'});
		const results = await Promise.allSettled([
			runTransaction(transact, goOffCall('alice', lineUp), {maxAttempts: 1}),
			runTransaction(transact, goOffCall('bob', lineUp), {maxAttempts: 1}),
		]);
		const failures = results.filter(result => result.status === 'rejected');
		assert.equal(failures.length, 1);
		assert.equal((failures[0]?.reason as {code: string}).code, '40001');
	});

	test('a real deadlock (40P01) is retried and both transfers land exactly once', async () => {
		await pool.query(`TRUNCATE accounts; INSERT INTO accounts VALUES ('a', 100), ('b', 100)`);
		const lineUp = createBarrier(2);
		const reasons: unknown[] = [];
		const transfer = (from: string, to: string) => async (client: pg.PoolClient, hooks: {attempt: number}): Promise<number> => {
			await client.query('UPDATE accounts SET balance = balance - 10 WHERE id = $1', [from]);
			if (hooks.attempt === 1) {
				await lineUp();
			}

			await client.query('UPDATE accounts SET balance = balance + 10 WHERE id = $1', [to]);
			return hooks.attempt;
		};

		const options = {baseDelay: 5, onRetry: ({error}: RetryEvent) => reasons.push(retryReason(error))};
		const attempts = await Promise.all([
			runTransaction(fromPgPool(pool), transfer('a', 'b'), options),
			runTransaction(fromPgPool(pool), transfer('b', 'a'), options),
		]);

		assert.deepEqual(attempts.toSorted(), [1, 2]);
		assert.deepEqual(reasons, ['deadlock']);
		const {rows} = await pool.query<{id: string; balance: number}>('SELECT id, balance FROM accounts ORDER BY id');
		assert.deepEqual(rows, [{id: 'a', balance: 100}, {id: 'b', balance: 100}]);
	});

	test('eight read-modify-write increments under SERIALIZABLE all land', async () => {
		await pool.query('TRUNCATE counters; INSERT INTO counters VALUES (1, 0)');
		let retryCount = 0;
		const increment = async (client: pg.PoolClient): Promise<void> => {
			const {rows} = await client.query<{value: number}>('SELECT value FROM counters WHERE id = 1');
			await client.query('UPDATE counters SET value = $1 WHERE id = 1', [Number(rows[0]?.value) + 1]);
		};

		await Promise.all(Array.from({length: 8}, async () =>
			runTransaction(fromPgPool(pool, {isolationLevel: 'serializable'}), increment, {
				maxAttempts: 50,
				baseDelay: 2,
				maxDelay: 50,
				onRetry: () => {
					retryCount++;
				},
			})));

		const {rows} = await pool.query<{value: number}>('SELECT value FROM counters WHERE id = 1');
		assert.equal(rows[0]?.value, 8);
		assert.ok(retryCount > 0, 'the increments collided at least once');
	});

	test('TypeORM: fromTypeorm retries the 40001 that TypeORM wraps in QueryFailedError', async () => {
		const dataSource = new DataSource({type: 'postgres', host: server?.host ?? '', username: 'postgres', database: 'postgres'});
		await dataSource.initialize();
		try {
			await dataSource.query(`TRUNCATE doctors; INSERT INTO doctors VALUES ('alice', true), ('bob', true)`);
			const lineUp = createBarrier(2);
			const errors: unknown[] = [];
			const offCall = (name: string) => async (manager: typeof dataSource.manager, hooks: {attempt: number}): Promise<boolean> => {
				const [{count}] = await manager.query('SELECT count(*) FROM doctors WHERE on_call') as [{count: string}];
				if (hooks.attempt === 1) {
					await lineUp();
				}

				if (Number(count) < 2) {
					return false;
				}

				await manager.query('UPDATE doctors SET on_call = false WHERE name = $1', [name]);
				return true;
			};

			const options = {baseDelay: 5, onRetry: ({error}: RetryEvent) => errors.push(error)};
			const transact = fromTypeorm(dataSource, 'SERIALIZABLE');
			const wentOff = await Promise.all([runTransaction(transact, offCall('alice'), options), runTransaction(transact, offCall('bob'), options)]);

			assert.deepEqual(wentOff.toSorted(), [false, true]);
			assert.equal(errors.length, 1);
			assert.equal((errors[0] as Error).name, 'QueryFailedError');
			assert.equal(retryReason(errors[0]), 'serialization_failure');
			const [{n}] = await dataSource.query('SELECT count(*)::int AS n FROM doctors WHERE on_call') as [{n: number}];
			assert.equal(n, 1);
			assert.equal(await runTransaction(fromTypeorm(dataSource.manager), async manager => manager.query('SELECT 1 AS one') as Promise<unknown>).then(rows => (rows as [{one: number}])[0].one), 1);
		} finally {
			await dataSource.destroy();
		}
	});
});
