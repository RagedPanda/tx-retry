/** Why a failed transaction is worth running again. */
export type RetryReason = 'serialization_failure' | 'deadlock' | 'lock_timeout' | 'busy' | 'locked';

/** Error codes, as drivers put them in `error.code`, that mean the whole transaction can run again. */
const reasonByCode: ReadonlyMap<string, RetryReason> = new Map<string, RetryReason>([
	// PostgreSQL SQLSTATEs, from pg, postgres.js, PGlite and anything built on them.
	['40001', 'serialization_failure'],
	['40P01', 'deadlock'],
	// Prisma: "Transaction failed due to a write conflict or a deadlock. Please retry your transaction".
	['P2034', 'serialization_failure'],
	// MySQL and MariaDB, from mysql2 and mariadb.
	['ER_LOCK_DEADLOCK', 'deadlock'],
	['ER_LOCK_WAIT_TIMEOUT', 'lock_timeout'],
]);

/** MySQL error numbers, for drivers that set `errno` but not the symbolic `code`. */
const reasonByErrno: ReadonlyMap<number, RetryReason> = new Map<number, RetryReason>([
	[1213, 'deadlock'],
	[1205, 'lock_timeout'],
]);

/** SQLite primary result codes. Extended codes such as SQLITE_BUSY_SNAPSHOT (517) share the low byte. */
const reasonBySqliteResultCode: ReadonlyMap<number, RetryReason> = new Map<number, RetryReason>([
	[5, 'busy'],
	[6, 'locked'],
]);

/** Properties ORMs and drivers use to wrap the original database error. */
const wrapperKeys = ['cause', 'driverError', 'original', 'parent', 'meta'] as const;

/** How many wrappers deep to look, which also stops at cycles such as an error that is its own cause. */
const maxDepth = 8;

type ErrorFields = {readonly code?: unknown; readonly errno?: unknown; readonly errcode?: unknown};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** better-sqlite3 and libsql name the code (`SQLITE_BUSY_SNAPSHOT`), so the prefix gives the primary code. */
const reasonForSqliteName = (code: string): RetryReason | undefined => {
	if (code.startsWith('SQLITE_BUSY')) {
		return 'busy';
	}

	return code.startsWith('SQLITE_LOCKED') ? 'locked' : undefined;
};

/** node:sqlite throws `ERR_SQLITE_ERROR` with the numeric result code in `errcode`. */
const reasonForSqliteNumber = (fields: ErrorFields): RetryReason | undefined =>
	fields.code === 'ERR_SQLITE_ERROR' && typeof fields.errcode === 'number'
		? reasonBySqliteResultCode.get(fields.errcode & 0xff)
		: undefined;

/** The reason found on this one error object, without looking at what it wraps. */
export const ownRetryReason = (fields: ErrorFields): RetryReason | undefined => {
	if (typeof fields.code === 'string') {
		const reason = reasonByCode.get(fields.code) ?? reasonForSqliteName(fields.code);
		if (reason !== undefined) {
			return reason;
		}
	}

	return typeof fields.errno === 'number' ? reasonByErrno.get(fields.errno) : reasonForSqliteNumber(fields);
};

/**
 * Why `error` means the transaction can run again, or undefined when it does not. Looks through the
 * wrappers ORMs put around driver errors: `cause`, TypeORM's `driverError`, Sequelize's `original`
 * and `parent`, and Prisma's `meta`.
 */
export const retryReason = (error: unknown, depth = 0): RetryReason | undefined => {
	if (!isObject(error) || depth > maxDepth) {
		return undefined;
	}

	const own = ownRetryReason(error);
	if (own !== undefined) {
		return own;
	}

	for (const key of wrapperKeys) {
		const reason = retryReason(error[key], depth + 1);
		if (reason !== undefined) {
			return reason;
		}
	}

	return undefined;
};

/** Whether `error` is a serialization failure, deadlock, lock wait timeout or busy database. */
export const isRetryableError = (error: unknown): boolean => retryReason(error) !== undefined;
