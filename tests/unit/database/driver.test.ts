import { describe, test, expect } from 'bun:test';
import { countPlaceholders, createPool, normalizeResult, readInsertId, translateSql } from 'database/driver';

describe('PostgreSQL SQL adapter', () => {
  test('counts placeholders while ignoring question marks in literals and comments', () => {
    expect(countPlaceholders("SELECT '?' AS literal, ? AS value -- ?\n/* ? */")).toBe(1);
  });

  test('counts placeholders in escaped quoted text and identifiers', () => {
    const backtick = String.fromCharCode(96);
    const sql = "SELECT 'don''t ?' AS literal, \"quoted ?\" AS quoted, " + backtick + "tab?" + backtick + " AS identifier, ? AS bound";
    expect(countPlaceholders(sql)).toBe(1);
  });

  test('counts identifier placeholders for argument validation, then rejects them during translation', () => {
    expect(countPlaceholders('SELECT * FROM ??')).toBe(1);
    expect(() => translateSql('SELECT * FROM ??', ['users'])).toThrow('identifier placeholders');
  });

  test('counts placeholders in PostgreSQL dollar-quoted bodies', () => {
    expect(countPlaceholders('SELECT $body$ ? literal $body$, ?')).toBe(1);
    expect(countPlaceholders('SELECT $$ ? literal $$, ?')).toBe(1);
  });

  test('converts placeholders without changing question marks inside literals or comments', () => {
    const result = translateSql("SELECT '?' AS literal, ? AS value -- ?\n", [12]);
    expect(result.sql).toBe("SELECT '?' AS literal, $1 AS value -- ?\n");
    expect(result.values).toEqual([12]);
  });

  test('converts MySQL identifier quotes', () => {
    const backtick = String.fromCharCode(96);
    const result = translateSql('SELECT * FROM ' + backtick + 'users' + backtick + ' WHERE id = ?', [5]);
    expect(result.sql).toBe('SELECT * FROM "users" WHERE id = $1');
  });

  test('preserves line and block comments while translating only real placeholders', () => {
    const result = translateSql('SELECT ? /* ? in block */ -- ? in line\n, ?', [1, 2]);
    expect(result.sql).toBe('SELECT $1 /* ? in block */ -- ? in line\n, $2');
  });

  test('handles escaped and doubled backticks in MySQL identifiers', () => {
    const backtick = String.fromCharCode(96);
    const result = translateSql('SELECT ' + backtick + 'tab' + backtick + backtick + 'name' + backtick + ', ' +
      backtick + 'escaped\\"quote' + backtick);
    expect(result.sql).toBe('SELECT "tab""name", "escaped""quote"');
  });

  test('translates MySQL backslash escapes inside double-quoted strings', () => {
    const result = translateSql(String.raw`SELECT "a\0b\bc\nd\re\tf\Zg\?h"`);
    expect(result.sql).toBe(String.raw`SELECT 'a\\0b\\bc\\nd\\re\\tf\\Zg?h'`);
  });

  test('handles doubled double quotes in a MySQL string literal', () => {
    const result = translateSql('SELECT "a""b"');
    expect(result.sql).toBe('SELECT \'a"b\'');
  });

  test('preserves backslash escapes and doubled apostrophes in single-quoted strings', () => {
    const result = translateSql(String.raw`SELECT 'a\?b''c', ?`, [9]);
    expect(result.sql).toBe(String.raw`SELECT 'a?b''c', $1`);
  });

  test('converts MySQL double-quoted string literals to PostgreSQL string literals', () => {
    const result = translateSql('SELECT * FROM jobs ORDER BY name <>  "unemployed", name');
    expect(result.sql).toBe("SELECT * FROM jobs ORDER BY name <>  'unemployed', name");
    expect(result.values).toEqual([]);
  });

  test('escapes apostrophes and ignores placeholders inside double-quoted strings', () => {
    const result = translateSql(`SELECT "it's ? fine" AS label, ? AS value`, [7]);
    expect(result.sql).toBe("SELECT 'it''s ? fine' AS label, $1 AS value");
    expect(result.values).toEqual([7]);
  });

  test('maps INSERT IGNORE and returns the generated row', () => {
    const backtick = String.fromCharCode(96);
    const result = translateSql('INSERT IGNORE INTO ' + backtick + 'users' + backtick + ' (name) VALUES (?)', ['sam']);
    expect(result.sql).toBe('INSERT INTO "users" (name) VALUES ($1) ON CONFLICT DO NOTHING RETURNING *');
  });

  test('adds RETURNING to ordinary inserts so insertId can be recovered', () => {
    const result = translateSql('INSERT INTO players (name) VALUES (?)', ['sam']);
    expect(result.sql).toBe('INSERT INTO players (name) VALUES ($1) RETURNING *');
  });

  test('preserves an explicit RETURNING clause and does not duplicate it', () => {
    const result = translateSql('INSERT INTO players (name) VALUES (?) RETURNING id', ['sam']);
    expect(result.sql).toBe('INSERT INTO players (name) VALUES ($1) RETURNING id');
  });

  test('preserves a trailing semicolon after the RETURNING clause', () => {
    const result = translateSql('INSERT INTO players (name) VALUES (?);', ['sam']);
    expect(result.sql).toBe('INSERT INTO players (name) VALUES ($1) RETURNING *;');
  });

  test('does not duplicate an existing ON CONFLICT clause', () => {
    const result = translateSql('INSERT IGNORE INTO t (id) VALUES (?) ON CONFLICT (id) DO NOTHING', [1]);
    expect(result.sql).toBe('INSERT INTO t (id) VALUES ($1) ON CONFLICT (id) DO NOTHING RETURNING *');
  });

  test('rejects MySQL duplicate-key syntax instead of sending invalid SQL', () => {
    expect(() => translateSql('INSERT INTO t (id) VALUES (?) ON DUPLICATE KEY UPDATE id = VALUES(id)', [1]))
      .toThrow('ON DUPLICATE KEY UPDATE');
  });

  test('rejects a placeholder count mismatch', () => {
    expect(() => translateSql('SELECT ?', [])).toThrow('placeholder count mismatch');
  });

  test('converts PostgreSQL dollar-quoted function bodies without changing their placeholders', () => {
    const sql = 'SELECT $$ ? literal $$ AS body, ? AS value';
    const result = translateSql(sql, [9]);
    expect(result.sql).toBe('SELECT $$ ? literal $$ AS body, $1 AS value');
  });

  test('extracts numeric and sequence-style generated ids', () => {
    expect(readInsertId([{ id: 27 }])).toBe(27);
    expect(readInsertId([{ player_id: '28' }])).toBe(28);
    expect(readInsertId([{ id: '9007199254740993' }])).toBe('9007199254740993');
  });

  test('returns null if an INSERT response has no id-like field', () => {
    expect(readInsertId([{ name: 'player' }])).toBeNull();
    expect(readInsertId([])).toBeNull();
  });

  test('closes the native PostgreSQL pool', async () => {
    const pool = createPool({} as any);
    await expect(pool.end()).resolves.toBeUndefined();
  });

  test('normalizes PostgreSQL SELECT and write results to the oxmysql result shape', () => {
    expect(normalizeResult({ command: 'SELECT', rows: [{ id: 1 }], rowCount: 1 } as any)).toEqual([{ id: 1 }]);
    expect(normalizeResult({ command: 'UPDATE', rows: [], rowCount: 3 } as any)).toMatchObject({
      affectedRows: 3,
      changedRows: 3,
      command: 'UPDATE',
    });
    expect(normalizeResult({ command: 'INSERT', rows: [{ id: 4 }], rowCount: 1 } as any)).toMatchObject({
      affectedRows: 1,
      insertId: 4,
    });
    expect(normalizeResult({ command: 'DELETE', rows: [], rowCount: null } as any)).toMatchObject({
      affectedRows: 0,
      changedRows: 0,
      command: 'DELETE',
    });
  });
});
