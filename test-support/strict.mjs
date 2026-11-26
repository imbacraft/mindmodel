// Every test runs in strict mode: a degraded path (engine/core/degrade.mjs) is an error. Each test file imports this
// first, so the flag is set before the first engine module (and its self-checks) loads. A test that asserts a
// degradation on purpose wraps that part in withDegradation().
process.env.MINDMODEL_STRICT = '1';
// Results must not depend on which Lombok jar this machine happens to cache: the hand-written Lombok rules unless a
// run sets MINDMODEL_LOMBOK itself. The delombok oracle is covered by the engine's own JUnit tests.
process.env.MINDMODEL_LOMBOK ??= 'off';
export { withDegradation } from '../engine/core/degrade.mjs';
