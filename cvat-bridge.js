// Runs in the page's MAIN world. Registers as a CVAT UI plugin (window.cvatUI, CVAT >= 2.x)
// to reach the job that CVAT already holds in memory. Every operation here works on the
// browser copy of the annotations: nothing is sent to the server. CVAT's own save
// (autosave, Save, Finish the job) later uploads only the objects that changed.
//
// The content scripts talk to it through DOM events carrying JSON strings.
// Requires CVAT 2.56-compatible internals; see docs/development.md.
(() => {
  'use strict';

  const REQUEST = 'cvat-event-hotkeys:request';
  const RESPONSE = 'cvat-event-hotkeys:response';
  const READY = 'cvat-event-hotkeys:ready';
  const CHANGED = 'cvat-event-hotkeys:tags-changed';
  const editHistory = new WeakMap();
  let plugin = null;

  function register() {
    if (plugin) return true;
    const ui = window.cvatUI;
    if (!ui || typeof ui.registerComponent !== 'function') return false;
    ui.registerComponent((context) => {
      plugin = context;
      const unsubscribe = watchAnnotations(context.store);
      return { name: 'CVAT Event Hotkeys', destructor: () => { unsubscribe(); plugin = null; } };
    });
    document.dispatchEvent(new CustomEvent(READY));
    return Boolean(plugin);
  }

  if (!register()) {
    // window.cvatUI is defined once the React app mounts. Polling is local only.
    const timer = setInterval(() => { if (register()) clearInterval(timer); }, 300);
    setTimeout(() => clearInterval(timer), 120000);
    document.addEventListener('plugins.ready', () => { if (register()) clearInterval(timer); });
  }

  class BridgeError extends Error {}
  const fail = (message) => { throw new BridgeError(message); };
  const yieldToBrowser = () => new Promise((resolve) => setTimeout(resolve, 0));

  function context(jobId) {
    if (!plugin) fail('CVAT chưa sẵn sàng cho extension. Đợi job tải xong rồi thử lại.');
    const state = plugin.store.getState();
    const job = state.annotation?.job?.instance;
    if (!job) fail('Chưa mở job.');
    if (jobId !== undefined && job.id !== jobId) fail('Job đã thay đổi. Hãy thử lại.');
    return { state, job };
  }

  function assertIdle(state) {
    if (state.annotation?.annotations?.saving?.uploading) fail('CVAT đang lưu. Đợi lưu xong rồi thử lại.');
    if (state.annotation?.player?.frame?.fetching) fail('CVAT đang tải frame. Đợi tải xong rồi thử lại.');
  }

  function historyStatus(job) {
    const history = editHistory.get(job);
    return { undo: Boolean(history?.undo.length), redo: Boolean(history?.redo.length) };
  }

  function integer(value, name) {
    if (!Number.isInteger(value)) fail(`Tham số ${name} không hợp lệ.`);
    return value;
  }

  // Whole-job tag list, used by Clear All Tags and as a statistics fallback.
  async function readAllTags(job) {
    const data = await job.annotations.export();
    return (data.tags || []).map((tag) => ({ clientID: tag.clientID, frame: tag.frame, labelId: tag.label_id }));
  }

  // Whole-job counts from CVAT's in-memory statistics, including unsaved changes.
  async function countTags(job) {
    const labels = tagLabels(job);
    try {
      const stats = await job.annotations.statistics();
      const count = stats?.total?.tag;
      const labelStats = stats?.label;
      if (Number.isInteger(count) && labelStats && labels.every(({ name }) => Number.isInteger(labelStats[name]?.tag))) {
        return { count, byLabel: Object.fromEntries(labels.map(({ name }) => [name, labelStats[name].tag])) };
      }
    } catch { /* Fall back to the export. */ }
    const tags = await readAllTags(job);
    const counts = new Map();
    for (const { labelId } of tags) counts.set(labelId, (counts.get(labelId) || 0) + 1);
    return { count: tags.length, byLabel: Object.fromEntries(labels.map(({ id, name }) => [name, counts.get(id) || 0])) };
  }

  // CVAT replaces annotation.annotations.history after every annotation action (tag
  // hotkey, Undo/Redo, our own Apply), never on frame navigation. When it or the job
  // changes, the content scripts get the job's tag count, so the Clear All Tags button and
  // the range panel stay current without polling. The store check is a reference compare.
  function watchAnnotations(store) {
    let seen = {};
    let timer = 0;
    const announce = async (snapshot) => {
      const { job } = snapshot;
      try {
        const counts = await countTags(job);
        if (seen !== snapshot) return;
        document.dispatchEvent(new CustomEvent(CHANGED, {
          detail: JSON.stringify({ jobId: job.id, ...counts, editHistory: historyStatus(job) }),
        }));
      } catch { /* The next change announces again. */ }
    };
    const check = () => {
      const annotation = store.getState().annotation;
      const job = annotation?.job?.instance;
      const history = annotation?.annotations?.history;
      if (job === seen.job && history === seen.history) return;
      seen = { job, history };
      clearTimeout(timer);
      const snapshot = seen;
      if (job) timer = setTimeout(() => { void announce(snapshot); }, 250);
    };
    const unsubscribe = typeof store.subscribe === 'function' ? store.subscribe(check) : null;
    check();
    return () => { clearTimeout(timer); if (typeof unsubscribe === 'function') unsubscribe(); };
  }

  // Per-frame cache for the range editor: frame -> { tags, valid }. Only frames inside a
  // Start-End range are ever read; reopening an overlapping range reads only the frames
  // not cached yet. CVAT's undo history (in the store) changes with every annotation
  // action but not with frame navigation or saving, so it is the cache key. The history
  // is capped (32 entries, no ids), so a stale hit is possible: Apply therefore re-reads
  // its range from the live collection and refuses a changed fingerprint.
  let cache = null;
  const historyKey = () => JSON.stringify(plugin.store.getState().annotation?.annotations?.history ?? null);

  function frameCache(job) {
    const key = historyKey();
    if (!cache || cache.jobId !== job.id || cache.key !== key) cache = { jobId: job.id, key, frames: new Map() };
    return cache.frames;
  }

  // One frame from CVAT's in-memory collection: its tags, and whether it can take a new
  // tag (not deleted, inside the job's frame filter; from cached frame meta). No request.
  async function readFrame(job, frame) {
    const tagType = plugin.core.enums.ObjectType.TAG;
    const states = (await job.annotations.get(frame, false, [])).filter((state) => state.objectType === tagType);
    const valid = (await job.frames.search({ notDeleted: true }, frame, frame)) === frame;
    const tags = states.map((state) => ({ clientID: state.clientID, frame, labelId: state.label.id }));
    return { states, entry: { tags, valid } };
  }

  // Reads [low, high] only. With live = true every frame is re-read and its ObjectStates
  // are kept for applying the plan; otherwise cached frames are reused.
  async function readRange(job, low, high, live = false) {
    const frames = frameCache(job);
    const tags = [];
    const addFrames = [];
    const states = new Map();
    const from = Math.max(low, job.startFrame);
    const to = Math.min(high, job.stopFrame);
    let read = 0;
    for (let frame = from; frame <= to; frame += 1) {
      let entry = live ? null : frames.get(frame);
      if (!entry) {
        const result = await readFrame(job, frame);
        entry = result.entry;
        frames.set(frame, entry);
        states.set(frame, result.states);
        read += 1;
        if (read % 200 === 0) await yieldToBrowser();
      }
      tags.push(...entry.tags);
      if (entry.valid) addFrames.push(frame);
    }
    return { tags, addFrames, states, read };
  }

  // Fingerprint of the tags in a range. Apply is refused when it changed after the preview.
  function rangeKey(tags) {
    return JSON.stringify(tags.map((tag) => [tag.clientID, tag.frame, tag.labelId]).sort((a, b) => a[0] - b[0]));
  }

  function snapshotOf(job, range) {
    const key = JSON.stringify([rangeKey(range.tags), range.addFrames]);
    return { labels: tagLabels(job), tags: range.tags, addFrames: range.addFrames, key, read: range.read };
  }

  function clearSummary(tags) {
    return { count: tags.length, frames: new Set(tags.map((tag) => tag.frame)).size, key: rangeKey(tags) };
  }

  function tagLabels(job) {
    return job.labels.filter((label) => ['any', 'tag'].includes(label.type))
      .map((label) => ({ id: label.id, name: label.name }));
  }

  function saveInfo(job) {
    const workspace = plugin.store.getState().settings?.workspace || {};
    return {
      unsaved: Boolean(job.annotations.hasUnsavedChanges()),
      autoSave: Boolean(workspace.autoSave),
      interval: Number(workspace.autoSaveInterval) || 0,
    };
  }

  // Clear All Tags remains separate from range Apply history.
  async function deleteJobTags(job, tags) {
    const tagType = plugin.core.enums.ObjectType.TAG;
    const byFrame = new Map();
    for (const { clientID, frame } of tags) {
      if (!byFrame.has(frame)) byFrame.set(frame, new Set());
      byFrame.get(frame).add(clientID);
    }
    let removed = 0;
    let visited = 0;
    for (const [frame, ids] of byFrame) {
      for (const state of await job.annotations.get(frame, false, [])) {
        if (state.objectType === tagType && ids.has(state.clientID) && await state.delete(frame, true)) removed += 1;
      }
      visited += 1;
      if (visited % 100 === 0) await yieldToBrowser();
    }
    return removed;
  }

  const tagPair = ({ frame, label_id }) => frame + '/' + label_id;
  const tagValue = ({ frame, label_id, source, attributes }) => JSON.stringify([frame, label_id, source, attributes]);
  const compareTags = (tags) => JSON.stringify(tags.map(tagValue).sort());
  const serializeTag = (state) => ({
    clientID: state.clientID,
    frame: state.frame,
    label_id: state.label.id,
    group: 0,
    source: state.source ?? 'manual',
    attributes: Object.entries(state.attributes ?? {}).map(([id, value]) => ({ spec_id: Number(id), value })),
  });

  async function commitTags(job, added, removed) {
    const frame = context(job.id).state.annotation.player.frame.number;
    await job.annotations.commit(
      { tags: added.map(({ clientID, ...tag }) => tag), shapes: [], tracks: [] },
      { tags: removed, shapes: [], tracks: [] },
      frame,
    );
  }

  async function applyRange({ jobId, low, high, key, create, remove }) {
    const { state, job } = context(jobId);
    assertIdle(state);
    const revision = state.annotation.annotations.history;
    integer(low, 'low');
    integer(high, 'high');
    const live = await readRange(job, low, high, true);
    const latest = context(jobId).state;
    assertIdle(latest);
    const snapshot = snapshotOf(job, live);
    if (snapshot.key !== key || revision !== latest.annotation.annotations.history) {
      return { stale: true, snapshot };
    }
    if (!Array.isArray(create) || !Array.isArray(remove)) fail('Kế hoạch không hợp lệ.');
    const liveTags = new Map(live.tags.map((tag) => [tag.clientID, tag]));
    const removing = new Set(remove);
    if (removing.size !== remove.length) fail('Kế hoạch xóa tag bị trùng.');
    const deleting = remove.map((clientID) => liveTags.get(clientID) ?? fail('Tag cần xóa không còn trong khoảng.'));
    const labels = new Map(job.labels.filter((label) => ['any', 'tag'].includes(label.type)).map((label) => [label.id, label]));
    const kept = new Set(live.tags.filter((tag) => !removing.has(tag.clientID)).map((tag) => tag.frame + '/' + tag.labelId));
    const added = create.map(({ frame, labelId }) => {
      const label = labels.get(labelId) ?? fail('Không tìm thấy tag đích trong job.');
      const pair = frame + '/' + labelId;
      if (!Number.isInteger(frame) || frame < Math.max(low, job.startFrame) ||
          frame > Math.min(high, job.stopFrame) || kept.has(pair)) fail('Kế hoạch tạo tag không hợp lệ.');
      kept.add(pair);
      return {
        frame, label_id: labelId, group: 0, source: 'manual',
        attributes: (label.attributes ?? []).map(({ id, defaultValue }) => ({ spec_id: id, value: defaultValue }))
          .sort((a, b) => a.spec_id - b.spec_id),
      };
    });
    const result = { removed: deleting.length, created: added.length };
    if (!deleting.length && !added.length) return { ...result, save: saveInfo(job) };

    const frames = new Set([...deleting.map((tag) => tag.frame), ...added.map((tag) => tag.frame)]);
    const pairs = new Set([...deleting.map((tag) => tag.frame + '/' + tag.labelId), ...added.map(tagPair)]);
    const before = [...frames].flatMap((frame) => live.states.get(frame).map(serializeTag)).filter((tag) => pairs.has(tagPair(tag)));
    const after = [...before.filter((tag) => !removing.has(tag.clientID)), ...added];
    const cached = cache.frames;
    await commitTags(job, added, before.filter((tag) => removing.has(tag.clientID)));
    const history = editHistory.get(job) ?? { undo: [], redo: [] };
    history.undo.push({ before, after, frames, pairs });
    history.redo = [];
    editHistory.set(job, history);
    await refresh(job);

    // Keep untouched cached frames in the active range and re-read the changed ones.
    const entries = frameCache(job);
    for (const [frame, entry] of cached) {
      if (frame >= low && frame <= high && !frames.has(frame)) entries.set(frame, entry);
    }
    let read = 0;
    for (const frame of frames) {
      entries.set(frame, (await readFrame(job, frame)).entry);
      if (++read % 200 === 0) await yieldToBrowser();
    }
    return { ...result, save: saveInfo(job) };
  }

  // Replay the extension's own tag changes. Identity can change when an earlier edit is
  // undone, so match serialized tag values within the affected frame/label pairs.
  async function replayRangeEdit({ jobId, direction }) {
    const { state, job } = context(jobId);
    assertIdle(state);
    const revision = state.annotation.annotations.history;
    if (!['undo', 'redo'].includes(direction)) fail('Thao tác lịch sử không hợp lệ.');
    const history = editHistory.get(job);
    const entry = history?.[direction].at(-1);
    if (!entry) fail('Chưa có thao tác Apply để ' + direction + '.');
    const undo = direction === 'undo';
    const expected = undo ? entry.after : entry.before;
    const desired = undo ? entry.before : entry.after;
    const current = [];
    const valid = new Set();
    let read = 0;
    for (const frame of entry.frames) {
      const result = await readFrame(job, frame);
      if (result.entry.valid) valid.add(frame);
      current.push(...result.states.map(serializeTag).filter((tag) => entry.pairs.has(tagPair(tag))));
      if (++read % 200 === 0) await yieldToBrowser();
    }
    const latest = context(jobId).state;
    assertIdle(latest);
    if (revision !== latest.annotation.annotations.history ||
        compareTags(current) !== compareTags(expected) || desired.some((tag) => !valid.has(tag.frame))) {
      fail('Tag hoặc frame liên quan đã thay đổi. Không thể ' + direction + ' thao tác Apply này.');
    }

    const matching = new Map();
    for (const tag of current) {
      const key = tagValue(tag);
      if (!matching.has(key)) matching.set(key, []);
      matching.get(key).push(tag);
    }
    const added = desired.filter((tag) => !matching.get(tagValue(tag))?.pop());
    const removed = [...matching.values()].flat();
    await commitTags(job, added, removed);
    history[direction].pop();
    history[undo ? 'redo' : 'undo'].push(entry);
    cache = null;
    await refresh(job);
    return { editHistory: historyStatus(job), save: saveInfo(job) };
  }

  let rangeEditBusy = false;
  async function runRangeEdit(edit) {
    if (rangeEditBusy) fail('Một thao tác chỉnh tag đang chạy.');
    rangeEditBusy = true;
    try {
      return await edit();
    } finally {
      rangeEditBusy = false;
    }
  }

  // Show the changed collection on the current frame. This is what CVAT's own
  // fetchAnnotationsAsync does after the tag sidebar creates a tag. Do not use
  // changeFrameAsync on the same frame: it sets canvas.ready = false, and the canvas only
  // confirms readiness after a new image, so CVAT would keep showing "loading".
  async function refresh(job) {
    const { annotation, settings } = plugin.store.getState();
    const frame = annotation.player.frame.number;
    const filters = annotation.annotations.filters || [];
    const showAll = Boolean(settings?.workspace?.showAllInterpolationTracks);
    const states = await job.annotations.get(frame, showAll, filters);
    const truth = annotation.job?.groundTruthInfo;
    if (settings?.shapes?.showGroundTruth && truth?.groundTruthInstance && job.type !== 'ground_truth') {
      const real = truth.validationLayout ? await truth.validationLayout.getRealFrame(frame) : frame;
      if (real !== null) states.push(...await truth.groundTruthInstance.annotations.get(real, showAll, filters));
    }
    const tagType = plugin.core.enums.ObjectType.TAG;
    const z = states.filter((item) => item.objectType !== tagType).map((item) => item.zOrder);
    plugin.dispatch({
      type: 'FETCH_ANNOTATIONS_SUCCESS',
      payload: {
        states, history: await job.actions.get(),
        minZ: z.length ? Math.min(...z) : 0, maxZ: z.length ? Math.max(...z) : 0,
      },
    });
  }

  const methods = {
    async ping() {
      return { ready: Boolean(plugin) };
    },

    async session() {
      const { state, job } = context();
      const user = state.auth?.user;
      return {
        user: user ? { id: user.id, username: user.username } : null,
        job: { id: job.id, taskId: job.taskId, state: job.state, assigneeId: job.assignee?.id ?? null },
        saving: Boolean(state.annotation.annotations.saving?.uploading),
      };
    },

    async rangeSnapshot({ jobId, low, high, wholeJob = false }) {
      const { job } = context(jobId);
      const from = integer(wholeJob ? job.startFrame : low, 'low');
      const to = integer(wholeJob ? job.stopFrame : high, 'high');
      return { ...snapshotOf(job, await readRange(job, from, to)), low: from, high: to };
    },

    // The content script plans all operations from the snapshot (range-plan.js) and sends
    // the final difference: tags to remove (clientIDs) and tags to create ({ frame, labelId }),
    // with the snapshot key. The range is re-read live and the whole plan is re-checked
    // before anything changes; then it is applied in one go.
    async applyRange({ jobId, low, high, key, create, remove }) {
      return runRangeEdit(() => applyRange({ jobId, low, high, key, create, remove }));
    },

    async replayRangeEdit(params) {
      return runRangeEdit(() => replayRangeEdit(params));
    },

    // Complete & Next step 1: is CVAT saving, and is anything left unsaved?
    async saveStatus({ jobId }) {
      const { state, job } = context(jobId);
      return {
        saving: Boolean(state.annotation.annotations.saving?.uploading),
        unsaved: Boolean(job.annotations.hasUnsavedChanges()),
        state: job.state,
      };
    },

    // Complete & Next step 2: set the job to completed the way CVAT's "Finish the job" does
    // after saving (updateJobAsync, exposed to plugins). CVAT 2.56 shows no success message
    // for this, so the caller checks the returned state and then the server.
    async completeJob({ jobId }) {
      const { state, job } = context(jobId);
      assertIdle(state);
      if (job.annotations.hasUnsavedChanges()) fail('Còn thay đổi chưa lưu. Lưu trước khi hoàn tất.');
      if (job.state !== 'completed') {
        await plugin.dispatch(plugin.actionCreators.updateJobAsync(job, { state: 'completed' }));
      }
      return { state: job.state };
    },

    // Called after Complete & Next: the job is done, drop what was kept for it.
    async clearCache() {
      cache = null;
      return { cleared: true };
    },

    async tagCount({ jobId }) {
      const { job } = context(jobId);
      return { ...await countTags(job), editHistory: historyStatus(job) };
    },

    async clearSnapshot({ jobId }) {
      const { job } = context(jobId);
      return clearSummary(await readAllTags(job));
    },

    // Same path as applyRange, over the whole job: the live tags are re-read and compared
    // with the fingerprint the dialog showed, deleted in the browser, the current frame is
    // refreshed in place (no reload, no request), and the range cache is kept: every cached
    // frame is still valid, it just has no tags now. CVAT's save uploads the deletions.
    async clearAll({ jobId, key, expected }) {
      const { state, job } = context(jobId);
      assertIdle(state);
      const before = frameCache(job);
      const tags = await readAllTags(job);
      const summary = clearSummary(tags);
      if (typeof key === 'string' ? summary.key !== key : tags.length !== expected) return { stale: true, ...summary };
      const removed = await deleteJobTags(job, tags);
      await refresh(job);
      const frames = frameCache(job);
      for (const [frame, entry] of before) frames.set(frame, { tags: [], valid: entry.valid });
      return { removed, created: 0, save: saveInfo(job) };
    },
  };

  document.addEventListener(REQUEST, (event) => {
    let request;
    try { request = JSON.parse(event.detail); } catch { return; }
    if (!request || typeof request.id !== 'string' || !Object.hasOwn(methods, request.method)) return;
    const reply = (body) => document.dispatchEvent(new CustomEvent(RESPONSE, {
      detail: JSON.stringify({ id: request.id, ...body }),
    }));
    methods[request.method](request.params || {}).then(
      (result) => reply({ ok: true, result }),
      (error) => {
        if (!(error instanceof BridgeError)) console.warn('CVAT Event Hotkeys bridge:', error);
        reply({ ok: false, error: error instanceof BridgeError ? error.message : `Lỗi CVAT: ${error?.message || error}` });
      },
    );
  });
})();
