// Runs in the page's MAIN world. Registers as a CVAT UI plugin (window.cvatUI, CVAT >= 2.x)
// to reach the job that CVAT already holds in memory. Every operation here works on the
// browser copy of the annotations: nothing is sent to the server. CVAT's own save
// (autosave, Save, Finish the job) later uploads only the objects that changed.
//
// The content scripts talk to it through DOM events carrying JSON strings.
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
  }

  function integer(value, name) {
    if (!Number.isInteger(value)) fail(`Tham số ${name} không hợp lệ.`);
    return value;
  }

  async function readTags(job) {
    const data = await job.annotations.export();
    return (data.tags || []).map((tag) => ({ clientID: tag.clientID, frame: tag.frame, labelId: tag.label_id }));
  }

  // Fingerprint of the tags in a range. Apply is refused when it changed after the preview.
  function rangeKey(tags) {
    return JSON.stringify(tags.map((tag) => [tag.clientID, tag.frame, tag.labelId]).sort((a, b) => a[0] - b[0]));
  }

  async function rangeSnapshot(job, low, high) {
    const tags = (await readTags(job)).filter((tag) => tag.frame >= low && tag.frame <= high);
    return { labels: tagLabels(job), tags, addFrames: await validFrames(job, low, high), key: rangeKey(tags) };
  }

  // Frames that can take a new tag, using CVAT's cached frame meta (deleted frames,
  // frame step, included frames). No request is made.
  async function validFrames(job, low, high) {
    const frames = [];
    const to = Math.min(high, job.stopFrame);
    for (let from = Math.max(low, job.startFrame); from <= to;) {
      const frame = await job.frames.search({ notDeleted: true }, from, to);
      if (!Number.isInteger(frame) || frame > to) break;
      frames.push(frame);
      from = frame + 1;
    }
    return frames;
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

  async function applyPlan(job, plan, target) {
    const tagType = plugin.core.enums.ObjectType.TAG;
    const byFrame = new Map();
    for (const { clientID, frame } of plan.delete) {
      if (!byFrame.has(frame)) byFrame.set(frame, new Set());
      byFrame.get(frame).add(clientID);
    }
    let removed = 0;
    let visited = 0;
    for (const [frame, ids] of byFrame) {
      const states = await job.annotations.get(frame, false, []);
      for (const state of states) {
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

  // Redraw the current frame from the in-memory collection (the frame image is cached).
  async function refresh(job) {
    const before = plugin.store.getState();
    const frame = before.annotation.player.frame.number;
    try {
      await plugin.dispatch(plugin.actionCreators.changeFrameAsync(frame, false, 1, true));
    } catch { /* Checked below. */ }
    const state = plugin.store.getState();
    const expected = await job.annotations.get(frame, Boolean(state.settings?.workspace?.showAllInterpolationTracks),
      state.annotation.annotations.filters || []);
    const shown = new Set((state.annotation.annotations.states || []).map((item) => item.clientID));
    if (expected.length === shown.size && expected.every((item) => shown.has(item.clientID))) return;
    // changeFrameAsync skips the update while the canvas is busy; publish the states directly.
    const zLayer = state.annotation.annotations.zLayer || {};
    plugin.dispatch({
      type: 'FETCH_ANNOTATIONS_SUCCESS',
      payload: { states: expected, history: await job.actions.get(), minZ: zLayer.min ?? 0, maxZ: zLayer.max ?? 0 },
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
      return rangeSnapshot(job, integer(low, 'low'), integer(high, 'high'));
    },

    // The content script plans the change from the snapshot (range-plan.js) and sends the
    // concrete plan with the snapshot key. Everything is re-checked against the live data.
    async applyRange({ jobId, low, high, key, create, remove, targetId }) {
      const { state, job } = context(jobId);
      assertIdle(state);
      integer(low, 'low');
      integer(high, 'high');
      const snapshot = await rangeSnapshot(job, low, high);
      if (snapshot.key !== key) return { stale: true, snapshot };
      if (!Array.isArray(create) || !Array.isArray(remove)) fail('Kế hoạch không hợp lệ.');
      const current = new Map(snapshot.tags.map((tag) => [tag.clientID, tag]));
      const deleting = remove.map((clientID) => current.get(clientID) ?? fail('Tag cần xóa không còn trong khoảng.'));
      const target = create.length ? job.labels.find((label) => label.id === targetId) ?? fail('Không tìm thấy tag đích.') : null;
      const keeps = new Set(snapshot.tags.filter((tag) => tag.labelId === targetId && !remove.includes(tag.clientID))
        .map((tag) => tag.frame));
      for (const frame of create) {
        if (!Number.isInteger(frame) || frame < low || frame > high || keeps.has(frame)) fail('Kế hoạch tạo tag không hợp lệ.');
        keeps.add(frame);
      }
      const result = await applyPlan(job, { delete: deleting, create }, target);
      await refresh(job);
      return { ...result, save: saveInfo(job) };
    },

    async clearSnapshot({ jobId }) {
      const { job } = context(jobId);
      const tags = await readTags(job);
      return { count: tags.length, frames: new Set(tags.map((tag) => tag.frame)).size };
    },

    async clearAll({ jobId, expected }) {
      const { state, job } = context(jobId);
      assertIdle(state);
      const tags = await readTags(job);
      if (tags.length !== expected) return { stale: true, count: tags.length };
      const result = await applyPlan(job, { delete: tags, create: [] }, null);
      await refresh(job);
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
