// Starts a throwaway PostgreSQL server in a new temporary directory, for the tests that need real
// concurrent sessions. It listens only on a Unix socket in that directory and is deleted afterwards.
import {execFileSync} from 'node:child_process';
import {existsSync, mkdtempSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

export type PostgresServer = {
	/** The socket directory, to pass to pg as `host`. */
	readonly host: string;
	readonly version: string;
	readonly stop: () => void;
};

/** A directory holding initdb and pg_ctl: $PG_BIN, the PATH, or Debian's /usr/lib/postgresql/<version>/bin. */
const findBinDirectory = (): string | undefined => {
	const candidates = [
		process.env['PG_BIN'],
		...(process.env['PATH'] ?? '').split(process.platform === 'win32' ? ';' : ':'),
		...(existsSync('/usr/lib/postgresql') ? readdirSync('/usr/lib/postgresql').sort().reverse().map(version => `/usr/lib/postgresql/${version}/bin`) : []),
	];
	return candidates.find(directory => directory !== undefined && directory !== '' && existsSync(join(directory, 'initdb')) && existsSync(join(directory, 'pg_ctl')));
};

/** Starts a server, or returns undefined when no PostgreSQL binaries are installed (or on Windows). */
export const startPostgres = (settings: Readonly<Record<string, string>> = {}): PostgresServer | undefined => {
	const binDirectory = process.platform === 'win32' ? undefined : findBinDirectory();
	if (binDirectory === undefined) {
		return undefined;
	}

	const directory = mkdtempSync(join(tmpdir(), 'tx-retry-pg-'));
	const data = join(directory, 'data');
	const options = ["-c listen_addresses=''", `-k ${directory}`, '-c fsync=off', ...Object.entries(settings).map(([name, value]) => `-c ${name}=${value}`)];
	execFileSync(join(binDirectory, 'initdb'), ['-D', data, '-U', 'postgres', '-A', 'trust', '--no-sync', '-E', 'UTF8'], {stdio: 'ignore'});
	execFileSync(join(binDirectory, 'pg_ctl'), ['-D', data, '-l', join(directory, 'log'), '-w', '-o', options.join(' '), 'start'], {stdio: 'ignore'});
	const version = execFileSync(join(binDirectory, 'postgres'), ['--version'], {encoding: 'utf8'}).trim();
	return {
		host: directory,
		version,
		stop() {
			execFileSync(join(binDirectory, 'pg_ctl'), ['-D', data, '-m', 'immediate', 'stop'], {stdio: 'ignore'});
			rmSync(directory, {recursive: true, force: true});
		},
	};
};
