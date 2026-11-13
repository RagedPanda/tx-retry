import type {Transact} from './types.ts';

/** The part of a node:sqlite `DatabaseSync` or a better-sqlite3 `Database` the adapter uses. */
export type SqliteDatabase = {
	readonly exec: (sql: string) => unknown;
};

/**
 * `deferred` (SQLite's default) takes the write lock at the first write, which fails with SQLITE_BUSY at once
 * when another connection holds it; `immediate` takes it at BEGIN, where `busy_timeout` applies.
 */
export type SqliteTransactionMode = 'deferred' | 'immediate' | 'exclusive';

export type SqliteTransactionOptions = {
	/** Default `deferred`. */
	readonly mode?: SqliteTransactionMode | undefined;
};

/** The BEGIN statement for a mode, such as `BEGIN IMMEDIATE`. */
export const sqliteBeginStatement = (mode: SqliteTransactionMode): string => `BEGIN ${mode.toUpperCase()}`;

const rollbackIfActive = (database: SqliteDatabase): void => {
	try {
		database.exec('ROLLBACK');
	} catch {
		// SQLite already ended the transaction (for example after SQLITE_FULL), so there is nothing to roll back.
	}
};

/**
 * One transaction per attempt on a node:sqlite or better-sqlite3 connection. `work` may be async, but the
 * connection is not shared safely: give each transaction that can run at the same time its own connection.
 */
export const fromSqlite = <Database extends SqliteDatabase>(database: Database, options: SqliteTransactionOptions = {}): Transact<Database> => {
	const begin = sqliteBeginStatement(options.mode ?? 'deferred');
	return async work => {
		database.exec(begin);
		try {
			const result = await work(database);
			database.exec('COMMIT');
			return result;
		} catch (error) {
			rollbackIfActive(database);
			throw error;
		}
	};
};
