import { describe, it, expect } from 'vitest'
import { findDestructive } from './check-migrations-additive'

describe('findDestructive', () => {
  it('passes additive migrations (CREATE TABLE / ADD COLUMN)', () => {
    expect(findDestructive('CREATE TABLE foo (id INTEGER PRIMARY KEY);')).toEqual([])
    expect(findDestructive('ALTER TABLE foo ADD COLUMN bar TEXT;')).toEqual([])
    expect(findDestructive('CREATE INDEX idx ON foo(bar);')).toEqual([])
  })

  it('flags DROP TABLE', () => {
    expect(findDestructive('DROP TABLE foo;')).toContain('DROP TABLE')
  })

  it('flags column drops and renames', () => {
    expect(findDestructive('ALTER TABLE foo DROP COLUMN bar;')).toContain('DROP COLUMN')
    expect(findDestructive('ALTER TABLE foo RENAME TO baz;')).toContain('ALTER ... RENAME')
  })

  it('reports a single code per statement (no overlapping ALTER…DROP duplicate)', () => {
    // ALTER TABLE ... DROP COLUMN matches both the DROP COLUMN and the
    // broader ALTER ... DROP probes; only the most-specific is kept.
    expect(findDestructive('ALTER TABLE foo DROP COLUMN bar;')).toEqual(['DROP COLUMN'])
  })

  it('flags DELETE FROM', () => {
    expect(findDestructive('DELETE FROM foo WHERE id = 1;')).toContain('DELETE FROM')
  })

  it('ignores destructive keywords inside comments', () => {
    expect(findDestructive('-- DROP TABLE foo (described, not executed)\nCREATE TABLE foo (id INT);')).toEqual([])
    expect(findDestructive('/* DROP COLUMN bar */ CREATE TABLE foo (id INT);')).toEqual([])
  })

  it('respects the reviewed-destructive opt-in marker', () => {
    const sql = '-- destructive: reviewed — post-backfill drop\nALTER TABLE foo DROP COLUMN bar;'
    expect(findDestructive(sql)).toEqual([])
  })

  it('does not false-positive on column names containing "drop"', () => {
    // A column literally named e.g. `backdrop` shouldn't trip the
    // word-boundaried DROP probe.
    expect(findDestructive('ALTER TABLE foo ADD COLUMN backdrop TEXT;')).toEqual([])
  })
})
