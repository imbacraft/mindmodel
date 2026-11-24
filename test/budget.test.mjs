// The schema and the validator must agree about how big a map may be. They drifted once: concepts allowed 6 while
// state.owners still capped at 5, so a legal map with six concepts could not validate.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const schema = JSON.parse(fs.readFileSync(path.join(REPO, 'schema', 'mindmodel.schema.json'), 'utf8'));
const validateSource = fs.readFileSync(path.join(REPO, 'engine', 'validate.mjs'), 'utf8');

const budget = (name) => +new RegExp(`${name}: (\\d+)`).exec(validateSource)?.[1];

test('state.owners admits one row per concept the schema and validator allow', () => {
  const concepts = schema.properties.concepts.maxItems;
  const owners = schema.properties.state.properties.owners.maxItems;
  assert.ok(owners >= concepts, `owners cap ${owners} must be at least the concept cap ${concepts}`);
});

test('the schema concept cap and the validator budget are the same number', () => {
  assert.equal(schema.properties.concepts.maxItems, budget('concepts'), 'schema and BUDGET disagree on concepts');
});
