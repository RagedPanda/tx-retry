import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import BetterSqlite3 from 'better-sqlite3';
import {fromSqlite, retryReason, runTransaction, type RetryEvent} from '../src/index.ts';

const directory = mkdtempSync(join(tmpdir(), 'tx-retry-sqlite-'));
// Windows cannot delete a database file that is still open, so every test closes its connections.
after(() => rmSync(directory, {recursive: true, force: true}));

let fileCount = 0;

/** Two connections to a new WAL database file, with busy_timeout 0 so lock conflicts fail at once. */
const openPair = (): [DatabaseSync, DatabaseSync] => {
	const file = join(directory, `db-${++fileCount}.sqlite`);
	const first = new DatabaseSync(file);
	first.exec('PRAGMA journal_mode = WAL; CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT UNIQUE)');
	return [first, new DatabaseSync(file)];
};

const count = (database: DatabaseSync): number => Number((database.prepare('SELECT count(*) AS n FROM items').get() as {n: number}).n);

test('node:sqlite: a real SQLITE_BUSY at BEGIN IMMEDIATE is retried once the other connection commits', async () => {
	const [holder, writer] = openPair();
	holder.exec('BEGIN IMMEDIATE');
	holder.exec(`INSERT INTO items (name) VALUES ('from holder')`);

	const retries: RetryEvent[] = [];
	const attempt = await runTransaction(
		fromSqlite(writer, {mode: 'immediate'}),
		async (database, hooks) => {
			database.exec(`INSERT INTO items (name) VALUES ('from writer')`);
			return hooks.attempt;
		},
		{
			baseDelay: 0,
			onRetry(event) {
				retries.push(event);
				holder.exec('COMMIT');
			},
		},
	);

	assert.equal(attempt, 2);
	assert.equal(retries.length, 1);
	assert.equal((retries[0]?.error as {errcode: number}).errcode, 5);
	assert.equal(retryReason(retries[0]?.error), 'busy');
	assert.equal(count(holder), 2);
	holder.close();
	writer.close();
});

test('node:sqlite: a real SQLITE_BUSY_SNAPSHOT reruns the whole transaction, which then reads the new data', async () => {
	const [other, writer] = openPair();
	const seen: number[] = [];
	const retries: RetryEvent[] = [];

	await runTransaction(
		fromSqlite(writer),
		async (database, hooks) => {
			const before = count(database);
			seen.push(before);
			if (hooks.attempt === 1) {
				// Another connection commits after this transaction took its read snapshot.
				other.exec(`INSERT INTO items (name) VALUES ('other')`);
			}

			database.exec(`INSERT INTO items (name) VALUES ('row ${before}')`);
		},
		{baseDelay: 0, onRetry: event => retries.push(event)},
	);

	assert.deepEqual(seen, [0, 1]);
	assert.equal((retries[0]?.error as {errcode: number}).errcode, 517);
	assert.deepEqual(writer.prepare('SELECT name FROM items ORDER BY id').all().map(row => row['name']), ['other', 'row 1']);
	assert.equal(writer.isTransaction, false);
	other.close();
	writer.close();
});

test('node:sqlite: an error that is not retryable rolls the transaction back', async () => {
	const [database, unused] = openPair();
	unused.close();
	database.exec(`INSERT INTO items (name) VALUES ('taken')`);
	await assert.rejects(
		runTransaction(fromSqlite(database), async connection => {
			connection.exec(`INSERT INTO items (name) VALUES ('new')`);
			connection.exec(`INSERT INTO items (name) VALUES ('taken')`);
		}),
		{code: 'ERR_SQLITE_ERROR', errcode: 2067},
	);
	assert.equal(count(database), 1);
	assert.equal(database.isTransaction, false);
	database.close();
});

test('node:sqlite: when the transaction already ended, the failed ROLLBACK is ignored and the original error kept', async () => {
	const [database, unused] = openPair();
	unused.close();
	const failure = new Error('after an early COMMIT');
	await assert.rejects(
		runTransaction(fromSqlite(database), async connection => {
			connection.exec(`INSERT INTO items (name) VALUES ('kept')`);
			connection.exec('COMMIT');
			throw failure;
		}),
		thrown => thrown === failure,
	);
	assert.equal(count(database), 1);
	database.close();
});

test('better-sqlite3: a real SQLITE_BUSY is retried', async () => {
	const file = join(directory, 'better.sqlite');
	const holder = new BetterSqlite3(file, {timeout: 0});
	holder.pragma('journal_mode = WAL');
	holder.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)');
	const writer = new BetterSqlite3(file, {timeout: 0});
	holder.exec('BEGIN IMMEDIATE');

	const codes: string[] = [];
	const attempt = await runTransaction(
		fromSqlite(writer, {mode: 'exclusive'}),
		async (database, hooks) => {
			database.prepare('INSERT INTO items (name) VALUES (?)').run('from writer');
			return hooks.attempt;
		},
		{
			baseDelay: 0,
			onRetry({error}) {
				codes.push((error as {code: string}).code);
				holder.exec('COMMIT');
			},
		},
	);

	assert.equal(attempt, 2);
	assert.deepEqual(codes, ['SQLITE_BUSY']);
	assert.equal(writer.inTransaction, false);
	holder.close();
	writer.close();
});
