// Measures what runTransaction adds to a transaction that commits on its first attempt, the common case,
// next to the same transaction run bare and wrapped in p-retry with the same error check.
//
//   npm run bench
//   BENCH_TRANSACTIONS=2000 BENCH_RUNS=3 npm run bench
//
// Each run executes the transactions one after another; the table shows the median of the timed runs.
import os from 'node:os';
import {performance} from 'node:perf_hooks';
import {DatabaseSync} from 'node:sqlite';
import {PGlite, type Transaction as PGliteTransaction} from '@electric-sql/pglite';
import pRetry from 'p-retry';
import {fromSqlite, isRetryableError, runTransaction, type Transact} from '../src/index.ts';

const transactionCount = Number(process.env['BENCH_TRANSACTIONS'] ?? 20_000);
const runs = Number(process.env['BENCH_RUNS'] ?? 7);
const warmups = 2;

/** One way to run a transaction: bare, through tx-retry, or through p-retry. */
type Runner = <Transaction>(transact: Transact<Transaction>, work: (transaction: Transaction) => Promise<unknown>) => Promise<unknown>;

const runners: ReadonlyArray<{readonly name: string; readonly run: Runner}> = [
	{name: 'bare transaction', run: async (transact, work) => transact(work)},
	{name: 'tx-retry', run: async (transact, work) => runTransaction(transact, work)},
	{
		name: 'p-retry 9 around it',
		run: async (transact, work) => pRetry(async () => transact(work), {retries: 4, minTimeout: 10, shouldRetry: ({error}) => isRetryableError(error)}),
	},
];

type Scenario<Transaction> = {
	readonly name: string;
	readonly transact: Transact<Transaction>;
	readonly work: (transaction: Transaction) => Promise<unknown>;
};

/** A transaction without a database, so only the wrapper's own cost is measured. */
const noDatabase: Scenario<undefined> = {
	name: 'no database (a transaction that resolves at once)',
	transact: async work => work(undefined),
	work: async () => 1,
};

const sqliteDatabase = new DatabaseSync(':memory:');
sqliteDatabase.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)');
const sqliteInsert = sqliteDatabase.prepare('INSERT INTO items (name) VALUES (?)');
const nodeSqlite: Scenario<DatabaseSync> = {
	name: 'node:sqlite in memory, one INSERT',
	transact: fromSqlite(sqliteDatabase),
	work: async () => sqliteInsert.run('item'),
};

const pglite = await PGlite.create();
await pglite.exec('CREATE TABLE items (id serial PRIMARY KEY, name text)');
const pgliteTransact: Transact<PGliteTransaction> = async work => pglite.transaction(work);
const pgliteScenario: Scenario<PGliteTransaction> = {
	name: 'PGlite in process, one INSERT',
	transact: pgliteTransact,
	work: async transaction => transaction.query('INSERT INTO items (name) VALUES ($1)', ['item']),
};

const median = (values: readonly number[]): number => {
	const sorted = values.toSorted((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/** Runs the transactions one after another and returns transactions per second. */
const timeRun = async <Transaction>(runner: Runner, scenario: Scenario<Transaction>, count: number): Promise<number> => {
	const start = performance.now();
	for (let index = 0; index < count; index++) {
		await runner(scenario.transact, scenario.work);
	}

	return count / ((performance.now() - start) / 1000);
};

const measure = async <Transaction>(runner: Runner, scenario: Scenario<Transaction>, count: number): Promise<number> => {
	const rates = [];
	for (let run = 0; run < warmups + runs; run++) {
		const rate = await timeRun(runner, scenario, count);
		if (run >= warmups) {
			rates.push(rate);
		}
	}

	return median(rates);
};

const formatRate = (rate: number, bare: number): string => {
	const overhead = (1 / rate - 1 / bare) * 1e6;
	return `${Math.round(rate).toLocaleString('en')} tx/s${rate === bare ? '' : ` (${overhead >= 0 ? '+' : ''}${overhead.toFixed(2)} µs)`}`;
};

const benchScenario = async <Transaction>(scenario: Scenario<Transaction>, count: number): Promise<string> => {
	const rates = [];
	for (const runner of runners) {
		rates.push(await measure(runner.run, scenario, count));
	}

	const bare = rates[0]!;
	return `| ${scenario.name} | ${rates.map(rate => formatRate(rate, bare)).join(' | ')} |`;
};

console.log(`Node.js ${process.version}, ${os.cpus()[0]?.model ?? os.arch()} (${os.cpus().length} cores), ${os.platform()} ${os.release()}`);
console.log(`${transactionCount.toLocaleString('en')} sequential transactions per run (a tenth of that for PGlite), median of ${runs} runs after ${warmups} warmups\n`);
console.log(`| Transaction | ${runners.map(runner => runner.name).join(' | ')} |`);
console.log(`| --- |${runners.map(() => ' ---: |').join('')}`);
console.log(await benchScenario(noDatabase, transactionCount));
console.log(await benchScenario(nodeSqlite, transactionCount));
console.log(await benchScenario(pgliteScenario, Math.max(1, Math.floor(transactionCount / 10))));
sqliteDatabase.close();
await pglite.close();
