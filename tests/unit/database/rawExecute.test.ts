import { describe, test, expect, beforeEach, spyOn } from 'bun:test';
import { resetNatives, setConvar } from '../../setup';
import { resetDb, setConnectionFactory, createFakeConnection, type FakeConnection } from '../../helpers/db';
import * as config from 'config';
import { resetProfilerState } from 'profiler';

const { createConnectionPool } = await import('database/pool');
await createConnectionPool();
const { rawExecute } = await import('database/rawExecute');

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

describe('rawExecute', () => {
  test('executes once per parameter set in a batch', async () => {
    conn.queue.push({ insertId: 1, affectedRows: 1 }, { insertId: 2, affectedRows: 1 });
    await rawExecute('res', 'INSERT INTO t (a) VALUES (?)', [[1], [2]]);
    const executes = conn.calls.filter((c) => c.arg?.sql?.includes('INSERT INTO'));
    expect(executes).toHaveLength(2);
    expect(executes[0].arg.sql).toBe('INSERT INTO t (a) VALUES ($1) RETURNING *');
  });

  test('pads a short value row with null up to the placeholder count', async () => {
    await rawExecute('res', 'INSERT INTO t (a, b) VALUES (?, ?)', [[1]]);
    const exec = conn.calls.find((c) => c.arg?.sql?.includes('INSERT INTO'));
    expect(exec!.arg.values).toEqual([1, null]);
  });

  test('prepare (unpack) returns a single scalar for a one-column row', async () => {
    conn.queue.push([{ id: 7 }]);
    let received: unknown;
    await rawExecute('res', 'SELECT id FROM t WHERE a = ?', [[1]], (r) => (received = r), true, true);
    expect(received).toBe(7);
  });

  test('surfaces an execute error through the callback', async () => {
    conn.failOn.query = new Error('exec failed');
    const args: any[] = [];
    await rawExecute('res', 'INSERT INTO t VALUES (?)', [[1]], (...a) => args.push(a), true);
    expect(String(args[0][1])).toContain('exec failed');
  });

  test('reports a parse error before reaching the connection', async () => {
    const args: any[] = [];
    await rawExecute('res', 123 as any, [[1]], (...a) => args.push(a), true);
    expect(String(args[0][1])).toContain('Expected query to be a string');
    expect(conn.calls).toHaveLength(0);
  });

  test('executes a parameterised select with a single result set', async () => {
    conn.queue.push([{ a: 1 }]);
    const result = await rawExecute('res', 'SELECT a FROM t WHERE id = ?', [[1]]);
    expect(result).toEqual([{ a: 1 }]);
  });

  test('prepare (unpack) returns a whole row when it has multiple columns', async () => {
    conn.queue.push([{ id: 7, name: 'x' }]);
    let received: unknown;
    await rawExecute('res', 'SELECT id, name FROM t WHERE a = ?', [[1]], (r) => (received = r), true, true);
    expect(received).toEqual({ id: 7, name: 'x' });
  });

  test('a callback that throws a SCRIPT ERROR string is swallowed', async () => {
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    await rawExecute('res', 'INSERT INTO t VALUES (?)', [[1]], () => {
      throw 'SCRIPT ERROR: boom';
    }, true);
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  test('flattens multiple result rows returned by a single execute', async () => {
    conn.queue.push([{ id: 1 }, { id: 2 }]);
    const result = await rawExecute('res', 'SELECT id FROM t WHERE a = ?', [[1]]);
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
  });

  test('passes multi-batch callback results as an array', async () => {
    let received: unknown;
    await rawExecute('res', 'SELECT a FROM t WHERE id = ?', [[1], [2]], (value) => (received = value));
    expect(Array.isArray(received)).toBe(true);
    expect((received as unknown[]).length).toBe(2);
  });

  test('logs non-SCRIPT ERROR callback strings', async () => {
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    await rawExecute('res', 'INSERT INTO t VALUES (?)', [[1]], () => {
      throw 'callback failed';
    });
    expect(logSpy.mock.calls.some((call) => String(call[0]).includes('SCRIPT ERROR in invoking resource res'))).toBe(true);
    logSpy.mockRestore();
  });

  test('profiles a completed batch and logs its measured duration', async () => {
    setConvar('mysql_debug', 'true');
    config.setDebug();
    resetProfilerState();
    enableProfilerOnConnection(conn);
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});

    await rawExecute('res', 'UPDATE t SET a = ?', [[1], [2]]);

    expect(logSpy.mock.calls.some((call) => String(call[0]).includes('1.2500'))).toBe(true);
    logSpy.mockRestore();
  });

});
