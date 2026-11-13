// Calls and types of the ORM adapters. Their behaviour against real databases is in pglite.test.ts
// (Kysely, Drizzle) and postgres-server.test.ts (TypeORM). Prisma is not installed here, so its adapter
// is checked against a stub with the signature of a generated PrismaClient's `$transaction`.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import pg from 'pg';
import {fromDrizzle, fromPgPool, fromPrisma, fromTypeorm, runTransaction, type Transact} from '../src/index.ts';
import {sqlError} from './helpers.ts';

type PrismaTransactionClient = {readonly user: {readonly create: (data: {name: string}) => Promise<{id: number}>}};
type PrismaTransactionOptions = {maxWait?: number; timeout?: number; isolationLevel?: 'ReadCommitted' | 'Serializable'};

/** The two `$transaction` overloads of a generated client: the batch form first, the interactive form last. */
type PrismaClientStub = {
	$transaction<Batch extends Array<Promise<unknown>>>(batch: [...Batch], options?: {isolationLevel?: 'Serializable'}): Promise<unknown[]>;
	$transaction<Result>(callback: (prisma: PrismaTransactionClient) => Promise<Result>, options?: PrismaTransactionOptions): Promise<Result>;
};

const prismaStub = (calls: unknown[]): PrismaClientStub => ({
	async $transaction(argument: unknown, options?: unknown) {
		calls.push(options);
		const client: PrismaTransactionClient = {user: {create: async () => ({id: calls.length})}};
		return (argument as (prisma: PrismaTransactionClient) => Promise<unknown>)(client);
	},
}) as PrismaClientStub;

test('fromPrisma passes the options to every interactive $transaction and retries P2034', async () => {
	const calls: unknown[] = [];
	const id = await runTransaction(
		fromPrisma(prismaStub(calls), {isolationLevel: 'Serializable', maxWait: 100}),
		async (prisma, hooks) => {
			const user = await prisma.user.create({name: 'ada'});
			if (hooks.attempt === 1) {
				throw Object.assign(new Error('Transaction failed due to a write conflict or a deadlock. Please retry your transaction'), {code: 'P2034'});
			}

			return user.id;
		},
		{baseDelay: 0},
	);
	assert.equal(id, 2);
	assert.deepEqual(calls, [{isolationLevel: 'Serializable', maxWait: 100}, {isolationLevel: 'Serializable', maxWait: 100}]);

	const withoutOptions: unknown[] = [];
	await runTransaction(fromPrisma(prismaStub(withoutOptions)), async () => 1);
	assert.equal(withoutOptions.length, 1);
	assert.equal(withoutOptions[0], undefined);
});

test('fromDrizzle without a config calls db.transaction with the callback only', async () => {
	const argumentCounts: number[] = [];
	const database = {
		async transaction<Result>(...parameters: [(transaction: 'tx') => Promise<Result>, unknown?]): Promise<Result> {
			argumentCounts.push(parameters.length);
			return parameters[0]('tx');
		},
	};
	assert.equal(await runTransaction(fromDrizzle(database), async transaction => transaction), 'tx');
	await assert.rejects(runTransaction(fromDrizzle(database, {isolationLevel: 'serializable'}), async () => {
		throw sqlError('23505');
	}), {code: '23505'});
	assert.deepEqual(argumentCounts, [1, 2]);
});

test('fromTypeorm calls transaction with the isolation level only when one is given', async () => {
	const calls: unknown[][] = [];
	const runner = {
		async transaction(...parameters: unknown[]): Promise<unknown> {
			calls.push(parameters.slice(0, -1));
			return (parameters.at(-1) as (manager: string) => Promise<unknown>)('manager');
		},
	} as {
		transaction<Result>(work: (manager: string) => Promise<Result>): Promise<Result>;
		transaction<Result>(isolationLevel: 'SERIALIZABLE', work: (manager: string) => Promise<Result>): Promise<Result>;
	};
	assert.equal(await runTransaction(fromTypeorm(runner), async manager => manager), 'manager');
	assert.equal(await runTransaction(fromTypeorm(runner, 'SERIALIZABLE'), async manager => manager), 'manager');
	assert.deepEqual(calls, [[], ['SERIALIZABLE']]);
});

test('fromPgPool gives work the pool\'s own client type', () => {
	const transact: Transact<pg.PoolClient> = fromPgPool(new pg.Pool({max: 0}));
	assert.equal(typeof transact, 'function');
});
