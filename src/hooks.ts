import type {RollbackEvent, TransactionHooks} from './types.ts';

/** The hooks handed to one attempt, and what they collected once the attempt is over. */
export type AttemptHooks = {
	readonly hooks: TransactionHooks;
	/** Stops registration and returns the callbacks the attempt registered, in order. */
	readonly close: () => {
		readonly afterCommit: ReadonlyArray<() => unknown>;
		readonly afterRollback: ReadonlyArray<(event: RollbackEvent) => unknown>;
	};
};

const closedError = (name: string): Error =>
	new Error(`tx-retry: ${name}() was called after its attempt finished. Register callbacks while the transaction runs.`);

/** Fresh hooks for one attempt. Callbacks from a failed attempt never reach the next one. */
export const createAttemptHooks = (attempt: number, signal: AbortSignal | undefined): AttemptHooks => {
	const afterCommit: Array<() => unknown> = [];
	const afterRollback: Array<(event: RollbackEvent) => unknown> = [];
	let open = true;

	const register = <Callback>(name: string, list: Callback[]) => (callback: Callback): void => {
		if (!open) {
			throw closedError(name);
		}

		list.push(callback);
	};

	return {
		hooks: {
			attempt,
			signal,
			afterCommit: register('afterCommit', afterCommit),
			afterRollback: register('afterRollback', afterRollback),
		},
		close() {
			open = false;
			return {afterCommit: [...afterCommit], afterRollback: [...afterRollback]};
		},
	};
};

/** Runs every callback in order, even after one throws, and returns what they threw. */
export const runCallbacks = async <Argument>(
	callbacks: ReadonlyArray<(argument: Argument) => unknown>,
	argument: Argument,
): Promise<unknown[]> => {
	const errors: unknown[] = [];
	for (const callback of callbacks) {
		try {
			// One after another, in the order they were registered.
			await callback(argument);
		} catch (error) {
			errors.push(error);
		}
	}

	return errors;
};
