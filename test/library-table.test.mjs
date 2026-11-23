// The engine's library table is data inside the jar, generated from the catalogs. This test keeps the two honest: an
// edited catalog that is not regenerated fails here rather than surfacing as a silently unresolved chain at scan time.
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { serialised, TABLE, table } from '../engine/tools/library-table.mjs';

test('library table: the resource in the jar matches the catalogs', () => {
  assert.equal(readFileSync(TABLE, 'utf8'), serialised(), 'run: node engine/tools/library-table.mjs');
});

test('library table: the facts a chain needs are present and normalised', () => {
  const flat = table().types;
  assert.equal(flat['jakarta.jms.JMSContext'].createProducer, 'jakarta.jms.JMSProducer');
  assert.equal(flat['jakarta.jms.JMSProducer'].send, 'jakarta.jms.JMSProducer');
  assert.equal(flat['java.util.stream.Stream'].filter, 'java.util.stream.Stream');
  // A type variable is not a type: `List.get` returns E, so a chain cannot continue through it.
  assert.equal(flat['java.util.List']?.get, undefined);
  assert.equal(flat['java.util.Collection']?.add, undefined, 'a boolean return cannot carry a chain');
});
