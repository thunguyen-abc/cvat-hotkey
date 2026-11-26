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
        document.dispatchEvent(new CustomEvent(CHANGED, { detail: JSON.stringify({ jobId: job.id, ...counts }) }));
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
    return { labels: tagLabels(job), tags: range.tags, addFrames: range.addFrames, key: rangeKey(range.tags), read: range.read };
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

  // plan.create: [{ frame, label }] with CVAT Label objects. statesOf(frame) returns the
  // frame's tag ObjectStates (already read for the range).
  async function applyPlan(job, plan, statesOf) {
    const tagType = plugin.core.enums.ObjectType.TAG;
    const byFrame = new Map();
    for (const { clientID, frame } of plan.delete) {
      if (!byFrame.has(frame)) byFrame.set(frame, new Set());
      byFrame.get(frame).add(clientID);
    }
    let removed = 0;
    let visited = 0;
    for (const [frame, ids] of byFrame) {
      for (const state of await statesOf(frame)) {
        if (state.objectType === tagType && ids.has(state.clientID) && await state.delete(frame, true)) removed += 1;
      }
      visited += 1;
      if (visited % 100 === 0) await yieldToBrowser();
    }
    if (plan.create.length) {
      // One put: one Undo step for all new tags.
      const states = plan.create.map(({ frame, label }) => new plugin.core.classes.ObjectState({
        objectType: tagType, label, frame,
      }));
      await job.annotations.put(states);
    }
    return { removed, created: plan.create.length };
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

    async rangeSnapshot({ jobId, low, high }) {
      const { job } = context(jobId);
      return snapshotOf(job, await readRange(job, integer(low, 'low'), integer(high, 'high')));
    },

    // The content script plans all operations from the snapshot (range-plan.js) and sends
    // the final difference: tags to remove (clientIDs) and tags to create ({ frame, labelId }),
    // with the snapshot key. The range is re-read live and the whole plan is re-checked
    // before anything changes; then it is applied in one go.
    async applyRange({ jobId, low, high, key, create, remove }) {
      const { state, job } = context(jobId);
      assertIdle(state);
      integer(low, 'low');
      integer(high, 'high');
      const live = await readRange(job, low, high, true);
      const snapshot = snapshotOf(job, live);
      if (snapshot.key !== key) return { stale: true, snapshot };
      if (!Array.isArray(create) || !Array.isArray(remove)) fail('Kế hoạch không hợp lệ.');
      const current = new Map(live.tags.map((tag) => [tag.clientID, tag]));
      if (new Set(remove).size !== remove.length) fail('Kế hoạch xóa tag bị trùng.');
      const deleting = remove.map((clientID) => current.get(clientID) ?? fail('Tag cần xóa không còn trong khoảng.'));
      const removing = new Set(remove);
      const labels = new Map(job.labels.filter((label) => ['any', 'tag'].includes(label.type)).map((label) => [label.id, label]));
      // (frame, label) pairs that will exist: kept tags plus planned ones. No duplicates allowed.
      const pairs = new Set(live.tags.filter((tag) => !removing.has(tag.clientID)).map((tag) => tag.frame + '/' + tag.labelId));
      const creating = create.map((item) => {
        const label = labels.get(item?.labelId) ?? fail('Không tìm thấy tag đích trong job.');
        const pair = item.frame + '/' + item.labelId;
        if (!Number.isInteger(item.frame) || item.frame < low || item.frame > high || pairs.has(pair)) {
          fail('Kế hoạch tạo tag không hợp lệ.');
        }
        pairs.add(pair);
        return { frame: item.frame, label };
      });
      const before = cache.frames;
      const result = await applyPlan(job, { delete: deleting, create: creating }, async (frame) => live.states.get(frame) ?? []);
      await refresh(job);
      // Our own change moved the history key. Keep the untouched frames of the range and
      // re-read only the frames that changed.
      const touched = new Set([...deleting.map((tag) => tag.frame), ...creating.map((item) => item.frame)]);
      const frames = frameCache(job);
      for (const [frame, entry] of before) {
        if (frame >= low && frame <= high && !touched.has(frame)) frames.set(frame, entry);
      }
      for (const frame of touched) frames.set(frame, (await readFrame(job, frame)).entry);
      return { ...result, save: saveInfo(job) };
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
      return countTags(job);
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
      const tagType = plugin.core.enums.ObjectType.TAG;
      const result = await applyPlan(job, { delete: tags, create: [] },
        async (frame) => (await job.annotations.get(frame, false, [])).filter((item) => item.objectType === tagType));
      await refresh(job);
      const frames = frameCache(job);
      for (const [frame, entry] of before) frames.set(frame, { tags: [], valid: entry.valid });
      return { ...result, save: saveInfo(job) };
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
