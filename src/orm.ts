// Adapters for query builders and ORMs that already run a callback in a transaction. Each one is typed
// by the shape of the library's method, so tx-retry imports none of them and `work` gets the library's
// own transaction type.
import type {Transact} from './types.ts';

/** A Kysely `TransactionBuilder`, from `db.transaction()`, optionally with `.setIsolationLevel()` or `.setAccessMode()`. */
export type KyselyTransactionBuilder<Transaction> = {
	execute<Result>(callback: (transaction: Transaction) => Promise<Result>): Promise<Result>;
};

/** Kysely: `fromKysely(db.transaction().setIsolationLevel('serializable'))`. The builder is reusable, so each attempt runs a new transaction. */
export const fromKysely = <Transaction>(builder: KyselyTransactionBuilder<Transaction>): Transact<Transaction> => async work => builder.execute(work);

/** A Drizzle database: anything with `db.transaction(callback, config)`. */
export type DrizzleDatabase<Transaction, Config> = {
	transaction<Result>(callback: (transaction: Transaction) => Promise<Result>, config?: Config): Promise<Result>;
};

/** Drizzle: `fromDrizzle(db, {isolationLevel: 'serializable'})`. The config is passed to every `db.transaction` call. */
export const fromDrizzle = <Transaction, Config>(database: DrizzleDatabase<Transaction, Config>, config?: Config): Transact<Transaction> =>
	async work => (config === undefined ? database.transaction(work) : database.transaction(work, config));

/** A Prisma client: its interactive `$transaction(callback, options)`. */
export type PrismaClientLike<Transaction, Options> = {
	$transaction<Result>(callback: (transaction: Transaction) => Promise<Result>, options?: Options): Promise<Result>;
};

/** Prisma: `fromPrisma(prisma, {isolationLevel: 'Serializable'})`. The options are passed to every interactive `$transaction` call. */
export const fromPrisma = <Transaction, Options>(client: PrismaClientLike<Transaction, Options>, options?: Options): Transact<Transaction> =>
	async work => (options === undefined ? client.$transaction(work) : client.$transaction(work, options));

/** A TypeORM `DataSource` or `EntityManager`. */
export type TypeormTransactionRunner<Manager, IsolationLevel> = {
	transaction<Result>(runInTransaction: (manager: Manager) => Promise<Result>): Promise<Result>;
	transaction<Result>(isolationLevel: IsolationLevel, runInTransaction: (manager: Manager) => Promise<Result>): Promise<Result>;
};

/** TypeORM: `fromTypeorm(dataSource, 'SERIALIZABLE')`. */
export const fromTypeorm = <Manager, IsolationLevel>(
	runner: TypeormTransactionRunner<Manager, IsolationLevel>,
	isolationLevel?: IsolationLevel,
): Transact<Manager> =>
	async work => (isolationLevel === undefined ? runner.transaction(work) : runner.transaction(isolationLevel, work));
