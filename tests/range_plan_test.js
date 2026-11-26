// Unit tests for range-plan.js (multi-operation planner). Run: node tests/range_plan_test.js
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = {};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'range-plan.js'), 'utf8'), context);
// Normalize across the vm realm boundary (arrays from another realm fail deepStrictEqual).
const plan = (input) => {
  const result = context.planCVATRangeBatch(input);
  return JSON.parse(JSON.stringify({ ...result, steps: result.steps.map((step) => ({ problem: step.problem })) }));
};

const SMOKE = 1;
const DRINK = 2;
const PHONE = 3;
let id = 0;
const tag = (frame, labelId) => ({ clientID: ++id, frame, labelId });
const frames = (low, high) => Array.from({ length: high - low + 1 }, (_, i) => low + i);

// Apply a plan to a tag list the way the bridge does: delete by clientID, then create.
function apply(tags, result) {
  const gone = new Set(result.delete.map((item) => item.clientID));
  return tags.filter((item) => !gone.has(item.clientID))
    .concat(result.create.map((item) => ({ clientID: ++id, frame: item.frame, labelId: item.labelId })));
}
const labelsOn = (tags, frame) => tags.filter((item) => item.frame === frame).map((item) => item.labelId).sort();
let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log('  ok   ' + name);
}

test('add skips frames that already have the tag and frames that cannot take one', () => {
  const tags = [tag(1, SMOKE), tag(2, DRINK)];
  const result = plan({ tags, low: 0, high: 4, addFrames: [0, 1, 2, 4], operations: [{ mode: 'add', targets: [SMOKE] }] });
  assert.deepEqual(result.create.map((item) => item.frame), [0, 2, 4]);
  assert.deepEqual(result.counts, { add: 3, replace: 0, remove: 0 });
});

test('replace keeps an existing destination and removes the source there', () => {
  const tags = [tag(0, SMOKE), tag(1, SMOKE), tag(1, PHONE)];
  const result = plan({ tags, low: 0, high: 1, operations: [{ mode: 'replace', sources: [SMOKE], targets: [PHONE] }] });
  assert.deepEqual(result.counts, { add: 0, replace: 1, remove: 1 });
  const after = apply(tags, result);
  assert.deepEqual(labelsOn(after, 0), [PHONE]);
  assert.deepEqual(labelsOn(after, 1), [PHONE]);
});

test('several operations: remove + add + replace in one plan', () => {
  const tags = [tag(0, SMOKE), tag(0, DRINK), tag(1, DRINK), tag(2, PHONE), tag(3, SMOKE)];
  const result = plan({
    tags, low: 0, high: 3, addFrames: frames(0, 3),
    operations: [
      { mode: 'remove', sources: [DRINK] },
      { mode: 'replace', sources: [PHONE], targets: [DRINK] },
      { mode: 'add', targets: [SMOKE] },
    ],
  });
  assert.equal(result.complete, true);
  const after = apply(tags, result);
  assert.deepEqual(labelsOn(after, 0), [SMOKE]);
  assert.deepEqual(labelsOn(after, 1), [SMOKE]);
  assert.deepEqual(labelsOn(after, 2), [SMOKE, DRINK]);
  assert.deepEqual(labelsOn(after, 3), [SMOKE]);
});

test('removing and adding the same tag back changes nothing on frames that had it', () => {
  const tags = [tag(0, SMOKE), tag(2, SMOKE)];
  const result = plan({
    tags, low: 0, high: 2, addFrames: frames(0, 2),
    operations: [{ mode: 'remove', sources: [SMOKE] }, { mode: 'add', targets: [SMOKE] }],
  });
  assert.deepEqual(result.delete, []);
  assert.deepEqual(result.create.map((item) => item.frame), [1]);
  assert.deepEqual(result.counts, { add: 1, replace: 0, remove: 0 });
});

test('replace then remove the destination removes both', () => {
  const tags = [tag(0, SMOKE), tag(1, PHONE)];
  const result = plan({
    tags, low: 0, high: 1,
    operations: [{ mode: 'replace', sources: [SMOKE], targets: [PHONE] }, { mode: 'remove', sources: [PHONE] }],
  });
  assert.deepEqual(result.create, []);
  assert.deepEqual(result.counts, { add: 0, replace: 0, remove: 2 });
});

test('a source removed by an earlier operation blocks Apply instead of being ignored', () => {
  const tags = [tag(0, SMOKE)];
  const result = plan({
    tags, low: 0, high: 0,
    operations: [{ mode: 'remove', sources: [SMOKE] }, { mode: 'replace', sources: [SMOKE], targets: [PHONE] }],
  });
  assert.equal(result.complete, false);
  assert.equal(result.steps[0].problem, null);
  assert.match(result.steps[1].problem, /không còn/);
});

test('missing target and same source/target are reported', () => {
  const tags = [tag(0, SMOKE)];
  assert.match(plan({ tags, low: 0, high: 0, operations: [{ mode: 'add', targets: [] }] }).steps[0].problem, /cần thêm/);
  assert.match(plan({ tags, low: 0, high: 0, operations: [{ mode: 'replace', sources: [SMOKE], targets: [SMOKE] }] })
    .steps[0].problem, /khác nhau/);
});

test('frames outside the range are never touched', () => {
  const tags = [tag(0, SMOKE), tag(5, SMOKE), tag(9, DRINK)];
  const result = plan({ tags, low: 4, high: 6, addFrames: frames(0, 9), operations: [{ mode: 'all' }, { mode: 'add', targets: [PHONE] }] });
  assert.deepEqual(result.delete.map((item) => item.frame), [5]);
  assert.deepEqual(result.create.map((item) => item.frame), [4, 5, 6]);
});

test('no duplicates even when two operations add the same tag', () => {
  const tags = [];
  const result = plan({
    tags, low: 0, high: 1, addFrames: frames(0, 1),
    operations: [{ mode: 'add', targets: [SMOKE] }, { mode: 'add', targets: [SMOKE] }],
  });
  assert.equal(result.create.length, 2);
});

test('one add operation can add several events', () => {
  const tags = [tag(0, SMOKE)];
  const result = plan({ tags, low: 0, high: 1, addFrames: frames(0, 1), operations: [{ mode: 'add', targets: [SMOKE, PHONE] }] });
  const after = apply(tags, result);
  assert.deepEqual(labelsOn(after, 0), [SMOKE, PHONE]);
  assert.deepEqual(labelsOn(after, 1), [SMOKE, PHONE]);
  assert.deepEqual(result.counts, { add: 3, replace: 0, remove: 0 });
});

test('replace needs exactly one target', () => {
  const tags = [tag(0, SMOKE)];
  assert.match(plan({ tags, low: 0, high: 0, operations: [{ mode: 'replace', sources: [SMOKE], targets: [DRINK, PHONE] }] })
    .steps[0].problem, /một event/);
});

console.log(`\n${passed} planner tests passed`);
