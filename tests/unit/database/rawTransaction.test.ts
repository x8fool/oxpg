import { describe, test, expect, beforeEach, spyOn, afterEach } from 'bun:test';
import { resetNatives, setConvar } from '../../setup';
import { resetDb, setConnectionFactory, createFakeConnection, type FakeConnection } from '../../helpers/db';
import * as config from 'config';
import { resetProfilerState } from 'profiler';

const { createConnectionPool } = await import('database/pool');
await createConnectionPool();
const { rawTransaction } = await import('database/rawTransaction');

let conn: FakeConnection;

beforeEach(() => {
  resetNatives();
  resetProfilerState();
  setConvar('mysql_debug', 'false');
  config.setDebug();
  resetDb();
  conn = createFakeConnection();
  setConnectionFactory(() => conn);
});


function enableProfilerOnConnection(connection: FakeConnection) {
  const originalQuery = connection.query.bind(connection);
  connection.query = async (sql: string, values: any[] = []) => {
    if (/^SET profiling/i.test(sql.trim())) {
      return { rows: [], rowCount: 0, command: 'SET', fields: [] };
    }
    if (sql.includes('INFORMATION_SCHEMA.PROFILING')) {
      return { rows: [{ duration: '1.2500' }], rowCount: 1, command: 'SELECT', fields: [] };
    }
    return originalQuery(sql, values);
  };
}

describe('rawTransaction', () => {
  test('begins, runs every query, commits, then releases — in order', async () => {
    let res: unknown;
    await rawTransaction('res', ['INSERT INTO t VALUES (1)', 'UPDATE t SET a = 1'], [], (r) => (res = r));
    expect(res).toBe(true);
    expect(conn.ops()).toEqual(['begin', 'query', 'query', 'commit', 'release']);
  });

  test('rolls back and reports failure when a statement throws', async () => {
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    conn.failOn.query = new Error('constraint violation');

    let res: unknown;
    await rawTransaction('res', ['INSERT INTO t VALUES (1)'], [], (r) => (res = r));

    expect(res).toBe(false);
    expect(conn.ops()).toContain('rollback');
    expect(conn.ops()).not.toContain('commit');
    errSpy.mockRestore();
  });

  test('swallows a rollback failure while handling a statement error', async () => {
    spyOn(console, 'error').mockImplementation(() => {});
    conn.failOn.query = new Error('q fail');
    conn.failOn.rollback = new Error('rollback fail');
    let res: unknown;
    await rawTransaction('res', ['INSERT INTO t VALUES (1)'], [], (r) => (res = r));
    expect(res).toBe(false);
  });

  test('emits oxmysql:transaction-error with a non-empty query detail (transactionError returns its string)', async () => {
    spyOn(console, 'error').mockImplementation(() => {});
    const events: any[] = [];
    (globalThis as any).TriggerEvent = (name: string, payload: any) => events.push({ name, payload });
    conn.failOn.query = new Error('boom');

    await rawTransaction('res', ['INSERT INTO t (a) VALUES (?)'], [9], () => {});

    const event = events.find((e) => e.name === 'oxmysql:transaction-error');
    expect(event).toBeDefined();
    expect(typeof event.payload.query).toBe('string');
    expect(event.payload.query).toContain('INSERT INTO t (a) VALUES (?)');
  });

  test('reports an invalid transaction query list through promise callback mode', async () => {
    const received: any[] = [];
    await rawTransaction('res', null as any, [], (...args) => received.push(args), true);
    expect(received[0][0]).toBeNull();
    expect(String(received[0][1])).toContain('Transaction queries must be array');
  });

  test('logs a non-SCRIPT ERROR string thrown by the completion callback', async () => {
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    await rawTransaction('res', ['UPDATE t SET a = 1'], [], () => {
      throw 'callback failed';
    });
    expect(logSpy.mock.calls.some((call) => String(call[0]).includes('SCRIPT ERROR in invoking resource res'))).toBe(true);
    logSpy.mockRestore();
  });

  test('profiles transaction batches when the database supports profiling', async () => {
    setConvar('mysql_debug', 'true');
    config.setDebug();
    resetProfilerState();
    enableProfilerOnConnection(conn);
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});

    await rawTransaction('res', ['UPDATE t SET a = 1'], []);

    expect(logSpy.mock.calls.some((call) => String(call[0]).includes('1.2500'))).toBe(true);
    logSpy.mockRestore();
  });

});
