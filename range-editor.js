'use strict';

// planCVATRangeBatch, countCVATLabels and CVAT_EVENT_LABELS come from range-plan.js;
// cvatEventBridge and describeCVATSave from bridge-client.js. The editor never calls the
// server: it reads and changes the annotations CVAT holds in the browser, and CVAT's own
// save uploads them.
//
// Each event has one pending direction in Quickstart. Advanced can compose sequential steps.
const CVAT_RANGE_COLLAPSED = 'cvat-event-range-collapsed';

function attachCVATRangeEditor(control, slider, anchor) {
  const { job } = control;
  const jobSignal = control.controller.signal;
  // One mount per slider/anchor. A remount in the same job removes the old panel, band and
  // key listeners first; the job's marks, event actions and snapshot stay on control.
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
    return { marks, eventActions: new Map(), snapshot: null, loading: null, error: null,
      notice: '', busy: false, mounted: null };
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
  const top = element('div', undefined, 'cvat-quick-top');
  const head = element('div', undefined, 'cvat-quick-head');
  const frameCounter = element('div', undefined, 'cvat-quick-frame');
  const framePosition = element('strong', '—', 'cvat-quick-frame-position');
  frameCounter.append(element('span', 'Frame'), framePosition);
  const progress = element('span', undefined, 'cvat-quick-progress');
  progress.setAttribute('aria-hidden', 'true');
  frameCounter.append(progress);
  const start = button('Start', 'cvat-quick-start');
  const end = button('End', 'cvat-quick-end');
  const startValue = element('strong');
  const endValue = element('strong');
  start.append(startValue);
  end.append(endValue);
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
  const selectAll = button('Select All', 'cvat-quick-select-all');
  selectAll.title = 'Đặt Start và End theo toàn bộ job (Ctrl+A trong Tag annotation)';
  selectAll.setAttribute('aria-keyshortcuts', 'Control+A');
  marks.append(start, end, selectAll);
  top.append(head, marks);
  const events = element('div', undefined, 'cvat-quick-events');
  const eventButtons = [];
  for (const mode of ['add', 'remove']) {
    const adding = mode === 'add';
    const verb = adding ? 'Thêm' : 'Xóa';
    const row = element('div', undefined, 'cvat-quick-event-row');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', verb + ' event');
    const sign = element('span', adding ? '+' : '−', 'cvat-quick-sign');
    sign.setAttribute('aria-hidden', 'true');
    row.append(sign);
    CVAT_EVENT_LABELS.forEach((name, index) => {
      const node = button(displayCVATLabel(name), 'cvat-quick-event');
      const shortcut = (adding ? 'Alt+' : 'Alt+Shift+') + (index + 1);
      node.translate = false;
      node.dataset.event = name;
      node.dataset.mode = mode;
      node.setAttribute('aria-label', verb + ' ' + name);
      node.setAttribute('aria-keyshortcuts', shortcut);
      node.onclick = () => toggleEvent(name, mode);
      row.append(node);
      eventButtons.push(node);
    });
    events.append(row);
  }
  const footer = element('div', undefined, 'cvat-quick-footer');
  const info = element('span', undefined, 'cvat-quick-info');
  info.setAttribute('role', 'status');
  const apply = button('Áp dụng', 'cvat-quick-apply');
  apply.title = 'Áp dụng cho khoảng đã đánh dấu (Enter)';
  footer.append(length, info, apply);
  body.append(events, footer);
  panel.append(top, body);
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
  // Resolve the draft by label name against this snapshot; the dialog gets its own copy.
  function draftRows(snapshot) {
    const ids = eventIdsOf(snapshot);
    return ['add', 'remove'].map((mode) => ({
      mode,
      ids: ids.filter((id, index) => id !== null && state.eventActions.get(CVAT_EVENT_LABELS[index]) === mode),
    })).filter((row) => row.ids.length);
  }
  function draftPlan(range, snapshot) {
    const ops = draftRows(snapshot).map(({ mode, ids }) => mode === 'add'
      ? { mode, targets: ids } : { mode, sources: ids });
    return planFor(range, snapshot, ops);
  }
  const staleNotice = 'Tag vừa thay đổi. Kiểm tra lại rồi bấm Áp dụng.';
  const planFor = (range, snapshot, ops) => planCVATRangeBatch({
    tags: snapshot.tags, low: range.low, high: range.high, addFrames: snapshot.addFrames, operations: ops,
  });

  function paintFramePosition() {
    const current = frame('now');
    const min = frame('min');
    const max = frame('max');
    const ready = [current, min, max].every(Number.isInteger) && current >= min && current <= max;
    selectAll.disabled = controlsLocked() || !Number.isInteger(min) || !Number.isInteger(max) || min > max;
    const position = ready ? (current - min) + '/' + (max - min + 1) : '—';
    progress.style.setProperty('--position', (ready ? 100 * (current - min) / Math.max(1, max - min) : 0) + '%');
    frameCounter.title = ready ? 'Frame ' + current + ' · Vị trí trong job tính từ 0' : '';
    if (framePosition.textContent !== position) framePosition.textContent = position;
  }

  function paint() {
    const min = frame('min');
    const max = frame('max');
    const points = [state.marks.start, state.marks.end].filter(validMark);
    start.dataset.marked = String(validMark(state.marks.start));
    end.dataset.marked = String(validMark(state.marks.end));
    startValue.textContent = validMark(state.marks.start) ? ' ' + state.marks.start : '';
    endValue.textContent = validMark(state.marks.end) ? ' ' + state.marks.end : '';
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
    if (!sameRange(state.loading, range)) state.loading = null;
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
    if (snapshot) {
      const previous = snapshotFor(range);
      if (state.eventActions.size && previous && previous.key !== snapshot.key) state.notice = staleNotice;
      state.snapshot = { ...snapshot, ...range };
    } else {
      state.snapshot = null;
      state.error = error;
    }
    state.mounted?.render();
  }

  function render() {
    if (signal.aborted) return;
    paint();
    const range = currentRange();
    const snapshot = snapshotFor(range);
    const loading = sameRange(state.loading, range);
    const locked = controlsLocked();
    const ready = Boolean(snapshot) && !loading && !locked;
    start.disabled = end.disabled = toggle.disabled = locked;
    paintFramePosition();
    length.textContent = range ? (range.high - range.low + 1) + ' frame' : '';
    advanced.disabled = !ready;
    advanced.title = range ? 'Đổi tag, xóa toàn bộ tag trong khoảng và các thao tác khác' : 'Chọn Start và End';
    for (const node of eventButtons) {
      const { event: name, mode } = node.dataset;
      const action = state.eventActions.get(name);
      const missing = snapshot && !snapshot.labels.some((label) => label.name === name);
      const opposite = Boolean(action && action !== mode);
      node.disabled = !ready || missing || opposite;
      node.dataset.missing = String(Boolean(missing));
      node.setAttribute('aria-pressed', String(!missing && action === mode));
      node.title = missing ? 'Job không có nhãn ' + name : opposite ? 'Bỏ chọn ở hàng đối diện trước'
        : node.getAttribute('aria-label') + ' (' + node.getAttribute('aria-keyshortcuts') + ')';
    }
    const plan = ready && state.eventActions.size ? draftPlan(range, snapshot) : null;
    apply.disabled = !plan?.complete || !(plan.create.length || plan.delete.length);
    apply.setAttribute('aria-busy', String(state.busy));
    apply.setAttribute('aria-label', state.busy ? 'Đang áp dụng' : 'Áp dụng');
    info.textContent = state.error || state.notice || '';
    info.title = info.textContent;
  }

  function controlsLocked() {
    return state.busy || control.button.disabled || control.clearButton.disabled;
  }
  // ---- Actions (shared by mouse and keys) ------------------------------------------------
  function mark(name) {
    const current = frame('now');
    if (!validMark(current) || controlsLocked()) return;
    setMarks({ ...state.marks, [name]: current });
  }
  function markAll() {
    const start = frame('min');
    const end = frame('max');
    if (validMark(start) && validMark(end) && !controlsLocked()) setMarks({ start, end });
  }
  function setMarks(next) {
    const before = currentRange();
    if (state.eventActions.size && !sameRange(before, currentRange(next))) {
      const question = 'Bỏ ' + state.eventActions.size + ' lựa chọn chưa áp dụng của frame ' + state.marks.start + '–' +
        state.marks.end + ' để đặt khoảng mới?';
      if (!window.confirm(question)) return;
      state.eventActions.clear();
    }
    state.marks = next;
    try { sessionStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Optional persistence. */ }
    state.notice = '';
    void load();
  }
  function toggleEvent(name, mode) {
    const range = currentRange();
    const snapshot = snapshotFor(range);
    if (controlsLocked() || sameRange(state.loading, range) ||
        !snapshot?.labels.some((label) => label.name === name)) return;
    const current = state.eventActions.get(name);
    if (current && current !== mode) return;
    if (current === mode) state.eventActions.delete(name);
    else state.eventActions.set(name, mode);
    state.notice = '';
    render();
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
  function applied() {
    state.eventActions.clear();
    state.notice = '';
    void state.mounted?.load(true);
  }

  let applying = false;
  async function applyQuick() {
    if (apply.disabled || applying) return;
    const range = currentRange();
    const snapshot = snapshotFor(range);
    const change = draftPlan(range, snapshot);
    if (!change.complete || !(change.create.length || change.delete.length)) return;
    applying = true;
    try {
      const result = await applyChange(range, snapshot.key, change);
      if (jobSignal.aborted) return;
      if (result.stale) {
        state.snapshot = { ...result.snapshot, ...range };
        state.notice = staleNotice;
      } else {
        applied();
      }
    } catch (error) {
      if (jobSignal.aborted) return;
      state.notice = error.message;
    } finally {
      applying = false;
      state.mounted?.render();
    }
  }

  start.onclick = () => mark('start');
  end.onclick = () => mark('end');
  selectAll.onclick = markAll;
  apply.onclick = () => { void applyQuick(); };
  advanced.onclick = () => {
    const range = currentRange();
    if (!advanced.disabled && !control.button.disabled) openEditor(range, draftRows(snapshotFor(range)));
  };

  // ---- Keys ------------------------------------------------------------------------------
  // Alt+slot selects add, Alt+Shift+slot selects remove. Bare slots belong to CVAT.
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
    if (event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey && key.toLowerCase() === 'a' &&
        !selectAll.disabled && !event.target?.isContentEditable && !window.getSelection()?.toString()) return markAll;
    if (collapsed) return null;
    const slot = /^(?:Digit|Numpad)([1-3])$/.exec(code)?.[1];
    if (slot && event.altKey && !event.ctrlKey && !event.metaKey && snapshotFor(currentRange())) {
      return () => toggleEvent(CVAT_EVENT_LABELS[Number(slot) - 1], event.shiftKey ? 'remove' : 'add');
    }
    if (modified) return null;
    if (key === 'Enter' && !event.shiftKey && !(event.target instanceof Element && event.target.closest(ownControls))) {
      return state.busy || !apply.disabled ? () => { void applyQuick(); } : null;
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
  const lockObserver = new MutationObserver(render);
  for (const node of [control.button, control.clearButton]) lockObserver.observe(node, { attributeFilter: ['disabled'] });
  // Follow the player during navigation or playback without replanning the draft or reading tags.
  const frameObserver = new MutationObserver(paintFramePosition);
  frameObserver.observe(slider, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['aria-valuenow', 'aria-valuemin', 'aria-valuemax'],
  });
  signal.addEventListener('abort', () => {
    clearTimeout(reloadTimer);
    frameObserver.disconnect();
    lockObserver.disconnect();
    panel.remove();
    band.remove();
    if (state.mounted?.render === render) state.mounted = null;
  }, { once: true });
  paintFramePosition();
  render();
  void load();

  // ---- Nâng cao dialog -------------------------------------------------------------------
  // Advanced owns an ordered copy of the draft. Cancel leaves the panel selection intact.
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
    const seedHint = element('small', 'Gồm ' + seed.length + ' thao tác từ bảng nhanh.');
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
        item.title = name;
        item.append(element('span', displayCVATLabel(name)), element('strong', now === next ? String(now) : now + ' → ' + next));
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
        const node = button(displayCVATLabel(nameOf(id)));
        node.title = nameOf(id);
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
          const names = op.sources.map(nameOf).map(displayCVATLabel).join(', ');
          const targetNames = op.targets.map(nameOf).map(displayCVATLabel).join(', ');
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
        applied();
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
