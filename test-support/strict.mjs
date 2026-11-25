// Every test runs in strict mode: a degraded path (engine/core/degrade.mjs) is an error. Each test file imports this
// first, so the flag is set before the first engine module (and its self-checks) loads. A test that asserts a
// degradation on purpose wraps that part in withDegradation().
process.env.MINDMODEL_STRICT = '1';
export { withDegradation } from '../engine/core/degrade.mjs';
