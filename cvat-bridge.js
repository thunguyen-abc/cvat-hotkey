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
  let plugin = null;

  function register() {
    if (plugin) return true;
    const ui = window.cvatUI;
    if (!ui || typeof ui.registerComponent !== 'function') return false;
    ui.registerComponent((context) => {
      plugin = context;
      return { name: 'CVAT Event Hotkeys', destructor: () => { plugin = null; } };
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

  // Whole-job tag list. Used only by Clear All Tags, which is job-wide by definition.
  async function readAllTags(job) {
    const data = await job.annotations.export();
    return (data.tags || []).map((tag) => ({ clientID: tag.clientID, frame: tag.frame, labelId: tag.label_id }));
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

  // statesOf(frame) returns the frame's tag ObjectStates (already read for the range).
  async function applyPlan(job, plan, target, statesOf) {
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
      const states = plan.create.map((frame) => new plugin.core.classes.ObjectState({
        objectType: tagType, label: target, frame,
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

    // The content script plans the change from the snapshot (range-plan.js) and sends the
    // concrete plan with the snapshot key. The range is re-read live and everything is
    // re-checked before anything changes.
    async applyRange({ jobId, low, high, key, create, remove, targetId }) {
      const { state, job } = context(jobId);
      assertIdle(state);
      integer(low, 'low');
      integer(high, 'high');
      const live = await readRange(job, low, high, true);
      const snapshot = snapshotOf(job, live);
      if (snapshot.key !== key) return { stale: true, snapshot };
      if (!Array.isArray(create) || !Array.isArray(remove)) fail('Kế hoạch không hợp lệ.');
      const current = new Map(live.tags.map((tag) => [tag.clientID, tag]));
      const deleting = remove.map((clientID) => current.get(clientID) ?? fail('Tag cần xóa không còn trong khoảng.'));
      const target = create.length ? job.labels.find((label) => label.id === targetId) ?? fail('Không tìm thấy tag đích.') : null;
      const keeps = new Set(live.tags.filter((tag) => tag.labelId === targetId && !remove.includes(tag.clientID))
        .map((tag) => tag.frame));
      for (const frame of create) {
        if (!Number.isInteger(frame) || frame < low || frame > high || keeps.has(frame)) fail('Kế hoạch tạo tag không hợp lệ.');
        keeps.add(frame);
      }
      const before = cache.frames;
      const result = await applyPlan(job, { delete: deleting, create }, target, async (frame) => live.states.get(frame) ?? []);
      await refresh(job);
      // Our own change moved the history key. Keep the untouched frames of the range and
      // re-read only the frames that changed.
      const touched = new Set([...deleting.map((tag) => tag.frame), ...create]);
      const frames = frameCache(job);
      for (const [frame, entry] of before) {
        if (frame >= low && frame <= high && !touched.has(frame)) frames.set(frame, entry);
      }
      for (const frame of touched) frames.set(frame, (await readFrame(job, frame)).entry);
      return { ...result, save: saveInfo(job) };
    },

    // Called after Complete & Next: the job is done, drop what was kept for it.
    async clearCache() {
      cache = null;
      return { cleared: true };
    },

    async clearSnapshot({ jobId }) {
      const { job } = context(jobId);
      const tags = await readAllTags(job);
      return { count: tags.length, frames: new Set(tags.map((tag) => tag.frame)).size };
    },

    async clearAll({ jobId, expected }) {
      const { state, job } = context(jobId);
      assertIdle(state);
      const tags = await readAllTags(job);
      if (tags.length !== expected) return { stale: true, count: tags.length };
      const tagType = plugin.core.enums.ObjectType.TAG;
      const result = await applyPlan(job, { delete: tags, create: [] }, null,
        async (frame) => (await job.annotations.get(frame, false, [])).filter((item) => item.objectType === tagType));
      await refresh(job);
      cache = null;
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
