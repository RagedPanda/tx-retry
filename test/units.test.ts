import assert from 'node:assert/strict';
import {test} from 'node:test';
import {backoffDelay, defaultOptions, isRetryableError, pgBeginStatement, retryReason, sqliteBeginStatement} from '../src/index.ts';
import {sleep} from '../src/sleep.ts';
import {sqlError} from './helpers.ts';

test('PostgreSQL and Prisma codes', () => {
	assert.equal(retryReason(sqlError('40001')), 'serialization_failure');
	assert.equal(retryReason(sqlError('40P01')), 'deadlock');
	assert.equal(retryReason(sqlError('P2034')), 'serialization_failure');
	for (const code of ['23505', '25P02', '55P03', '57014', '08006', 'P2002']) {
		assert.equal(retryReason(sqlError(code)), undefined, code);
	}
});

test('MySQL codes and error numbers, as mysql2 and mariadb set them', () => {
	assert.equal(retryReason({code: 'ER_LOCK_DEADLOCK', errno: 1213, sqlState: '40001'}), 'deadlock');
	assert.equal(retryReason({code: 'ER_LOCK_WAIT_TIMEOUT', errno: 1205}), 'lock_timeout');
	assert.equal(retryReason({errno: 1213}), 'deadlock');
	assert.equal(retryReason({errno: 1205}), 'lock_timeout');
	assert.equal(retryReason({code: 'ER_DUP_ENTRY', errno: 1062}), undefined);
	assert.equal(retryReason({errno: -61, code: 'ECONNREFUSED'}), undefined);
});

test('SQLite codes, named (better-sqlite3, libsql) and numeric (node:sqlite)', () => {
	assert.equal(retryReason({code: 'SQLITE_BUSY'}), 'busy');
	assert.equal(retryReason({code: 'SQLITE_BUSY_SNAPSHOT'}), 'busy');
	assert.equal(retryReason({code: 'SQLITE_LOCKED'}), 'locked');
	assert.equal(retryReason({code: 'SQLITE_LOCKED_SHAREDCACHE'}), 'locked');
	assert.equal(retryReason({code: 'SQLITE_CONSTRAINT_UNIQUE'}), undefined);
	assert.equal(retryReason({code: 'ERR_SQLITE_ERROR', errcode: 5}), 'busy');
	assert.equal(retryReason({code: 'ERR_SQLITE_ERROR', errcode: 517}), 'busy');
	assert.equal(retryReason({code: 'ERR_SQLITE_ERROR', errcode: 6}), 'locked');
	assert.equal(retryReason({code: 'ERR_SQLITE_ERROR', errcode: 19}), undefined);
	assert.equal(retryReason({code: 'ERR_SQLITE_ERROR'}), undefined);
	assert.equal(retryReason({code: 'OTHER', errcode: 5}), undefined);
});

test('wrapped errors: cause, TypeORM driverError, Sequelize original and parent, Prisma meta', () => {
	assert.equal(retryReason(new Error('drizzle', {cause: sqlError('40001')})), 'serialization_failure');
	assert.equal(retryReason(Object.assign(new Error('QueryFailedError'), {driverError: sqlError('40P01')})), 'deadlock');
	assert.equal(retryReason({original: {errno: 1213}}), 'deadlock');
	assert.equal(retryReason({parent: {code: 'SQLITE_BUSY'}}), 'busy');
	assert.equal(retryReason({code: 'P2010', meta: {code: '40001'}}), 'serialization_failure');
	assert.equal(retryReason(new Error('outer', {cause: new Error('middle', {cause: sqlError('40001')})})), 'serialization_failure');
});

test('values that are not errors, cycles and deep chains', () => {
	for (const value of [undefined, null, 'SQLITE_BUSY', 40001, {code: 40001}]) {
		assert.equal(isRetryableError(value), false, String(value));
	}

	const cyclic: {cause?: unknown} = {};
	cyclic.cause = cyclic;
	assert.equal(retryReason(cyclic), undefined);

	const deep = Array.from({length: 12}).reduce<unknown>(cause => ({cause}), sqlError('40001'));
	assert.equal(retryReason(deep), undefined);
	const shallow = Array.from({length: 8}).reduce<unknown>(cause => ({cause}), sqlError('40001'));
	assert.equal(retryReason(shallow), 'serialization_failure');
	assert.equal(isRetryableError(sqlError('40001')), true);
});

test('backoffDelay is full jitter under an exponential cap', () => {
	const options = {baseDelay: 10, maxDelay: 100};
	assert.equal(backoffDelay(1, options, 0.999), 9);
	assert.equal(backoffDelay(2, options, 0.999), 19);
	assert.equal(backoffDelay(3, options, 0.5), 20);
	assert.equal(backoffDelay(10, options, 0.5), 50);
	assert.equal(backoffDelay(4, options, 0), 0);
	assert.deepEqual(defaultOptions, {maxAttempts: 5, baseDelay: 10, maxDelay: 1000});
});

test('pgBeginStatement', () => {
	assert.equal(pgBeginStatement({}), 'BEGIN');
	assert.equal(pgBeginStatement({isolationLevel: 'serializable', readOnly: true, deferrable: true}), 'BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY DEFERRABLE');
	assert.equal(pgBeginStatement({isolationLevel: 'repeatable read', readOnly: false, deferrable: false}), 'BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE NOT DEFERRABLE');
	assert.equal(pgBeginStatement({isolationLevel: 'read committed'}), 'BEGIN ISOLATION LEVEL READ COMMITTED');
	assert.equal(pgBeginStatement({isolationLevel: 'read uncommitted'}), 'BEGIN ISOLATION LEVEL READ UNCOMMITTED');
});

test('sqliteBeginStatement', () => {
	assert.equal(sqliteBeginStatement('deferred'), 'BEGIN DEFERRED');
	assert.equal(sqliteBeginStatement('immediate'), 'BEGIN IMMEDIATE');
	assert.equal(sqliteBeginStatement('exclusive'), 'BEGIN EXCLUSIVE');
});

test('sleep waits, with or without a signal, and leaves no listener behind', async () => {
	const controller = new AbortController();
	const started = performance.now();
	await sleep(15, controller.signal);
	await sleep(0, undefined);
	assert.ok(performance.now() - started >= 14);
	controller.abort(new Error('late'));
});
