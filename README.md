# tx-retry

[![npm version](https://img.shields.io/npm/v/tx-retry)](https://www.npmjs.com/package/tx-retry)
[![CI](https://github.com/RagedPanda/tx-retry/actions/workflows/ci.yml/badge.svg)](https://github.com/RagedPanda/tx-retry/actions/workflows/ci.yml)
[![coverage](https://img.shields.io/badge/coverage-100%25-brightgreen)](https://github.com/RagedPanda/tx-retry/actions/workflows/ci.yml)
[![types](https://img.shields.io/npm/types/tx-retry)](https://www.npmjs.com/package/tx-retry)
[![license](https://img.shields.io/npm/l/tx-retry)](LICENSE)

Run a database transaction again, from the start, when it fails with a serialization failure, a deadlock, a lock wait timeout or a busy SQLite database. Includes backoff with jitter, an `AbortSignal`, and `afterCommit` hooks that run once. Works with node-postgres, Kysely, Drizzle, Prisma, TypeORM, `node:sqlite` and better-sqlite3, and has no dependencies.

```ts
import {fromPgPool, runTransaction} from 'tx-retry';

const order = await runTransaction(fromPgPool(pool, {isolationLevel: 'serializable'}), async (client, {afterCommit}) => {
	const {rows} = await client.query('INSERT INTO orders (item) VALUES ($1) RETURNING *', [item]);
	await client.query('UPDATE stock SET count = count - 1 WHERE item = $1', [item]);
	afterCommit(() => queue.publish('order-placed', rows[0]));
	return rows[0];
});
```

## Why

Under `SERIALIZABLE` or `REPEATABLE READ`, PostgreSQL ends a transaction with SQLSTATE `40001` when it can't keep the transaction consistent with others running at the same time. Any database can end one with a deadlock: `40P01` on PostgreSQL, `1213` on MySQL. SQLite returns `SQLITE_BUSY` when another connection holds the write lock. Each of these errors means "nothing was saved, run it again". The PostgreSQL docs say applications [must be prepared to retry](https://www.postgresql.org/docs/current/transaction-iso.html#XACT-SERIALIZABLE) such transactions.

The usual fixes don't do that correctly:

- **Retrying the failed query.** PostgreSQL aborts the whole transaction on the error. Every later statement fails with `25P02` until ROLLBACK, and earlier writes are gone. A `40001` can also come from COMMIT itself, after every query succeeded. Only rerunning the whole transaction callback works. That is what [typeorm/typeorm#9806](https://github.com/typeorm/typeorm/issues/9806) asks for. The issue has been open since 2023 and has 30 upvotes. TypeORM 1.1 only replays transactions on CockroachDB.
- **Wrapping the transaction in a generic retry, such as [p-retry](https://github.com/sindresorhus/p-retry).** This does rerun the whole transaction, but you have to know every driver's error codes and where each ORM puts them. Drizzle wraps them in a `DrizzleQueryError` with the code on `cause`. TypeORM puts it on `driverError`, and Prisma uses `P2034`. Side effects such as emails, queue messages and cache writes also need somewhere to run once, after the attempt that commits, and never for the attempts that rolled back. Kysely was asked for exactly that in [kysely-org/kysely#396](https://github.com/kysely-org/kysely/issues/396). The answer was that it's "not a query builder's job".

tx-retry is that missing piece. It reruns the transaction callback in a new transaction and recognizes each driver's retryable errors. `afterCommit` callbacks run once, after the attempt that commits.

## Install

```sh
npm install tx-retry
```

Node.js 20 or later (CI tests 22 and 24). tx-retry ships ESM and CommonJS builds with types, and has no dependencies, not even on your driver: each adapter is typed by the shape of the method it calls.

## Usage

`runTransaction(transact, work, options?)` takes three arguments:

- `transact` runs one transaction. Use an adapter below, or any function that begins a transaction, runs a callback, and commits or rolls back.
- `work(transaction, hooks)` is your code. It may run more than once.
- `options` holds the retry settings.

It returns what `work` returns from the attempt that commits.

### node-postgres

```ts
import pg from 'pg';
import {fromPgClient, fromPgPool, runTransaction} from 'tx-retry';

const pool = new pg.Pool();

// A pool connection per attempt; `client` is a pg.PoolClient.
await runTransaction(fromPgPool(pool, {isolationLevel: 'serializable'}), async client => {
	await client.query('UPDATE accounts SET balance = balance - 10 WHERE id = $1', [from]);
	await client.query('UPDATE accounts SET balance = balance + 10 WHERE id = $1', [to]);
});

// A client you already hold. Options: isolationLevel, readOnly, deferrable.
await runTransaction(fromPgClient(client, {isolationLevel: 'repeatable read', readOnly: true}), async client => report(client));
```

`fromPgPool` releases the connection after every attempt. If ROLLBACK fails, for example because the connection broke, it destroys the connection instead, so the retry gets a healthy one.

### Kysely

```ts
import {fromKysely, runTransaction} from 'tx-retry';

await runTransaction(fromKysely(db.transaction().setIsolationLevel('serializable')), async trx => {
	await trx.updateTable('stock').set(eb => ({count: eb('count', '-', 1)})).where('item', '=', item).execute();
});
```

### Drizzle

```ts
import {fromDrizzle, runTransaction} from 'tx-retry';

await runTransaction(fromDrizzle(db, {isolationLevel: 'serializable'}), async tx => {
	await tx.update(stock).set({count: sql`${stock.count} - 1`}).where(eq(stock.item, item));
});
```

### Prisma

```ts
import {fromPrisma, runTransaction} from 'tx-retry';

await runTransaction(fromPrisma(prisma, {isolationLevel: 'Serializable'}), async tx => {
	await tx.stock.update({where: {item}, data: {count: {decrement: 1}}});
});
```

Prisma reports write conflicts and deadlocks as `P2034`, which is retried.

### TypeORM

```ts
import {fromTypeorm, runTransaction} from 'tx-retry';

await runTransaction(fromTypeorm(dataSource, 'SERIALIZABLE'), async manager => {
	await manager.decrement(Stock, {item}, 'count', 1);
});
```

`fromTypeorm` takes a `DataSource` or an `EntityManager`. TypeORM wraps the driver error in a `QueryFailedError`, and tx-retry reads the code from its `driverError`.

### SQLite: node:sqlite and better-sqlite3

```ts
import {DatabaseSync} from 'node:sqlite';
import {fromSqlite, runTransaction} from 'tx-retry';

const db = new DatabaseSync('app.db');
await runTransaction(fromSqlite(db, {mode: 'immediate'}), async db => {
	db.prepare('UPDATE stock SET count = count - 1 WHERE item = ?').run(item);
});
```

`mode` is `deferred` (the default), `immediate` or `exclusive`. With `deferred`, a transaction that reads and then writes in WAL mode can fail with `SQLITE_BUSY_SNAPSHOT` when another connection wrote in between. That error is retried, and the retry reads the new data.

### Anything else

`transact` is any function with this shape. Here it is for a mysql2 pool (an example; it is not run in the tests):

```ts
import type {Transact} from 'tx-retry';

const fromMysqlPool = (pool: mysql.Pool): Transact<mysql.PoolConnection> => async work => {
	const connection = await pool.getConnection();
	try {
		await connection.beginTransaction();
		const result = await work(connection);
		await connection.commit();
		return result;
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
};
```

When your library's transaction method already has the shape `(callback) => Promise`, write it inline as `work => knex.transaction(work)`. Add a type annotation, `Transact<Knex.Transaction>`, so that `work` gets the transaction's type.

### Side effects: afterCommit and afterRollback

```ts
await runTransaction(fromPgPool(pool), async (client, {attempt, afterCommit, afterRollback}) => {
	const user = await createUser(client, input);
	afterCommit(() => mailer.sendWelcome(user.email));
	afterRollback(({error, willRetry}) => log.warn({attempt, willRetry, error}, 'signup rolled back'));
	return user;
});
```

- `work` runs once per attempt. Anything it does outside the database also runs once per attempt.
- `afterCommit` callbacks run once, in order, after the attempt that commits. Callbacks registered in an attempt that rolled back are dropped.
- `afterRollback` callbacks run after each failed attempt. They get `{error, attempt, willRetry}`.
- Callbacks belong to their attempt. Registering one after the attempt has finished throws.

### Logging retries, stopping early

```ts
await runTransaction(transact, work, {
	maxAttempts: 10,
	onRetry: ({error, attempt, delay}) => log.info({reason: retryReason(error), attempt, delay}, 'retrying transaction'),
	signal: AbortSignal.timeout(5_000),
});
```

## API

### `runTransaction(transact, work, options?)`

Returns `Promise<Result>`, the value `work` returned in the attempt that committed. `work` receives `(transaction, hooks)`, where `hooks` is `{attempt, signal, afterCommit(callback), afterRollback(callback)}`.

| Option | Default | |
| --- | --- | --- |
| `maxAttempts` | `5` | Total runs, the first one included. An integer of at least 1, or `Infinity`. |
| `baseDelay` | `10` | The cap on the wait before the second attempt, in ms. The cap doubles after every failure. |
| `maxDelay` | `1000` | The largest wait between attempts, in ms. |
| `isRetryable` | `isRetryableError` | `(error, attempt) => boolean`. Replaces the built-in check. |
| `onRetry` | | `({error, attempt, delay}) => unknown`. Called and awaited before each wait. If it throws, the retries stop with its error. |
| `signal` | | An `AbortSignal`. Stops further attempts. |
| `random` | `Math.random` | Supplies the jitter, a number in [0, 1). |

The wait after failed attempt `n` is `floor(random() * min(maxDelay, baseDelay * 2 ** (n - 1)))`. That is exponential backoff with [full jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/), so sessions that collided don't collide again at the same moment. Options out of range throw a `RangeError` before the first attempt.

How it settles:

- **Commit:** returns the result.
- **An error that is not retryable, or the last attempt:** rethrows the error unchanged. You can still check its `code` or `instanceof`.
- **An `afterCommit` callback throws:** every callback still runs. Then it throws `AfterCommitError`, an `AggregateError` whose `errors` hold what the callbacks threw and whose `result` holds the committed result. The transaction is not run again.
- **An `afterRollback` callback throws:** it stops retrying and throws `AfterRollbackError`, an `AggregateError` with the rollback error as `cause`.
- **`signal` aborts:** an attempt that is running finishes; it is not interrupted. If that attempt commits, you get its result. If it fails, you get its error and there are no more attempts. Aborting before the first attempt, or during a wait between attempts, rejects with `signal.reason`.

### `isRetryableError(error)` and `retryReason(error)`

`retryReason` returns one of `'serialization_failure'`, `'deadlock'`, `'lock_timeout'`, `'busy'` or `'locked'`, or `undefined` when the error isn't retryable. `isRetryableError` is `retryReason(error) !== undefined`.

| Reason | Matches |
| --- | --- |
| `serialization_failure` | PostgreSQL `40001`, Prisma `P2034` |
| `deadlock` | PostgreSQL `40P01`, MySQL and MariaDB `ER_LOCK_DEADLOCK` / errno `1213` |
| `lock_timeout` | MySQL and MariaDB `ER_LOCK_WAIT_TIMEOUT` / errno `1205` |
| `busy` | `SQLITE_BUSY`, `SQLITE_BUSY_SNAPSHOT` and the other `SQLITE_BUSY_*` codes; node:sqlite `errcode` 5 and its extended codes |
| `locked` | `SQLITE_LOCKED*`; node:sqlite `errcode` 6 and its extended codes |

The code is looked for on the error and in the wrappers, up to 8 levels deep:

- `cause`, used by Drizzle and others
- `driverError` (TypeORM)
- `original` and `parent` (Sequelize)
- `meta` (Prisma)

### Adapters

| Adapter | `work` gets | Notes |
| --- | --- | --- |
| `fromPgPool(pool, {isolationLevel?, readOnly?, deferrable?})` | the pool's client | One connection per attempt, released after it. |
| `fromPgClient(client, options?)` | the client | |
| `fromKysely(db.transaction()...)` | Kysely `Transaction` | Isolation level set on the builder. |
| `fromDrizzle(db, config?)` | Drizzle transaction | `config` is passed to every `db.transaction`. |
| `fromPrisma(prisma, options?)` | Prisma transaction client | `options` is passed to every `$transaction`. |
| `fromTypeorm(dataSourceOrManager, isolationLevel?)` | `EntityManager` | |
| `fromSqlite(db, {mode?})` | the database | node:sqlite `DatabaseSync` or better-sqlite3. |

Also exported:

- `backoffDelay(failedAttempt, {baseDelay, maxDelay}, random)`
- `pgBeginStatement(options)` and `sqliteBeginStatement(mode)`
- `defaultOptions`
- the `AfterCommitError` and `AfterRollbackError` classes
- the types `Transact`, `TransactionHooks`, `RunTransactionOptions`, `RetryEvent`, `RollbackEvent` and `RetryReason`

## Tests

Every retry path is tested against a real engine, with real errors:

- **PostgreSQL 14, real concurrent sessions.** The tests start a throwaway server from the installed `initdb` and `pg_ctl`. It runs in a new temporary directory and listens only on a Unix socket there.
  - Write skew between two `SERIALIZABLE` transactions raises a real `40001`.
  - Two transfers locking rows in opposite order raise a real `40P01`.
  - Eight concurrent read-modify-write increments all land.
  - The same write skew is retried through TypeORM.
  - Without the binaries, these tests are skipped.
- **PostgreSQL in [PGlite](https://pglite.dev) (WASM), through pglite-socket.**
  - node-postgres, Kysely and Drizzle.
  - A `40001` raised by PL/pgSQL, including one raised at COMMIT by a deferred constraint trigger.
  - Isolation level and read-only settings, and errors that are not retryable.
- **SQLite with two connections to one file.**
  - A real `SQLITE_BUSY` on node:sqlite and on better-sqlite3.
  - A real `SQLITE_BUSY_SNAPSHOT` in WAL mode, where the retry reads the newer data.
- **MySQL and Prisma: simulated.** The tests build errors with the real codes, in the shapes mysql2 and Prisma use. No MySQL server or Prisma engine was run.

Coverage is 100% of lines, branches and functions, with or without the PostgreSQL server.

## Benchmarks

What does tx-retry cost when nothing goes wrong, which is almost always? `bench/index.ts` runs transactions one after another in three ways:

- bare
- inside `runTransaction`
- inside p-retry 9, with `shouldRetry: ({error}) => isRetryableError(error)`

It reports transactions per second, and in brackets the extra time per transaction compared with the bare run. Each cell is the median of 7 timed runs, after 2 warmup runs.

Node.js 24.17.0, Apple M5 (10 cores), macOS (Darwin 27.0.0), 20,000 transactions per run (2,000 for PGlite):

| Transaction | bare transaction | tx-retry | p-retry 9 around it |
| --- | ---: | ---: | ---: |
| no database (a transaction that resolves at once) | 15,917,750 tx/s | 3,891,334 tx/s (+0.19 µs) | 5,563,991 tx/s (+0.12 µs) |
| node:sqlite in memory, one INSERT | 1,250,853 tx/s | 959,635 tx/s (+0.24 µs) | 1,010,020 tx/s (+0.19 µs) |
| PGlite in process, one INSERT | 23,744 tx/s | 24,678 tx/s (-1.59 µs) | 24,972 tx/s (-2.07 µs) |

tx-retry adds about 0.2 µs per transaction, about the same as p-retry. The extra work is the hooks and checking the options. Next to a transaction that does any real work, that is noise: on PGlite the difference is smaller than the variation between runs. Over a network, a transaction takes hundreds of microseconds or more.

To run it yourself:

```sh
npm run bench
BENCH_TRANSACTIONS=2000 BENCH_RUNS=3 npm run bench
```

## Good to know

- **`work` may run more than once.** Keep side effects outside the database in `afterCommit`. Don't keep state between attempts in variables outside `work`, or reset it at the start of `work`.
- **A lost connection during COMMIT is not retried.** The transaction may or may not have committed, and running it again could apply it twice. Connection errors are not in the retryable list. Add them through `isRetryable` only when your transaction is idempotent.
- **Only the codes above are retried.** Unique violations (`23505`), PostgreSQL's `lock_timeout` (`55P03`), statement timeouts (`57014`) and lost connections (`08006`) are not retried, because running the same transaction again usually fails the same way.
- **MySQL and Prisma are tested with simulated errors only.** CockroachDB uses `40001` too, but it is untested. Its own docs recommend a [client-side retry loop](https://www.cockroachlabs.com/docs/stable/transaction-retry-error-reference), which is what this library is.
- **SQLite connections:** `fromSqlite` uses a single connection, which can't run two transactions at once. Give each transaction that can run at the same time its own connection.
- **SQLITE_BUSY at BEGIN IMMEDIATE:** set a `busy_timeout` on the connection as well, so SQLite waits for the lock itself before tx-retry steps in.
- **Concurrency tests:** PGlite runs one session at a time, so pglite-socket can't produce real concurrency. The tests that need it use a throwaway PostgreSQL server, and are skipped when its binaries aren't installed. CI runs them on runners that have PostgreSQL installed, such as ubuntu-latest.

## Dependencies

There are no runtime dependencies, including no peer dependencies: every adapter is typed by the shape of the method it calls. Dev dependencies, each for one reason:

| Package | Why |
| --- | --- |
| `typescript`, `@types/node` | Type checking and the ESM and CommonJS builds. |
| `pg`, `@types/pg` | node-postgres, for the pool and client adapters, the real-server tests and the type test for `pg.Pool`. |
| `@electric-sql/pglite`, `@electric-sql/pglite-socket` | Real PostgreSQL in-process, so the tests run without a server; the socket lets node-postgres and Kysely connect to it. |
| `kysely`, `drizzle-orm` | The Kysely and Drizzle adapters are tested against the real libraries. |
| `typeorm`, `reflect-metadata` | The TypeORM adapter is tested against a real server; `reflect-metadata` is TypeORM's own requirement. |
| `better-sqlite3`, `@types/better-sqlite3` | The second SQLite driver (`SQLITE_BUSY` by name, not by number). Version 12, because TypeORM 1.1's peer range requires it. |
| `p-retry` | The benchmark's comparison. |

## Related

| Library | Whole-transaction retry | Error codes | afterCommit | Databases |
| --- | --- | --- | --- | --- |
| **tx-retry** | yes | PostgreSQL, MySQL, SQLite, Prisma | yes | any, through adapters |
| [p-retry](https://github.com/sindresorhus/p-retry) | if you wrap the whole transaction | none; you supply `shouldRetry` | no | any |
| [@pg-txmode/pg](https://www.npmjs.com/package/@pg-txmode/pg) | yes (`withTransactionRetry`) | PostgreSQL `40001`, `40P01` | no | PostgreSQL (node-postgres) |
| [TypeORM](https://typeorm.io) built-in | replays queries | `40001` | no | CockroachDB only |
| [pg-transaction](https://www.npmjs.com/package/pg-transaction), [pg-tx](https://www.npmjs.com/package/pg-tx) | no | none | no | PostgreSQL |
| [typeorm-transactional](https://www.npmjs.com/package/typeorm-transactional), [@nestjs-cls/transactional](https://www.npmjs.com/package/@nestjs-cls/transactional) | no | none | see their docs | TypeORM, or several ORMs through CLS |

If you already use p-retry, wrapping it around the transaction with `shouldRetry: ({error}) => isRetryableError(error)` is a fine setup. The benchmark above measures exactly that. tx-retry adds the hooks and the adapters on top.

## License

MIT
