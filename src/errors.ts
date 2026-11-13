/**
 * The transaction committed, but one or more `afterCommit` callbacks threw. The transaction is not run
 * again, since its writes are already saved; `result` holds what it returned and `errors` what the callbacks threw.
 */
export class AfterCommitError<Result = unknown> extends AggregateError {
	override readonly name = 'AfterCommitError';
	readonly result: Result;

	constructor(errors: readonly unknown[], result: Result) {
		super(errors, `The transaction committed, but ${errors.length} afterCommit callback(s) threw`);
		this.result = result;
	}
}

/**
 * One or more `afterRollback` callbacks threw. runTransaction stops instead of retrying; `cause` holds the
 * error that rolled the transaction back and `errors` what the callbacks threw.
 */
export class AfterRollbackError extends AggregateError {
	override readonly name = 'AfterRollbackError';

	constructor(errors: readonly unknown[], cause: unknown) {
		super(errors, `The transaction rolled back, and ${errors.length} afterRollback callback(s) threw`, {cause});
	}
}

/** An option that is out of range, thrown before the first attempt. */
export const invalidOptionError = (name: string, value: unknown, expected: string): RangeError =>
	new RangeError(`tx-retry: ${name} must be ${expected}, got ${String(value)}`);
