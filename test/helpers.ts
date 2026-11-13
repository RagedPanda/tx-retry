import type {Transact} from '../src/index.ts';

/** An error shaped like the one node-postgres throws for a SQLSTATE. */
export const sqlError = (code: string, message = `failed with ${code}`): Error & {code: string} => Object.assign(new Error(message), {code});

/** A transaction runner without a database: it records begin, commit and rollback, and passes `name` to `work`. */
export const recordingTransact = (log: string[], name = 'tx'): Transact<string> => async work => {
	log.push('begin');
	try {
		const result = await work(name);
		log.push('commit');
		return result;
	} catch (error) {
		log.push('rollback');
		throw error;
	}
};

/** Resolves for everyone once `count` callers have arrived, so two transactions can be lined up. */
export const createBarrier = (count: number): (() => Promise<void>) => {
	let arrived = 0;
	let open: () => void = () => undefined;
	const opened = new Promise<void>(resolve => {
		open = resolve;
	});
	return async () => {
		arrived++;
		if (arrived === count) {
			open();
		}

		await opened;
	};
};
