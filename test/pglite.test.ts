// node-postgres, Kysely and Drizzle against PGlite (real PostgreSQL compiled to WASM) through pglite-socket.
// PGlite runs one session at a time, so the retryable errors here are raised by PostgreSQL itself from
// PL/pgSQL with their real SQLSTATEs; test/postgres-server.test.ts gets them from real concurrent sessions.
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {after, before, test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {PGLiteSocketServer} from '@electric-sql/pglite-socket';
import {drizzle} from 'drizzle-orm/pglite';
import {DrizzleQueryError, sql} from 'drizzle-orm';
import {Kysely, PostgresDialect, sql as kyselySql, type Generated} from 'kysely';
import pg from 'pg';
import {fromDrizzle, fromKysely, fromPgClient, fromPgPool, retryReason, runTransaction, type PgPool, type RetryEvent} from '../src/index.ts';

/** A port nothing listens on, so the test server never meets a real PostgreSQL on 5432. */
const freePort = async (): Promise<number> => new Promise((resolve, reject) => {
	const probe = createServer().once('error', reject).listen(0, '127.0.0.1', () => {
		const {port} = probe.address() as {port: number};
		probe.close(() => resolve(port));
	});
});

const port = await freePort();
const database = await PGlite.create();
const server = new PGLiteSocketServer({db: database, host: '127.0.0.1', port});
const pool = new pg.Pool({host: '127.0.0.1', port, max: 1});

before(async () => {
	await server.start();
	await pool.query(`
		CREATE TABLE items (id serial PRIMARY KEY, name text NOT NULL);
		CREATE SEQUENCE attempts;
		-- Fails a transaction with a real serialization_failure the first time it is called.
		CREATE FUNCTION fail_first(times int) RETURNS void LANGUAGE plpgsql AS $$
		BEGIN
			IF nextval('attempts') <= times THEN
				RAISE EXCEPTION 'could not serialize access' USING ERRCODE = 'serialization_failure';
			END IF;
		END $$;
	`);
});

after(async () => {
	await pool.end();
	await server.stop();
	await database.close();
});

const reset = async (): Promise<void> => {
	await pool.query(`TRUNCATE items; SELECT setval('attempts', 1, false)`);
};

const names = async (): Promise<string[]> => (await pool.query<{name: string}>('SELECT name FROM items ORDER BY id')).rows.map(row => row.name);

test('pgPool commits and returns the result', async () => {
	await reset();
	const id = await runTransaction(fromPgPool(pool), async client => {
		const {rows} = await client.query<{id: number}>(`INSERT INTO items (name) VALUES ('one') RETURNING id`);
		return rows[0]?.id;
	});
	assert.equal(typeof id, 'number');
	assert.deepEqual(await names(), ['one']);
	assert.equal(pool.idleCount, 1);
});

test('pgPool reruns the whole transaction after a 40001, and the first attempt leaves nothing behind', async () => {
	await reset();
	const retries: RetryEvent[] = [];
	const committed: number[] = [];
	const attempt = await runTransaction(
		fromPgPool(pool),
		async (client, hooks) => {
			await client.query(`INSERT INTO items (name) VALUES ('attempt ${hooks.attempt}')`);
			await client.query('SELECT fail_first(2)');
			hooks.afterCommit(() => committed.push(hooks.attempt));
			return hooks.attempt;
		},
		{baseDelay: 0, onRetry: event => retries.push(event)},
	);
	assert.equal(attempt, 3);
	assert.deepEqual(retries.map(({error}) => (error as {code: string}).code), ['40001', '40001']);
	assert.ok(retries[0]?.error instanceof pg.DatabaseError);
	assert.deepEqual(await names(), ['attempt 3']);
	assert.deepEqual(committed, [3]);
});

test('a 40001 raised at COMMIT by a deferred trigger is retried too', async () => {
	await reset();
	await pool.query(`
		CREATE FUNCTION fail_at_commit() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN PERFORM fail_first(1); RETURN NULL; END $$;
		CREATE CONSTRAINT TRIGGER items_commit AFTER INSERT ON items DEFERRABLE INITIALLY DEFERRED
			FOR EACH ROW EXECUTE FUNCTION fail_at_commit();
	`);
	try {
		const statements: string[] = [];
		const attempt = await runTransaction(
			fromPgPool(pool),
			async (client, hooks) => {
				await client.query(`INSERT INTO items (name) VALUES ('deferred ${hooks.attempt}')`);
				statements.push('insert');
				return hooks.attempt;
			},
			{baseDelay: 0},
		);
		assert.equal(attempt, 2);
		assert.deepEqual(statements, ['insert', 'insert']);
		assert.deepEqual(await names(), ['deferred 2']);
		assert.equal(pool.idleCount, 1);
	} finally {
		await pool.query('DROP TRIGGER items_commit ON items; DROP FUNCTION fail_at_commit');
	}
});

test('pgPool rethrows an error that is not retryable and releases the connection for reuse', async () => {
	await reset();
	await assert.rejects(
		runTransaction(fromPgPool(pool), async client => {
			await client.query(`INSERT INTO items (name) VALUES ('rolled back')`);
			await client.query('INSERT INTO items (name) VALUES (NULL)');
		}),
		{code: '23502'},
	);
	assert.deepEqual(await names(), []);
	assert.equal(pool.idleCount, 1);
});

test('pgClient sets the isolation level and access mode', async () => {
	await reset();
	const client = await pool.connect();
	try {
		const settings = await runTransaction(fromPgClient(client, {isolationLevel: 'serializable', readOnly: true}), async connection => {
			const isolation = await connection.query<{transaction_isolation: string}>('SHOW transaction_isolation');
			const readOnly = await connection.query<{transaction_read_only: string}>('SHOW transaction_read_only');
			return [isolation.rows[0]?.transaction_isolation, readOnly.rows[0]?.transaction_read_only];
		});
		assert.deepEqual(settings, ['serializable', 'on']);

		await assert.rejects(
			runTransaction(fromPgClient(client, {readOnly: true}), async connection => connection.query(`INSERT INTO items (name) VALUES ('no')`)),
			{code: '25006'},
		);
		const {rows} = await client.query<{in_transaction: boolean}>(`SELECT now() = statement_timestamp() AS in_transaction`);
		assert.equal(rows[0]?.in_transaction, true, 'the client is back outside a transaction');
	} finally {
		client.release();
	}
});

test('pgPool destroys the connection when ROLLBACK fails, and gives back the original error', async () => {
	const released: unknown[] = [];
	const failure = new Error('connection terminated');
	const brokenPool = (rollbackFailure: unknown): PgPool => ({
		connect: async () => ({
			query: async (text: string) => {
				if (text === 'ROLLBACK') {
					throw rollbackFailure;
				}

				throw failure;
			},
			release: error => released.push(error),
		}),
	});

	await assert.rejects(runTransaction(fromPgPool(brokenPool(new Error('no connection'))), async () => 1), thrown => thrown === failure);
	await assert.rejects(runTransaction(fromPgPool(brokenPool('not an Error')), async () => 1), thrown => thrown === failure);
	assert.deepEqual(released.map(error => (error as Error).message), ['no connection', 'not an Error']);
	assert.ok(released.every(error => error instanceof Error));
});

test('Kysely: fromKysely, and db.transaction().execute passes the pg error through, so it is retried', async () => {
	await reset();
	const db = new Kysely<{items: {id: Generated<number>; name: string}}>({dialect: new PostgresDialect({pool})});
	const reasons: unknown[] = [];
	const attempt = await runTransaction(
		fromKysely(db.transaction().setIsolationLevel('serializable')),
		async (transaction, hooks) => {
			await transaction.insertInto('items').values({name: `kysely ${hooks.attempt}`}).execute();
			await kyselySql`SELECT fail_first(1)`.execute(transaction);
			return hooks.attempt;
		},
		{baseDelay: 0, onRetry: ({error}) => reasons.push(retryReason(error))},
	);
	assert.equal(attempt, 2);
	assert.deepEqual(reasons, ['serialization_failure']);
	assert.deepEqual(await names(), ['kysely 2']);
});

test('Drizzle: fromDrizzle, and db.transaction wraps the error in DrizzleQueryError, and the cause is found', async () => {
	await reset();
	const db = drizzle(database);
	const wrapped: string[] = [];
	const attempt = await runTransaction(
		fromDrizzle(db, {isolationLevel: 'serializable'}),
		async (transaction, hooks) => {
			await transaction.execute(sql`INSERT INTO items (name) VALUES (${`drizzle ${hooks.attempt}`})`);
			await transaction.execute(sql`SELECT fail_first(1)`);
			return hooks.attempt;
		},
		{baseDelay: 0, onRetry: ({error}) => wrapped.push(`${error instanceof DrizzleQueryError} ${(error as {code?: string}).code} ${retryReason(error)}`)},
	);
	assert.equal(attempt, 2);
	assert.deepEqual(wrapped, ['true undefined serialization_failure']);
	assert.deepEqual(await names(), ['drizzle 2']);
});
