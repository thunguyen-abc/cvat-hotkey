'use strict';

// Pure planner used by the range editor. cvat-bridge.js re-checks the resulting plan
// against CVAT's live data before applying it.
//
// tags:      [{ clientID, frame, labelId }] as held by CVAT in the browser
// low, high: inclusive frame range
// addFrames: frames that may receive a new tag (not deleted, inside the job's frame filter)
// mode:      'add' | 'replace' | 'remove' | 'all'
// sources:   label ids selected for replace/remove
// targetId:  label id to add, or to replace with
//
// Tags are visited in (frame, clientID) order, so the plan is deterministic.
// Existing destination tags are never removed or duplicated.
function planCVATRangeEdit({ tags, low, high, addFrames = [], mode, sources = [], targetId = null }) {
  const inRange = tags
    .filter((tag) => tag.frame >= low && tag.frame <= high)
    .sort((a, b) => a.frame - b.frame || a.clientID - b.clientID);
  const hasTarget = new Set(inRange.filter((tag) => tag.labelId === targetId).map((tag) => tag.frame));
  const selected = new Set(sources);
  const plan = { create: [], delete: [], counts: { add: 0, replace: 0, remove: 0 } };

  if (mode === 'add') {
    if (targetId === null) return plan;
    for (const frame of addFrames) {
      if (frame < low || frame > high || hasTarget.has(frame)) continue;
      plan.create.push(frame);
      hasTarget.add(frame);
    }
    plan.counts.add = plan.create.length;
    return plan;
  }

  for (const tag of inRange) {
    const chosen = selected.has(tag.labelId);
    if (mode === 'all' || (mode === 'remove' && chosen)) {
      plan.delete.push({ clientID: tag.clientID, frame: tag.frame });
      plan.counts.remove += 1;
    } else if (mode === 'replace' && targetId !== null && chosen && tag.labelId !== targetId) {
      plan.delete.push({ clientID: tag.clientID, frame: tag.frame });
      if (hasTarget.has(tag.frame)) {
        plan.counts.remove += 1;
      } else {
        plan.create.push(tag.frame);
        hasTarget.add(tag.frame);
        plan.counts.replace += 1;
      }
    }
  }
  return plan;
}
