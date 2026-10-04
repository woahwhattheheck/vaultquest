import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { BackupService, defaultSpawn, type SpawnFn } from './src/services/backupService.js';
import { JobLeaseService } from './src/services/jobLeaseService.js';

// Disposable localhost PostgreSQL only. Every password below is a synthetic fixture.
const bin = '/usr/lib/postgresql/16/bin';
const port = '55432';
const adminPassword = 'vq220_fixture_only';
const qid = (s: string) => '"' + s.replaceAll('"', '""') + '"';
const qlit = (s: string) => "'" + s.replaceAll("'", "''") + "'";
function sql(host: string, username: string, password: string, database: string, query: string) {
  return execFileSync(join(bin, 'psql'), ['--host', host, '--port', port, '--username', username,
    '--dbname', database, '--no-password', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', query],
    { encoding: 'utf8', env: { ...process.env, PGPASSWORD: password } }).trim();
}
function admin(query: string) { return sql('127.0.0.1', 'postgres', adminPassword, 'postgres', query); }
const cases = [
  { id: 'encoded-dns', host: 'localhost', user: 'ops@tenant', password: 'p@ss', database: 'vault quest' },
  { id: 'double-encoded-ipv4', host: '127.0.0.1', user: 'ops%40tenant', password: 'p%40ss', database: 'vault%20quest' },
  { id: 'ipv6-loopback', host: '::1', user: 'vq220_native', password: 'native_fixture', database: 'vq220_ipv6' },
  { id: 'encoded-ipv6', host: '::1', user: 'ipv6@tenant', password: 'ipv6@fixture', database: 'ipv6 vault' }
];
const receipts: unknown[] = [];
// Prisma 5 treats escaped database path names literally. Bootstrap application
// fixtures through psql and use a separate native ASCII-named lease database.
const schemaSql = execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', 'prisma/schema.prisma', '--script'], { encoding: 'utf8' });
const logger = pino({ level: 'silent' });
for (const c of cases) {
  const dir = await mkdtemp(join(tmpdir(), 'vq220-' + c.id + '-'));
  const hostForUrl = c.host.includes(':') ? `[${c.host}]` : c.host;
  const databaseUrl = `postgresql://${encodeURIComponent(c.user)}:${encodeURIComponent(c.password)}@${hostForUrl}:${port}/${encodeURIComponent(c.database)}`;
  const leaseDatabase = 'vq220_leases_' + c.id.replaceAll('-', '_');
  const leaseUrl = `postgresql://postgres:${adminPassword}@127.0.0.1:${port}/${leaseDatabase}`;
  let prisma: PrismaClient | undefined;
  let leases: JobLeaseService | undefined;
  let target: string | undefined;
  try {
    admin(`CREATE ROLE ${qid(c.user)} WITH LOGIN SUPERUSER PASSWORD ${qlit(c.password)}`);
    admin(`CREATE DATABASE ${qid(c.database)} OWNER ${qid(c.user)}`);
    sql(c.host, c.user, c.password, c.database, schemaSql);
    admin(`CREATE DATABASE ${qid(leaseDatabase)}`);
    sql('127.0.0.1', 'postgres', adminPassword, leaseDatabase, schemaSql);
    const sentinel = 'native fixture ' + c.id;
    sql(c.host, c.user, c.password, c.database,
      `CREATE TABLE native_backup_sentinel (id integer PRIMARY KEY, payload text NOT NULL); INSERT INTO native_backup_sentinel VALUES (220, ${qlit(sentinel)})`);
    prisma = new PrismaClient({ datasources: { db: { url: leaseUrl } } });
    leases = new JobLeaseService({ prisma, logger, ownerId: 'native-' + c.id, ttlMs: 30_000, heartbeatMs: 1_000 });
    const commands: string[] = [];
    let restoredRows: unknown;
    let restoredTableCount = 0;
    const spawn: SpawnFn = async (command, args, env, signal) => {
      const name = basename(command);
      commands.push(name);
      assert.equal(args[args.indexOf('--host') + 1], c.host);
      assert.equal(args[args.indexOf('--port') + 1], port);
      assert.equal(args[args.indexOf('--username') + 1], c.user);
      assert.equal(env.PGPASSWORD, c.password);
      assert.ok(signal instanceof AbortSignal);
      if (name === 'createdb') target = args.at(-1)!;
      const result = await defaultSpawn(command, args, env, signal);
      assert.equal(result.exitCode, 0, name + ': ' + result.stderr);
      if (name === 'pg_restore') {
        assert.equal(args[args.indexOf('--dbname') + 1], target);
        restoredRows = JSON.parse(sql(c.host, c.user, c.password, target!,
          "SELECT json_agg(t ORDER BY id) FROM native_backup_sentinel t"));
        assert.deepEqual(restoredRows, [{ id: 220, payload: sentinel }]);
        restoredTableCount = Number(sql(c.host, c.user, c.password, target!,
          "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"));
        assert.ok(restoredTableCount >= 2);
      }
      console.log('REAL_CLI', JSON.stringify({ case: c.id, command: name, host: c.host, username: c.user, exitCode: result.exitCode }));
      return result;
    };
    const svc = new BackupService({ backupDir: dir, databaseUrl, pgDumpPath: join(bin, 'pg_dump'),
      pgRestorePath: join(bin, 'pg_restore'), spawn, logger });
    const backed = await leases.runWithLease('cron:backup', ctx => svc.run(ctx));
    assert.equal(backed.status, 'ran');
    if (backed.status !== 'ran') throw new Error('Backup lease did not run');
    const backup = backed.value;
    const dumped = await readFile(backup.filePath);
    assert.equal(dumped.subarray(0, 5).toString(), 'PGDMP');
    assert.equal(createHash('sha256').update(dumped).digest('hex'), backup.checksumSha256);
    assert.equal(backup.manifest.databaseName, c.database);
    assert.equal(backup.fileSizeBytes, dumped.length);
    assert.equal((await readdir(dir)).filter(p => p.endsWith('.partial')).length, 0);
    const restored = await leases.runWithLease('cron:restore-drill', ctx => svc.runRestoreDrill({ dumpFilePath: backup.filePath }, ctx));
    assert.equal(restored.status, 'ran');
    if (restored.status !== 'ran') throw new Error('Restore lease did not run');
    assert.equal(restored.value.success, true, JSON.stringify(restored.value));
    assert.deepEqual(commands, ['pg_dump', 'createdb', 'pg_restore', 'dropdb']);
    assert.ok(target?.startsWith('vaultquest_restore_test_'));
    assert.ok(Buffer.byteLength(target!) <= 63);
    assert.equal(admin(`SELECT count(*) FROM pg_database WHERE datname = ${qlit(target!)}`), '0');
    assert.deepEqual(JSON.parse(sql(c.host, c.user, c.password, c.database,
      'SELECT json_agg(t ORDER BY id) FROM native_backup_sentinel t')), [{ id: 220, payload: sentinel }]);
    const manifest = JSON.parse(await readFile(backup.manifestPath, 'utf8'));
    assert.equal(manifest.verificationStatus.verified, true);
    receipts.push({ case: c.id, host: c.host, username: c.user, database: c.database, commands,
      dumpBytes: dumped.length, checksum: backup.checksumSha256, restoredRows, restoredTableCount,
      isolatedRestoreDatabaseRemoved: true, sourceSentinelUnchanged: true, partialArtifacts: 0, leaseDatabaseSeparate: true,
      note: 'Observer delegates every spawn to actual defaultSpawn and checks real restored rows before actual dropdb; no remote storage adapter' });
    console.log('NATIVE_BACKUP_CASE_PASS', JSON.stringify(receipts.at(-1)));
  } catch (error) {
    console.error('NATIVE_BACKUP_CASE_FAILED', c.id, error);
    throw error;
  } finally {
    await leases?.shutdown();
    await prisma?.$disconnect();
    if (target && admin(`SELECT count(*) FROM pg_database WHERE datname = ${qlit(target)}`) !== '0') {
      admin(`DROP DATABASE ${qid(target)} WITH (FORCE)`);
    }
    admin(`DROP DATABASE IF EXISTS ${qid(c.database)} WITH (FORCE)`);
    admin(`DROP DATABASE IF EXISTS ${qid(leaseDatabase)} WITH (FORCE)`);
    admin(`DROP ROLE IF EXISTS ${qid(c.user)}`);
    await rm(dir, { recursive: true, force: true });
  }
}
assert.equal(receipts.length, 4);
console.log('VQ220_NATIVE_BACKUP_RESULT: 4/4 real PostgreSQL16 backup/restore cases passed; DNS/IPv4/IPv6 and percent-decoded names; real lease store, filesystem, pg_dump/createdb/pg_restore/dropdb; sentinel data verified and cleanup checked');
