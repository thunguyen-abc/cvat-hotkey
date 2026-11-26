'use strict';

// Pure planner for the range editor: several operations in one dialog.
// cvat-bridge.js re-checks the resulting plan against CVAT's live data before applying it.
//
// tags:       [{ clientID, frame, labelId }] in the range, as held by CVAT in the browser
// low, high:  inclusive frame range
// addFrames:  frames that may receive a new tag (not deleted, inside the job's frame filter)
// operations: [{ mode, sources, targets }] applied top to bottom; each one sees the result
//             of the ones above it.
//   mode 'add'     adds each label in targets to every frame in addFrames that lacks it
//   mode 'replace' turns the selected source label (one) into targets[0] (exactly one);
//                  where the frame already has that label, the source tag is removed instead
//   mode 'remove'  removes the selected source labels
//   mode 'all'     removes every tag in the range
//
// An operation whose source label no longer exists after the operations above it, or that
// lacks a target, is reported as invalid and blocks Apply: conflicts are never resolved
// silently. Existing tags are never duplicated.

// The three event labels, in slot order 1/2/3. Shared by hotkeys.js (CVAT's tag slots) and
// the range editor (its three event buttons).
const CVAT_EVENT_LABELS = Object.freeze(['event_smoke', 'event_drinking', 'event_phone']);

function countCVATLabels(tags) {
  const present = new Map();
  for (const tag of tags) present.set(tag.labelId, (present.get(tag.labelId) || 0) + 1);
  return present;
}

function checkCVATOperation(op, present) {
  const sources = op.sources || [];
  const targets = op.targets || [];
  if (op.mode === 'add' && !targets.length) return 'Chọn event cần thêm.';
  if (op.mode === 'replace' && targets.length !== 1) return 'Chọn một event đích.';
  if (['replace', 'remove'].includes(op.mode)) {
    if (!sources.length) return op.mode === 'replace' ? 'Chọn tag cần đổi.' : 'Chọn tag cần xóa.';
    if (!sources.every((id) => present.has(id))) return 'Tag đã chọn không còn sau các thao tác phía trên.';
  }
  if (op.mode === 'replace' && sources.includes(targets[0])) return 'Tag nguồn và tag đích phải khác nhau.';
  return null;
}

function projectCVATOperation(tags, op, addFrames, temporaryId) {
  const selected = new Set(op.sources || []);
  if (op.mode === 'add') {
    let result = tags;
    for (const labelId of op.targets) {
      const hasLabel = new Set(result.filter((tag) => tag.labelId === labelId).map((tag) => tag.frame));
      result = result.concat(addFrames.filter((frame) => !hasLabel.has(frame))
        .map((frame) => ({ clientID: temporaryId(), frame, labelId })));
    }
    return result;
  }
  const targetId = op.targets?.[0] ?? null;
  const hasTarget = new Set(tags.filter((tag) => tag.labelId === targetId).map((tag) => tag.frame));
  const result = [];
  for (const tag of tags) {
    if (op.mode === 'all' || (op.mode === 'remove' && selected.has(tag.labelId))) continue;
    if (op.mode === 'replace' && selected.has(tag.labelId)) {
      if (hasTarget.has(tag.frame)) continue;
      hasTarget.add(tag.frame);
      result.push({ ...tag, labelId: targetId });  // same tag, new label: counted as "Đổi"
      continue;
    }
    result.push(tag);
  }
  return result;
}

// Smallest change from original to desired. A tag whose (frame, label) pair already exists
// in the original is kept, so removing and re-adding the same tag is not a change.
function diffCVATRangeTags(original, desired) {
  const byId = new Map(original.map((tag) => [tag.clientID, tag]));
  const available = new Map(original.map((tag) => [tag.clientID, tag]));
  const pending = [];
  for (const tag of desired) {
    if (byId.get(tag.clientID)?.labelId === tag.labelId) available.delete(tag.clientID);
    else pending.push(tag);
  }
  const byPair = new Map();
  for (const tag of available.values()) {
    const key = tag.frame + '/' + tag.labelId;
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push(tag.clientID);
  }
  const create = [];
  const relabeled = [];
  for (const tag of pending) {
    const reused = byPair.get(tag.frame + '/' + tag.labelId)?.pop();
    if (reused !== undefined) {
      available.delete(reused);
      continue;
    }
    create.push({ frame: tag.frame, labelId: tag.labelId });
    if (byId.has(tag.clientID)) relabeled.push(tag.clientID);
  }
  const remove = [...available.values()].map((tag) => ({ clientID: tag.clientID, frame: tag.frame }));
  const replace = relabeled.filter((clientID) => available.has(clientID)).length;
  return {
    create,
    delete: remove,
    counts: { add: create.length - replace, replace, remove: remove.length - replace },
  };
}

function planCVATRangeBatch({ tags, low, high, addFrames = [], operations }) {
  const original = tags
    .filter((tag) => tag.frame >= low && tag.frame <= high)
    .sort((a, b) => a.frame - b.frame || a.clientID - b.clientID);
  const frames = addFrames.filter((frame) => frame >= low && frame <= high);
  let next = -1;
  const temporaryId = () => next--;
  let desired = original;
  const steps = [];
  for (const op of operations) {
    const present = countCVATLabels(desired);
    const problem = checkCVATOperation(op, present);
    steps.push({ present, problem });
    if (!problem) desired = projectCVATOperation(desired, op, frames, temporaryId);
  }
  return { ...diffCVATRangeTags(original, desired), desired, steps, complete: steps.every((step) => !step.problem) };
}
