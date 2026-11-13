import type {Transact} from './types.ts';

/** The part of a node-postgres `Client` or `PoolClient` the adapter uses. */
export type PgQueryable = {
	readonly query: (text: string) => Promise<unknown>;
};

/** The part of a node-postgres `PoolClient` the adapter uses. */
export type PgPoolClient = PgQueryable & {
	readonly release: (error?: Error | boolean) => void;
};

/** The part of a node-postgres `Pool` the adapter uses. */
export type PgPool = {
	connect(): Promise<PgPoolClient>;
};

type ConnectedClient<Pool> = Pool extends {connect(): Promise<infer Client>} ? Client : never;

/**
 * The client type a pool hands out. node-postgres declares `connect()` twice, with the callback form last,
 * and TypeScript infers from the last overload, so the callback's client parameter is read first.
 */
export type PgPoolClientOf<Pool> = Pool extends {connect(callback: (error: never, client: infer Client, ...rest: never[]) => void): void}
	? unknown extends Client ? ConnectedClient<Pool> : NonNullable<Client>
	: ConnectedClient<Pool>;

export type PgIsolationLevel = 'serializable' | 'repeatable read' | 'read committed' | 'read uncommitted';

export type PgTransactionOptions = {
	/** Default: the server's `default_transaction_isolation`, read committed unless changed. */
	readonly isolationLevel?: PgIsolationLevel | undefined;
	readonly readOnly?: boolean | undefined;
	/** Only has an effect on a serializable, read-only transaction. */
	readonly deferrable?: boolean | undefined;
};

const isolationClause: Readonly<Record<PgIsolationLevel, string>> = {
	serializable: 'ISOLATION LEVEL SERIALIZABLE',
	'repeatable read': 'ISOLATION LEVEL REPEATABLE READ',
	'read committed': 'ISOLATION LEVEL READ COMMITTED',
	'read uncommitted': 'ISOLATION LEVEL READ UNCOMMITTED',
};

/** The BEGIN statement for the options, such as `BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY`. */
export const pgBeginStatement = (options: PgTransactionOptions): string =>
	[
		'BEGIN',
		options.isolationLevel === undefined ? undefined : isolationClause[options.isolationLevel],
		options.readOnly === undefined ? undefined : options.readOnly ? 'READ ONLY' : 'READ WRITE',
		options.deferrable === undefined ? undefined : options.deferrable ? 'DEFERRABLE' : 'NOT DEFERRABLE',
	].filter(part => part !== undefined).join(' ');

/** How a transaction on one connection ended. `brokenBy` is set when ROLLBACK failed, so the connection should not be reused. */
type PgOutcome<Result> =
	| {readonly committed: true; readonly result: Result}
	| {readonly committed: false; readonly error: unknown; readonly brokenBy: Error | undefined};

const rollback = async (client: PgQueryable): Promise<Error | undefined> => {
	try {
		await client.query('ROLLBACK');
		return undefined;
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
};

const settlePgTransaction = async <Client extends PgQueryable, Result>(
	client: Client,
	begin: string,
	work: (client: Client) => Promise<Result>,
): Promise<PgOutcome<Result>> => {
	try {
		await client.query(begin);
		const result = await work(client);
		await client.query('COMMIT');
		return {committed: true, result};
	} catch (error) {
		// After a failed COMMIT the server has already ended the transaction, and ROLLBACK only warns.
		return {committed: false, error, brokenBy: await rollback(client)};
	}
};

const unwrap = <Result>(outcome: PgOutcome<Result>): Result => {
	if (outcome.committed) {
		return outcome.result;
	}

	throw outcome.error;
};

/**
 * One transaction per attempt on a connection checked out of a node-postgres `Pool`. The connection is
 * released after every attempt, and destroyed instead when ROLLBACK failed, so a retry gets a healthy one.
 */
export const fromPgPool = <Pool extends PgPool>(pool: Pool, options: PgTransactionOptions = {}): Transact<PgPoolClientOf<Pool>> => {
	const begin = pgBeginStatement(options);
	return async work => {
		const client = await pool.connect();
		const outcome = await settlePgTransaction(client as PgPoolClientOf<Pool> & PgPoolClient, begin, work);
		client.release(outcome.committed ? undefined : outcome.brokenBy);
		return unwrap(outcome);
	};
};

/** One transaction per attempt on a connected node-postgres `Client` (or a `PoolClient` you manage yourself). */
export const fromPgClient = <Client extends PgQueryable>(client: Client, options: PgTransactionOptions = {}): Transact<Client> => {
	const begin = pgBeginStatement(options);
	return async work => unwrap(await settlePgTransaction(client, begin, work));
};
