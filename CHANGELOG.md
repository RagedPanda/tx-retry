# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-13

### Added

- `runTransaction(transact, work, options)` runs the whole transaction again when it fails with a PostgreSQL serialization failure (40001) or deadlock (40P01), a MySQL deadlock (1213) or lock wait timeout (1205), a Prisma write conflict (P2034), or SQLite `SQLITE_BUSY`, `SQLITE_BUSY_SNAPSHOT` or `SQLITE_LOCKED`, including errors at COMMIT.
- Exponential backoff with full jitter (`maxAttempts`, `baseDelay`, `maxDelay`), a replaceable `isRetryable`, an `onRetry` hook and `AbortSignal` support.
- `hooks.afterCommit` callbacks that run once, after the attempt that commits, and `hooks.afterRollback` callbacks for every attempt that fails.
- `isRetryableError` and `retryReason`, which also look inside the wrappers of TypeORM, Drizzle, Sequelize and Prisma.
- Adapters for node-postgres pools and clients (`fromPgPool`, `fromPgClient`), SQLite (`fromSqlite`, for `node:sqlite` and better-sqlite3), Kysely, Drizzle, Prisma and TypeORM.

[Unreleased]: https://github.com/RagedPanda/tx-retry/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/RagedPanda/tx-retry/releases/tag/v0.1.0
