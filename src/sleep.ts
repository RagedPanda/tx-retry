/** Waits `milliseconds`, or rejects with the signal's reason as soon as it aborts. */
export const sleep = async (milliseconds: number, signal: AbortSignal | undefined): Promise<void> =>
	new Promise((resolve, reject) => {
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(signal?.reason);
		};

		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, milliseconds);
		signal?.addEventListener('abort', onAbort, {once: true});
	});
