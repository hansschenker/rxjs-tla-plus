import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyResult, decodeSearchTrace } from '../scripts/check-models.mjs';

test('an expected counterexample requires its named invariant and exit 12', () => {
  const expected = { id: 'negative-control', expect: 'violation', invariant: 'FreshEmission' };
  assert.doesNotThrow(() => classifyResult({
    status: 12, stdout: 'Error: Invariant FreshEmission is violated.',
  }, expected));
  for (const result of [
    { status: 75, stdout: 'Successor state is not completely specified.' },
    { status: 12, stdout: 'Error: Invariant TypeOK is violated.' },
    { status: 0, stdout: 'Model checking completed. No error has been found.' },
    { status: null, error: new Error('java is unavailable') },
  ]) assert.throws(() => classifyResult(result, expected));
});

test('a successful check requires both a zero exit and completion evidence', () => {
  const expected = { id: 'positive-control', expect: 'pass' };
  assert.doesNotThrow(() => classifyResult({
    status: 0, stdout: 'Model checking completed. No error has been found.',
  }, expected));
  assert.throws(() => classifyResult({ status: 0, stdout: 'Stopped early' }, expected));
  assert.throws(() => classifyResult({
    status: 1, stdout: 'Model checking completed. No error has been found.',
  }, expected));
});

test('the trace decoder preserves whole states and rejects incomplete evidence', () => {
  const state = (number, event, bad) => 'State ' + number + ': <step>\n'
    + '/\\ pending = 0\n/\\ lastEvent = "' + event + '"\n/\\ now = 4\n'
    + '/\\ lastId = 1\n/\\ active = 0\n/\\ badEmission = ' + bad
    + '\n/\\ latestRaw = 2\n';
  const text = state(1, 'Init', 'FALSE') + '\n' + state(2, 'Result', 'TRUE')
    + '\n10 states generated, 8 distinct states found, 0 states left on queue.\n';
  const decoded = decodeSearchTrace(text);
  assert.equal(decoded.length, 2);
  assert.equal(decoded[1].at, 4);
  assert.equal(decoded[1].badEmission, true);
  assert.throws(() => decodeSearchTrace(text.replace('/\\ now = 4\n', '')));
});
