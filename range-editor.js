'use strict';

// planCVATRangeBatch, countCVATLabels and CVAT_EVENT_LABELS come from range-plan.js;
// cvatEventBridge and describeCVATSave from bridge-client.js. The editor never calls the
// server: it reads and changes the annotations CVAT holds in the browser, and CVAT's own
// save uploads them.
//
// Quickstart panel, under the frame number: Start/End, the three event buttons, a queue of
// + / − rows and Apply. "Nâng cao" opens the dialog with every mode (Đổi tag, Xóa toàn bộ
// tag trong khoảng, ...), seeded with the queued rows. Panel and dialog share one Apply.
const CVAT_RANGE_COLLAPSED = 'cvat-event-range-collapsed';

function attachCVATRangeEditor(control, slider, anchor) {
  const { job } = control;
  const jobSignal = control.controller.signal;
  // One mount per slider/anchor. A remount in the same job removes the old panel, band and
  // key listeners first; the job's marks, selection, queue and snapshot stay on control.
  control.rangeMount?.abort();
  const mount = new AbortController();
  control.rangeMount = mount;
  const signal = AbortSignal.any([jobSignal, mount.signal]);
  const storageKey = 'cvat-event-range:' + job.jobId;
  const state = control.rangeState ??= createState();

  function createState() {
    const marks = { start: null, end: null };
    try {
      const stored = JSON.parse(sessionStorage.getItem(storageKey));
      for (const name of ['start', 'end']) if (Number.isInteger(stored?.[name])) marks[name] = stored[name];
    } catch { /* Storage may be unavailable. */ }
    // rows: [{ mode: 'add' | 'remove', ids: [labelId] }], bound to the current range.
    // snapshot: rangeSnapshot result plus { low, high }; loading: the range being read.
    return { marks, selected: new Set(), rows: [], snapshot: null, loading: null, error: null,
      notice: null, busy: false, mounted: null };
  }

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function button(text, className) {
    const node = element('button', text, 'ant-btn ant-btn-default ant-btn-sm');
    node.type = 'button';
    if (className) node.classList.add(...className.split(' '));
    return node;
  }

  // ---- Panel ---------------------------------------------------------------------------
  const panel = element('section', undefined, 'cvat-range-buttons cvat-quick-panel');
  panel.setAttribute('aria-label', 'Chỉnh tag theo khoảng frame');
  const head = element('div', undefined, 'cvat-quick-head');
  const frameCounter = element('div', undefined, 'cvat-quick-frame');
  const framePosition = element('strong', '—', 'cvat-quick-frame-position');
  frameCounter.append(element('span', 'Frame'), framePosition);
  const start = button('Start', 'cvat-quick-start');
  const end = button('End', 'cvat-quick-end');
  start.title = 'Đặt frame hiện tại làm mốc đầu (phím 4)';
  end.title = 'Đặt frame hiện tại làm mốc cuối (phím 5)';
  const advanced = button('Nâng cao', 'cvat-quick-advanced');
  advanced.setAttribute('aria-haspopup', 'dialog');
  const toggle = button(undefined, 'cvat-quick-toggle');
  head.append(frameCounter, advanced, toggle);

  const body = element('div', undefined, 'cvat-quick-body');
  body.id = 'cvat-quick-body-' + job.jobId;
  toggle.setAttribute('aria-controls', body.id);
  const marks = element('div', undefined, 'cvat-quick-marks');
  marks.setAttribute('role', 'group');
  marks.setAttribute('aria-label', 'Mốc khoảng frame');
  const length = element('span', undefined, 'cvat-quick-length');
  marks.append(start, end, length);
  const events = element('div', undefined, 'cvat-quick-events');
  events.setAttribute('role', 'group');
  events.setAttribute('aria-label', 'Event cần chỉnh');
  // Always exactly three boxes, in slot order. A label missing from the job keeps its box,
  // disabled. Other tag labels of the job are never shown here.
  const eventButtons = CVAT_EVENT_LABELS.map((name, index) => {
    const node = button(undefined, 'cvat-quick-event');
    node.dataset.event = name;
    node.dataset.slot = String(index + 1);
    node.setAttribute('aria-pressed', 'false');
    const label = element('span', undefined, 'cvat-quick-event-name');
    const [prefix, suffix] = name.split('_');
    label.append(prefix + '_', element('wbr'), suffix);
    const counts = element('span', undefined, 'cvat-quick-event-metrics');
    const count = element('span', '—', 'cvat-quick-event-count');
    const projection = element('span', undefined, 'cvat-quick-event-next');
    counts.append(count, projection);
    node.append(label, counts);
    node.onclick = () => toggleEvent(index);
    events.append(node);
    return { node, count, projection };
  });
  const queueActions = element('div', undefined, 'cvat-quick-actions');
  const addRow = button('+ Thêm', 'cvat-quick-add');
  const removeRow = button('− Xóa', 'cvat-quick-remove');
  addRow.title = 'Xếp thao tác thêm các event đang chọn (phím =)';
  removeRow.title = 'Xếp thao tác xóa các event đang chọn (phím -)';
  queueActions.append(addRow, removeRow);
  const queue = element('ol', undefined, 'cvat-quick-queue');
  queue.setAttribute('aria-label', 'Thao tác chờ áp dụng');
  const footer = element('div', undefined, 'cvat-quick-footer');
  const info = element('span', undefined, 'cvat-quick-info');
  info.setAttribute('role', 'status');
  const apply = button('Áp dụng', 'cvat-quick-apply cvat-event-primary');
  apply.title = 'Áp dụng các thao tác đang xếp (Enter)';
  footer.append(info, apply);
  const hint = element('small', '4 / 5 mốc · Alt+1–3 event · = thêm · - xóa · Enter áp dụng', 'cvat-quick-hint');
  body.append(events, queueActions, queue, footer, hint);
  panel.append(head, marks, body);
  anchor.append(panel);
  const band = element('div', undefined, 'cvat-range-band');
  slider.append(band);

  let collapsed = false;
  try { collapsed = localStorage.getItem(CVAT_RANGE_COLLAPSED) === '1'; } catch { /* Optional. */ }
  function setCollapsed(value) {
    collapsed = value;
    body.hidden = value;
    panel.dataset.collapsed = String(value);
    toggle.textContent = value ? '▾' : '▴';
    toggle.setAttribute('aria-expanded', String(!value));
    toggle.title = value ? 'Mở rộng bảng chỉnh tag' : 'Thu gọn bảng chỉnh tag';
    toggle.setAttribute('aria-label', toggle.title);
    try { localStorage.setItem(CVAT_RANGE_COLLAPSED, value ? '1' : '0'); } catch { /* Optional. */ }
  }
  setCollapsed(collapsed);
  toggle.onclick = () => setCollapsed(!collapsed);

  // ---- Range ---------------------------------------------------------------------------
  const frame = (attribute) => {
    const raw = slider.querySelector('[role="slider"]')?.getAttribute('aria-value' + attribute);
    return raw == null ? NaN : Number(raw);
  };
  const validMark = (value) => Number.isInteger(value) && value >= frame('min') && value <= frame('max');
  function currentRange(marks = state.marks) {
    if (!validMark(marks.start) || !validMark(marks.end)) return null;
    return { low: Math.min(marks.start, marks.end), high: Math.max(marks.start, marks.end) };
  }
  const sameRange = (a, b) => Boolean(a && b && a.low === b.low && a.high === b.high);
  const snapshotFor = (range) => (sameRange(state.snapshot, range) ? state.snapshot : null);
  const eventIdsOf = (snapshot) => CVAT_EVENT_LABELS.map((name) =>
    snapshot?.labels.find((label) => label.name === name)?.id ?? null);
  const nameIn = (snapshot, id) => snapshot?.labels.find((label) => label.id === id)?.name ?? '#' + id;
  const operations = (rows) => rows.map((row) => (row.mode === 'add'
    ? { mode: 'add', sources: [], targets: [...row.ids] }
    : { mode: 'remove', sources: [...row.ids], targets: [] }));
  const planFor = (range, snapshot, ops) => planCVATRangeBatch({
    tags: snapshot.tags, low: range.low, high: range.high, addFrames: snapshot.addFrames, operations: ops,
  });

  function paintFramePosition() {
    const current = frame('now');
    const min = frame('min');
    const max = frame('max');
    const ready = [current, min, max].every(Number.isInteger) && current >= min && current <= max;
    const position = ready ? (current - min) + '/' + (max - min + 1) : '—';
    frameCounter.title = ready ? 'Frame ' + current + ' · Vị trí trong job tính từ 0' : '';
    if (framePosition.textContent !== position) framePosition.textContent = position;
  }

  // A label can have more than one tag on a frame. The event cards measure frame coverage.
  function countEventFrames(tags, ids) {
    const framesById = new Map(ids.filter((id) => id !== null).map((id) => [id, new Set()]));
    for (const { labelId, frame: number } of tags) framesById.get(labelId)?.add(number);
    return framesById;
  }

  function paint() {
    const min = frame('min');
    const max = frame('max');
    const points = [state.marks.start, state.marks.end].filter(validMark);
    start.dataset.marked = String(validMark(state.marks.start));
    end.dataset.marked = String(validMark(state.marks.end));
    start.textContent = validMark(state.marks.start) ? 'Start ' + state.marks.start : 'Start';
    end.textContent = validMark(state.marks.end) ? 'End ' + state.marks.end : 'End';
    band.hidden = !points.length;
    if (points.length) {
      const span = Math.max(1, max - min);
      band.style.left = ((Math.min(...points) - min) * 100 / span) + '%';
      band.style.width = (max === min ? 100 : (Math.max(...points) - Math.min(...points)) * 100 / span) + '%';
    }
  }

  // Reads the tags of the marked range (bridge cache: only frames not read yet). A result
  // that arrives after the range, the job or the mount changed is dropped.
  async function load(force = false) {
    const range = currentRange();
    if (!range || (!force && (snapshotFor(range) || sameRange(state.loading, range)))) {
      state.mounted?.render();
      return;
    }
    const request = { ...range };
    state.loading = request;
    state.error = null;
    state.mounted?.render();
    let snapshot = null;
    let error = null;
    try {
      if (!await cvatEventBridge.ready()) throw new Error('CVAT chưa sẵn sàng cho extension. Đợi job tải xong rồi thử lại.');
      snapshot = await cvatEventBridge.call('rangeSnapshot', { jobId: job.jobId, ...range }, 60000);
    } catch (problem) { error = problem.message; }
    if (jobSignal.aborted || state.loading !== request) return;
    state.loading = null;
    if (snapshot) state.snapshot = { ...snapshot, ...range };
    else state.error = error;
    state.mounted?.render();
  }

  function render() {
    if (signal.aborted) return;
    paint();
    const range = currentRange();
    const snapshot = snapshotFor(range);
    const loading = sameRange(state.loading, range);
    const ids = eventIdsOf(snapshot);
    const result = snapshot ? planFor(range, snapshot, operations(state.rows)) : null;
    const ready = Boolean(snapshot) && !state.busy;
    const rangeLength = range ? range.high - range.low + 1 : 0;
    length.textContent = range ? rangeLength + ' frame' : '';
    length.hidden = !range;
    advanced.disabled = !ready;
    advanced.title = ready ? 'Đổi tag, xóa toàn bộ tag trong khoảng và các thao tác khác'
      : 'Chọn Start và End để chỉnh tag';

    const before = countEventFrames(snapshot?.tags ?? [], ids);
    const after = state.rows.length && result ? countEventFrames(result.desired, ids) : before;
    eventButtons.forEach(({ node, count, projection }, index) => {
      const name = CVAT_EVENT_LABELS[index];
      const id = ids[index];
      const missing = Boolean(snapshot) && id === null;
      node.disabled = !ready || id === null;
      node.dataset.missing = String(missing);
      node.setAttribute('aria-pressed', String(state.selected.has(name) && !missing));
      const now = before.get(id)?.size ?? 0;
      const next = after.get(id)?.size ?? 0;
      count.textContent = snapshot && !missing ? now + '/' + rangeLength : '—';
      projection.hidden = now === next;
      projection.textContent = now === next ? '' : '→ ' + next;
      node.title = missing ? 'Job không có nhãn ' + name
        : name + ' (Alt+' + (index + 1) + ')' + (snapshot ? ': ' + now + '/' + rangeLength + ' frame trong khoảng' : '') +
          (now === next ? '' : ' · Sau áp dụng: ' + next + '/' + rangeLength);
    });
    const chosen = selectedIds(snapshot);
    addRow.disabled = removeRow.disabled = !ready || !chosen.length;

    queue.replaceChildren(...state.rows.map((row, index) => {
      const step = result?.steps[index];
      const item = element('li', undefined, 'cvat-quick-row');
      item.dataset.mode = row.mode;
      const sign = element('span', row.mode === 'add' ? '+' : '−', 'cvat-quick-sign');
      sign.title = row.mode === 'add' ? 'Thêm' : 'Xóa';
      const names = row.ids.map((id) => nameIn(snapshot, id)).join(', ');
      const text = element('span', names, 'cvat-quick-names');
      const problem = step?.problem ? rowProblem(row, step, index, snapshot) : '';
      item.dataset.invalid = String(Boolean(problem));
      const drop = button('×', 'cvat-quick-drop');
      drop.dataset.index = String(index);
      drop.disabled = state.busy;
      drop.setAttribute('aria-label', 'Bỏ thao tác ' + (row.mode === 'add' ? 'thêm ' : 'xóa ') + names);
      drop.title = 'Bỏ thao tác này';
      drop.onclick = () => dropRow(index);
      item.append(sign, text, drop);
      if (problem) item.append(element('small', problem, 'cvat-quick-problem'));
      return item;
    }));
    queue.hidden = !state.rows.length;

    let text;
    let kind = 'idle';
    const counts = result?.counts;
    if (state.notice) ({ text, kind } = state.notice);
    else if (!range) text = 'Đặt Start (4) và End (5) để chọn khoảng.';
    else if (state.busy) text = 'Đang cập nhật tag trên trình duyệt…';
    else if (!snapshot && loading) text = 'Đang đọc tag…';
    else if (!snapshot) { text = state.error || 'Chưa đọc được tag.'; kind = 'error'; }
    else if (!state.rows.length) text = 'Chọn event rồi bấm + Thêm hoặc − Xóa.';
    else {
      text = 'Thêm ' + counts.add + ' · Xóa ' + counts.remove + (counts.replace ? ' · Đổi ' + counts.replace : '');
      if (!result.complete) { text += ' · Sửa dòng báo lỗi.'; kind = 'error'; }
    }
    info.textContent = text;
    info.dataset.kind = kind;
    const changes = counts ? counts.add + counts.replace + counts.remove : 0;
    apply.disabled = !ready || loading || !result.complete || !changes;
    apply.classList.toggle('cvat-event-danger', Boolean(counts) && counts.remove > 0 && !counts.add && !counts.replace);
  }

  function selectedIds(snapshot) {
    const ids = eventIdsOf(snapshot);
    return CVAT_EVENT_LABELS.map((name, index) => (state.selected.has(name) ? ids[index] : null))
      .filter((id) => id !== null);
  }
  function rowProblem(row, step, index, snapshot) {
    if (row.mode !== 'remove') return step.problem;
    const missing = row.ids.filter((id) => !step.present.has(id)).map((id) => nameIn(snapshot, id));
    if (!missing.length) return step.problem;
    return 'Khoảng không có ' + missing.join(', ') + (index ? ' sau các thao tác phía trên.' : '.');
  }

  // ---- Actions (shared by mouse and keys) ------------------------------------------------
  function mark(name) {
    const current = frame('now');
    if (!Number.isInteger(current) || state.busy) return;
    const next = { ...state.marks, [name]: current };
    const before = currentRange();
    if (state.rows.length && !sameRange(before, currentRange(next))) {
      const question = 'Bỏ ' + state.rows.length + ' thao tác chưa áp dụng của frame ' + before.low + '–' +
        before.high + ' để đặt khoảng mới?';
      if (!window.confirm(question)) return;
      state.rows = [];
    }
    state.marks = next;
    try { sessionStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Optional persistence. */ }
    state.notice = null;
    void load();
  }
  function toggleEvent(index) {
    if (eventButtons[index].node.disabled) return;
    const name = CVAT_EVENT_LABELS[index];
    if (state.selected.has(name)) state.selected.delete(name);
    else state.selected.add(name);
    state.notice = null;
    render();
  }
  // One row per press with every selected event, in button order. The row keeps a copy of
  // the ids, so toggling afterwards only affects the next row.
  function enqueue(mode) {
    const range = currentRange();
    const ids = selectedIds(snapshotFor(range));
    if (!range || state.busy || !ids.length) return;
    state.rows = [...state.rows, { mode, ids }];
    state.notice = null;
    render();
  }
  function dropRow(index) {
    if (state.busy) return;
    state.rows = state.rows.filter((_, position) => position !== index);
    state.notice = null;
    render();
    const drops = queue.querySelectorAll('.cvat-quick-drop');
    (drops[Math.min(index, drops.length - 1)] ?? addRow).focus({ preventScroll: true });
  }

  // The single Apply path for panel and dialog. The range, plan and snapshot key are taken
  // by the caller before the call; the toolbar guard keeps Apply, Clear All Tags and
  // Complete & Next from overlapping.
  async function applyChange(range, key, change) {
    if (state.busy) throw new Error('Đang áp dụng thao tác trước.');
    if (control.button.disabled || control.clearButton.disabled) {
      throw new Error('Đợi Complete & Next hoặc Clear All Tags xong rồi thử lại.');
    }
    state.busy = true;
    control.button.disabled = control.clearButton.disabled = true;
    state.mounted?.render();
    try {
      return await cvatEventBridge.call('applyRange', {
        jobId: job.jobId, low: range.low, high: range.high, key,
        create: change.create, remove: change.delete.map((item) => item.clientID),
      }, 120000);
    } finally {
      state.busy = false;
      if (!jobSignal.aborted) control.button.disabled = control.clearButton.disabled = false;
      state.mounted?.render();
    }
  }
  function applied(range, change, result) {
    const { add, replace, remove } = change.counts;
    state.rows = [];
    state.notice = { text: 'Đã áp dụng: thêm ' + add + ', đổi ' + replace + ', xóa ' + remove + ' tag.', kind: 'done' };
    // Start/End stay marked (and highlighted) for the next edit; Complete & Next clears them.
    control.notify('Frame ' + range.low + '–' + range.high + ': thêm ' + add + ', đổi ' + replace + ', xóa ' +
      remove + ' tag. ' + describeCVATSave(result.save));
    void state.mounted?.load(true);
  }

  let applying = false;
  async function applyQuick() {
    if (apply.disabled || applying) return;
    const range = currentRange();
    const snapshot = snapshotFor(range);
    const change = planFor(range, snapshot, operations(state.rows));
    if (!change.complete) return;
    applying = true;
    try {
      const result = await applyChange(range, snapshot.key, change);
      if (jobSignal.aborted) return;
      if (result.stale) {
        state.snapshot = { ...result.snapshot, ...range };
        state.notice = { text: 'Tag trong khoảng vừa thay đổi. Kiểm tra lại rồi bấm Áp dụng.', kind: 'error' };
      } else applied(range, change, result);
    } catch (error) {
      if (jobSignal.aborted) return;
      state.notice = { text: error.message + ' Các thao tác vẫn được giữ để thử lại.', kind: 'error' };
    } finally {
      applying = false;
      state.mounted?.render();
    }
  }

  start.onclick = () => mark('start');
  end.onclick = () => mark('end');
  addRow.onclick = () => enqueue('add');
  removeRow.onclick = () => enqueue('remove');
  apply.onclick = () => { void applyQuick(); };
  advanced.onclick = () => {
    const range = currentRange();
    if (!advanced.disabled && !control.button.disabled) openEditor(range, state.rows.map((row) => ({ ...row })));
  };

  // ---- Keys ------------------------------------------------------------------------------
  // 4/5 mark Start/End (CVAT's own slot 4/5 does not fire), Alt+1/2/3 (or Ctrl+1/2/3 where
  // the browser passes it on) toggle the event buttons, = / - queue + / −, Enter applies.
  // Only in Tag annotation on this job, with no dialog, dropdown or text field in the way;
  // a key the panel cannot use right now goes to CVAT and the browser unchanged.
  const editable = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], ' +
    '[role="textbox"], [role="combobox"], [role="spinbutton"]';
  const overlays = '.ant-modal-wrap, .ant-select-dropdown, .ant-dropdown, .ant-popover, .ant-picker-dropdown';
  const ownControls = 'button, a[href], summary, [role="button"], [role="link"], [role="menuitem"], ' +
    '[role="option"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"]';
  const jobPath = new RegExp('^/tasks/\\d+/jobs/' + job.jobId + '/?$');
  function tagWorkspace() {
    const name = document.querySelector('.cvat-workspace-selector .ant-select-selection-item')?.textContent.trim();
    return name ? name === 'Tag annotation' : Boolean(document.querySelector('.cvat-tag-annotation-sidebar'));
  }
  function keysAllowed(target) {
    if (signal.aborted || !panel.isConnected || !jobPath.test(location.pathname) || !tagWorkspace()) return false;
    if (document.querySelector('dialog[open]')) return false;
    if ([...document.querySelectorAll(overlays)].some((node) => node.getClientRects().length)) return false;
    return !(target instanceof Element && target.closest(editable + ', ' + overlays + ', dialog'));
  }
  function keyAction(event) {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || !keysAllowed(event.target)) return null;
    const { key, code } = event;
    const modified = event.ctrlKey || event.altKey || event.metaKey;
    if (!modified && (key === '4' || key === '5')) return () => mark(key === '4' ? 'start' : 'end');
    if (collapsed) return null;
    const slot = /^(?:Digit|Numpad)([1-3])$/.exec(code)?.[1];
    if (slot && event.altKey !== event.ctrlKey && !event.metaKey && !event.shiftKey) {
      const index = Number(slot) - 1;
      return eventButtons[index].node.disabled ? null : () => toggleEvent(index);
    }
    if (modified) return null;
    if (key === '=' || key === '+') return addRow.disabled ? null : () => enqueue('add');
    if (key === '-') return removeRow.disabled ? null : () => enqueue('remove');
    if (key === 'Enter' && !event.shiftKey && !(event.target instanceof Element && event.target.closest(ownControls))) {
      return apply.disabled ? null : () => { void applyQuick(); };
    }
    return null;
  }
  // A key taken once stays taken while held: its auto-repeat never reaches CVAT.
  const held = new Set();
  window.addEventListener('keydown', (event) => {
    if (event.repeat) {
      if (held.has(event.code)) { event.preventDefault(); event.stopImmediatePropagation(); }
      return;
    }
    const action = keyAction(event);
    if (!action) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    held.add(event.code);
    action();
  }, { capture: true, signal });
  window.addEventListener('keyup', (event) => held.delete(event.code), { capture: true, signal });
  window.addEventListener('blur', () => held.clear(), { signal });

  // A tag hotkey, Undo/Redo or Clear All Tags changed the job: re-read the range (only
  // frames not cached) so the counts and the next Apply start from current data.
  let reloadTimer = 0;
  cvatEventBridge.onTagsChanged(({ jobId }) => {
    if (jobId !== job.jobId) return;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => { if (!signal.aborted && !state.busy) void load(true); }, 400);
  }, signal);

  state.mounted = { render, load };
  // Follow the player during navigation or playback without rebuilding the queue or reading tags.
  const frameObserver = new MutationObserver(paintFramePosition);
  frameObserver.observe(slider, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['aria-valuenow', 'aria-valuemin', 'aria-valuemax'],
  });
  signal.addEventListener('abort', () => {
    clearTimeout(reloadTimer);
    frameObserver.disconnect();
    panel.remove();
    band.remove();
    if (state.mounted?.render === render) state.mounted = null;
  }, { once: true });
  paintFramePosition();
  render();
  void load();

  // ---- Nâng cao dialog -------------------------------------------------------------------
  // Every mode, seeded with the panel's queued rows in order. Hủy/Esc leaves the panel's
  // queue as it was; Apply runs the whole batch through applyChange and empties the queue.
  function openEditor({ low, high }, seed) {
    const dialog = element('dialog', undefined, 'cvat-event-clear-dialog cvat-range-dialog');
    dialog.setAttribute('aria-label', 'Chỉnh tag nâng cao trong khoảng frame');
    const heading = element('header', undefined, 'cvat-range-heading');
    const title = element('h2', 'Chỉnh tag nâng cao');
    const range = element('span', 'Frame ' + low + ' → ' + high, 'cvat-range-summary');
    const size = element('span', (high - low + 1) + ' frame');
    heading.append(title, range, size);
    // Counts of the three events in the range: now, and after Apply when it differs.
    const stats = element('div', undefined, 'cvat-range-stats');
    stats.setAttribute('aria-label', 'Số tag event trong khoảng');
    const seedHint = element('small', 'Gồm ' + seed.length + ' thao tác đã xếp ở bảng nhanh. Hủy để giữ nguyên bảng.');
    seedHint.hidden = !seed.length;
    const orderHint = element('small', 'Các thao tác chạy theo thứ tự từ trên xuống; mỗi thao tác dùng kết quả của các thao tác phía trên.');
    orderHint.hidden = true;
    const rows = element('div', undefined, 'cvat-operation-list');
    const addOperation = button('+ Thêm thao tác', 'cvat-add-operation');
    addOperation.disabled = true;
    const status = element('p', 'Đang đọc tag…');
    status.setAttribute('role', 'status');
    const cancel = button('Hủy');
    const confirm = button('Áp dụng', 'cvat-event-primary');
    confirm.disabled = true;
    const actions = element('div', undefined, 'cvat-event-clear-actions');
    actions.append(cancel, confirm);
    const dialogFooter = element('footer', undefined, 'cvat-batch-footer');
    dialogFooter.append(status, actions);
    dialog.append(heading, stats, seedHint, orderHint, rows, addOperation, dialogFooter);
    document.body.append(dialog);
    dialog.showModal();

    let busy = false;
    let tags = [];
    let labels = [];
    let addFrames = [];
    let snapshotKey = '';
    let eventLabels = [];
    const editors = [];
    const close = () => dialog.close();
    jobSignal.addEventListener('abort', close, { once: true });
    dialog.addEventListener('close', () => {
      jobSignal.removeEventListener('abort', close);
      dialog.remove();
      state.mounted?.render();
      if (advanced.isConnected) advanced.focus({ preventScroll: true });
    }, { once: true });
    dialog.oncancel = (event) => { if (busy) event.preventDefault(); };
    for (const eventType of ['keydown', 'keypress', 'keyup']) {
      dialog.addEventListener(eventType, (event) => event.stopPropagation());
    }
    cancel.onclick = close;

    const modes = { replace: 'Đổi tag', all: 'Xóa toàn bộ tag trong khoảng', add: 'Thêm event', remove: 'Xóa tag đã chọn' };
    const nameOf = (id) => labels.find((label) => label.id === id)?.name ?? '#' + id;

    function renderStats(result) {
      const before = countCVATLabels(tags);
      const after = countCVATLabels(result.desired);
      stats.replaceChildren(...eventLabels.map(({ id, name }) => {
        const now = before.get(id) || 0;
        const next = after.get(id) || 0;
        const item = element('span', undefined, 'cvat-range-stat');
        item.dataset.labelId = id;
        item.append(element('span', name), element('strong', now === next ? String(now) : now + ' → ' + next));
        if (now !== next) item.dataset.changed = 'true';
        return item;
      }));
    }

    const plan = () => planCVATRangeBatch({ tags, low, high, addFrames, operations: editors.map((editor) => editor.read()) });
    function refresh() {
      orderHint.hidden = editors.length < 2;
      const result = plan();
      renderStats(result);
      editors.forEach((editor, index) => editor.render(index, result.steps[index]));
      const { add, replace, remove } = result.counts;
      status.textContent = 'Thêm ' + add + ' · Đổi ' + replace + ' · Xóa ' + remove + ' tag';
      if (!result.complete) status.textContent += ' · Hoàn tất các thao tác được đánh dấu.';
      confirm.disabled = busy || !result.complete || !(add || replace || remove);
      confirm.classList.toggle('cvat-event-danger', remove > 0 && !add && !replace);
      return result;
    }

    // Seeded rows arrive with their mode and labels; new cards start as "Đổi tag".
    function appendEditor(initialMode = 'replace', preset = null) {
      for (const editor of editors) editor.card.open = false;
      const card = element('details', undefined, 'cvat-operation-card');
      card.open = true;
      const summary = element('summary');
      const ordinal = element('span');
      const caption = element('span');
      summary.append(ordinal, caption);
      const fields = element('fieldset', undefined, 'cvat-operation-fields');
      const mode = element('select');
      for (const [value, name] of Object.entries(modes)) mode.add(new Option(name, value));
      mode.value = initialMode;
      const modeField = element('label', 'Thao tác');
      modeField.append(mode);
      const chips = element('div', undefined, 'cvat-range-chips cvat-source-chips');
      const source = element('fieldset');
      const legend = element('legend');
      source.append(legend, chips);
      const targetChips = element('div', undefined, 'cvat-range-chips cvat-target-chips');
      const targetField = element('fieldset');
      const targetLegend = element('legend');
      targetField.append(targetLegend, targetChips);
      const problem = element('p', undefined, 'cvat-operation-problem');
      problem.setAttribute('role', 'alert');
      const removeOperation = button('Bỏ thao tác');
      const selected = new Set(initialMode === 'remove' ? preset?.ids ?? [] : []);
      const targets = new Set(initialMode === 'add' ? preset?.ids ?? [] : []);
      fields.append(modeField, targetField, source, problem, removeOperation);
      card.append(summary, fields);
      rows.append(card);

      function chip(id, pressed, onToggle) {
        const node = button(nameOf(id));
        node.dataset.labelId = id;
        node.setAttribute('aria-pressed', String(pressed));
        node.disabled = busy;
        node.onclick = onToggle;
        return node;
      }

      const editor = {
        card, fields,
        read: () => ({
          mode: mode.value,
          sources: ['replace', 'remove'].includes(mode.value) ? [...selected] : [],
          targets: ['add', 'replace'].includes(mode.value) ? [...targets] : [],
        }),
        render(index, step) {
          const op = editor.read();
          const multiple = editors.length > 1;
          ordinal.textContent = 'Thao tác ' + (index + 1);
          const names = op.sources.map(nameOf).join(', ');
          const targetNames = op.targets.map(nameOf).join(', ');
          caption.textContent = op.mode === 'replace' && names && targetNames ? names + ' → ' + targetNames
            : modes[op.mode] + (op.mode === 'add' && targetNames ? ' · ' + targetNames : names ? ' · ' + names : '');
          summary.hidden = removeOperation.hidden = !multiple;
          if (!multiple) card.open = true;
          card.dataset.operation = op.mode;
          card.dataset.invalid = String(Boolean(step.problem));
          problem.textContent = step.problem || '';
          problem.hidden = !step.problem;

          // Targets: the three events. Add takes several, replace takes one.
          targetField.hidden = !['add', 'replace'].includes(op.mode);
          targetLegend.textContent = op.mode === 'add' ? 'Chọn event cần thêm' : 'Đổi thành';
          const focusTarget = targetChips.contains(document.activeElement) ? document.activeElement.dataset.labelId : null;
          targetChips.replaceChildren(...eventLabels.map(({ id }) => chip(id, targets.has(id), () => {
            if (targets.has(id)) targets.delete(id);
            else {
              if (mode.value === 'replace') targets.clear();
              targets.add(id);
            }
            refresh();
          })));
          if (!eventLabels.length) targetChips.append(element('span', 'Job không có nhãn ' + CVAT_EVENT_LABELS.join(', ') + '.'));
          if (focusTarget) targetChips.querySelector(`[data-label-id="${focusTarget}"]`)?.focus({ preventScroll: true });

          // Sources: the tags present at this step, i.e. after the operations above.
          source.hidden = !['replace', 'remove'].includes(op.mode);
          legend.textContent = op.mode === 'remove' ? 'Chọn tag cần xóa' : 'Chọn tag cần đổi';
          const focusSource = chips.contains(document.activeElement) ? document.activeElement.dataset.labelId : null;
          chips.replaceChildren(...[...new Set([...step.present.keys(), ...selected])].map((id) => chip(id, selected.has(id), () => {
            if (selected.has(id)) selected.delete(id);
            else {
              if (mode.value === 'replace') selected.clear();
              selected.add(id);
            }
            refresh();
          })));
          if (!chips.childElementCount) chips.append(element('span', 'Chưa có tag'));
          if (focusSource) chips.querySelector(`[data-label-id="${focusSource}"]`)?.focus({ preventScroll: true });
        },
      };
      editors.push(editor);
      mode.onchange = () => { selected.clear(); targets.clear(); refresh(); };
      removeOperation.onclick = () => {
        const index = editors.indexOf(editor);
        editors.splice(index, 1);
        card.remove();
        const adjacent = editors[Math.min(index, editors.length - 1)];
        adjacent.card.open = true;
        refresh();
        adjacent.fields.querySelector('select').focus();
      };
      refresh();
      if (editors.length > 1) mode.focus();
    }
    addOperation.onclick = () => appendEditor('replace');

    function lock(locked) {
      for (const editor of editors) editor.fields.disabled = locked;
      addOperation.disabled = cancel.disabled = locked;
      if (locked) confirm.disabled = true;
    }
    function loadSnapshot(snapshot) {
      tags = snapshot.tags;
      labels = snapshot.labels;
      eventLabels = CVAT_EVENT_LABELS.map((name) => labels.find((label) => label.name === name)).filter(Boolean);
      addFrames = snapshot.addFrames;
      snapshotKey = snapshot.key;
    }

    // All operations are combined into one final difference and applied in one go.
    confirm.onclick = async () => {
      if (confirm.disabled || busy) return;
      const change = refresh();
      if (!change.complete) return;
      busy = true;
      lock(true);
      status.textContent = 'Đang cập nhật tag trên trình duyệt…';
      try {
        const result = await applyChange({ low, high }, snapshotKey, change);
        busy = false;
        if (!dialog.open) return;
        if (result.stale) {
          loadSnapshot(result.snapshot);
          lock(false);
          refresh();
          status.textContent += ' · Dữ liệu vừa thay đổi. Kiểm tra lại rồi bấm Áp dụng.';
          return;
        }
        applied({ low, high }, change, result);
        close();
      } catch (error) {
        busy = false;
        if (jobSignal.aborted || !dialog.open) return;
        lock(false);
        refresh();
        status.textContent = error.message + ' Các thao tác vẫn được giữ để thử lại.';
      }
    };

    void (async () => {
      try {
        if (!await cvatEventBridge.ready()) throw new Error('CVAT chưa sẵn sàng cho extension. Đợi job tải xong rồi thử lại.');
        const snapshot = await cvatEventBridge.call('rangeSnapshot', { jobId: job.jobId, low, high }, 60000);
        if (!dialog.open) return;
        loadSnapshot(snapshot);
        addOperation.disabled = false;
        for (const row of seed) appendEditor(row.mode, row);
        appendEditor('replace');
      } catch (error) { if (dialog.open) status.textContent = error.message; }
    })();
  }
}
