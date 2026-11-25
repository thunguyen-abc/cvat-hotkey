'use strict';

// planCVATRangeEdit comes from range-plan.js; cvatEventBridge and
// describeCVATSave from bridge-client.js. The editor never calls the server: it reads and
// changes the annotations CVAT holds in the browser, and CVAT's own save uploads them.
function attachCVATRangeEditor(control, slider, anchor) {
  const { job, controller } = control;
  const signal = controller.signal;
  const key = 'cvat-event-range:' + job.jobId;
  const marks = { start: null, end: null };
  try {
    const stored = JSON.parse(sessionStorage.getItem(key));
    for (const name of ['start', 'end']) if (Number.isInteger(stored?.[name])) marks[name] = stored[name];
  } catch { /* Storage may be unavailable. */ }

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function button(text) {
    const node = element('button', text, 'ant-btn ant-btn-default ant-btn-sm');
    node.type = 'button';
    return node;
  }

  const group = element('div', undefined, 'cvat-range-buttons');
  const start = button('Start');
  const end = button('End');
  const edit = button('Edit');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Chọn khoảng frame');
  start.title = 'Đặt frame hiện tại làm mốc đầu';
  end.title = 'Đặt frame hiện tại làm mốc cuối';
  edit.classList.add('cvat-event-primary');
  group.append(start, end, edit);
  anchor.append(group);
  const band = element('div', undefined, 'cvat-range-band');
  slider.append(band);
  const frame = (attribute) => {
    const raw = slider.querySelector('[role="slider"]')?.getAttribute('aria-value' + attribute);
    return raw == null ? NaN : Number(raw);
  };
  function paint() {
    const min = frame('min');
    const max = frame('max');
    const valid = (value) => Number.isInteger(value) && value >= min && value <= max;
    const points = [marks.start, marks.end].filter(valid);
    edit.disabled = points.length !== 2;
    edit.title = edit.disabled ? 'Chọn cả Start và End để chỉnh tag' : 'Chỉnh tag trong khoảng đã chọn';
    start.dataset.marked = String(valid(marks.start));
    end.dataset.marked = String(valid(marks.end));
    start.textContent = valid(marks.start) ? 'Start ' + marks.start : 'Start';
    end.textContent = valid(marks.end) ? 'End ' + marks.end : 'End';
    band.hidden = !points.length;
    if (points.length) {
      const span = Math.max(1, max - min);
      band.style.left = ((Math.min(...points) - min) * 100 / span) + '%';
      band.style.width = (max === min ? 100 : (Math.max(...points) - Math.min(...points)) * 100 / span) + '%';
    }
  }
  function mark(name) {
    const current = frame('now');
    if (!Number.isInteger(current)) return;
    marks[name] = current;
    try { sessionStorage.setItem(key, JSON.stringify(marks)); } catch { /* Optional persistence. */ }
    paint();
  }
  function resetMarks() {
    marks.start = null;
    marks.end = null;
    try { sessionStorage.removeItem(key); } catch { /* Optional persistence. */ }
    paint();
  }
  start.onclick = () => mark('start');
  end.onclick = () => mark('end');
  edit.onclick = () => {
    if (!control.button.disabled) openEditor(Math.min(marks.start, marks.end), Math.max(marks.start, marks.end));
  };
  signal.addEventListener('abort', () => { group.remove(); band.remove(); }, { once: true });
  paint();

  function openEditor(low, high) {
    const dialog = element('dialog', undefined, 'cvat-event-clear-dialog cvat-range-dialog');
    dialog.setAttribute('aria-label', 'Chỉnh tag trong khoảng frame');
    const heading = element('header', undefined, 'cvat-range-heading');
    const title = element('h2', 'Chỉnh tag theo khoảng');
    const range = element('span', 'Frame ' + low + ' → ' + high, 'cvat-range-summary');
    const length = element('span', (high - low + 1) + ' frame');
    heading.append(title, range, length);
    const mode = element('select');
    for (const [value, name] of [['add','Thêm tag'], ['replace','Đổi tag'], ['remove','Xóa tag đã chọn'], ['all','Xóa toàn bộ tag trong khoảng']]) {
      mode.add(new Option(name, value));
    }
    const modeField = element('label', 'Thao tác');
    modeField.append(mode);
    const chips = element('div', undefined, 'cvat-range-chips');
    const sourceField = element('fieldset');
    sourceField.append(element('legend', 'Tag hiện có trong khoảng'), chips);
    const targetField = element('label', 'Tag đích');
    const target = element('select');
    targetField.append(target);
    const info = element('p', 'Đang đọc tag…');
    info.setAttribute('role', 'status');
    const cancel = button('Hủy');
    const apply = button('Áp dụng');
    apply.classList.add('cvat-event-primary');
    apply.disabled = true;
    const actions = element('div', undefined, 'cvat-event-clear-actions');
    actions.append(cancel, apply);
    dialog.append(heading, modeField, sourceField, targetField, info, actions);
    document.body.append(dialog);
    dialog.showModal();
    let busy = false;
    let tags = [];
    let labels = [];
    let addFrames = [];
    let snapshotKey = '';
    const selected = new Set();
    const close = () => dialog.close();
    signal.addEventListener('abort', close, { once: true });
    dialog.addEventListener('close', () => {
      signal.removeEventListener('abort', close);
      dialog.remove();
    }, { once: true });
    dialog.oncancel = (event) => { if (busy) event.preventDefault(); };
    for (const eventType of ['keydown', 'keypress', 'keyup']) {
      dialog.addEventListener(eventType, (event) => event.stopPropagation());
    }
    cancel.onclick = close;

    function request() {
      const targetId = target.value ? Number(target.value) : null;
      return {
        jobId: job.jobId, low, high, mode: mode.value, sources: [...selected],
        targetId: ['add', 'replace'].includes(mode.value) ? targetId : null,
      };
    }
    function plan() {
      const { mode: operation, sources, targetId } = request();
      if (['add', 'replace'].includes(operation) && targetId === null) return null;
      return planCVATRangeEdit({ tags, low, high, addFrames, mode: operation, sources, targetId });
    }
    function preview() {
      const counts = plan()?.counts ?? { add: 0, replace: 0, remove: 0 };
      info.textContent = 'Thêm ' + counts.add + ' · Đổi ' + counts.replace + ' · Xóa ' + counts.remove + ' tag';
      apply.disabled = busy || !(counts.add || counts.replace || counts.remove);
    }
    function display() {
      const present = new Map();
      for (const tag of tags) present.set(tag.labelId, (present.get(tag.labelId) || 0) + 1);
      for (const id of [...selected]) if (!present.has(id)) selected.delete(id);
      const selectable = ['remove', 'replace'].includes(mode.value);
      sourceField.querySelector('legend').textContent = mode.value === 'remove' ? 'Chọn tag cần xóa'
        : mode.value === 'replace' ? 'Chọn tag cần đổi' : 'Tag hiện có trong khoảng';
      dialog.dataset.operation = mode.value;
      apply.classList.toggle('cvat-event-danger', ['all', 'remove'].includes(mode.value));
      targetField.hidden = !['add', 'replace'].includes(mode.value);
      chips.replaceChildren();
      if (!present.size) chips.append(element('span', 'Chưa có tag'));
      for (const [id, count] of present) {
        const name = labels.find((label) => label.id === id)?.name ?? '#' + id;
        const chip = button(name);
        chip.append(element('span', String(count), 'cvat-range-count'));
        chip.setAttribute('aria-label', name + ' · ' + count);
        chip.disabled = !selectable;
        chip.setAttribute('aria-pressed', String(selected.has(id)));
        chip.dataset.labelId = id;
        chip.onclick = () => {
          if (selected.has(id)) selected.delete(id);
          else {
            if (mode.value === 'replace') selected.clear();
            selected.add(id);
          }
          for (const node of chips.children) {
            node.setAttribute('aria-pressed', String(selected.has(Number(node.dataset.labelId))));
          }
          preview();
        };
        chips.append(chip);
      }
      preview();
    }
    function load(snapshot) {
      tags = snapshot.tags;
      labels = snapshot.labels;
      addFrames = snapshot.addFrames;
      snapshotKey = snapshot.key;
    }
    mode.onchange = () => { selected.clear(); display(); };
    target.onchange = preview;

    apply.onclick = async () => {
      if (apply.disabled || busy) return;
      const change = plan();
      if (!change) return;
      busy = true;
      for (const node of dialog.querySelectorAll('select, button')) node.disabled = true;
      info.textContent = 'Đang cập nhật tag trên trình duyệt…';
      try {
        const { targetId } = request();
        const result = await cvatEventBridge.call('applyRange', {
          jobId: job.jobId, low, high, key: snapshotKey, targetId,
          create: change.create, remove: change.delete.map((item) => item.clientID),
        }, 120000);
        busy = false;
        if (result.stale) {
          load(result.snapshot);
          mode.disabled = target.disabled = cancel.disabled = false;
          display();
          info.textContent += ' · Dữ liệu vừa thay đổi. Kiểm tra lại rồi bấm Áp dụng.';
          return;
        }
        const { add, replace, remove } = change.counts;
        control.status.textContent = 'Frame ' + low + '–' + high + ': thêm ' + add + ', đổi ' + replace + ', xóa ' + remove +
          ' tag. ' + describeCVATSave(result.save);
        resetMarks();
        close();
      } catch (error) {
        if (signal.aborted) return;
        busy = false;
        mode.disabled = target.disabled = cancel.disabled = false;
        display();
        info.textContent = error.message + ' Khoảng frame và lựa chọn vẫn được giữ để thử lại.';
      }
    };

    mode.disabled = target.disabled = true;
    void (async () => {
      try {
        if (!await cvatEventBridge.ready()) throw new Error('CVAT chưa sẵn sàng cho extension. Đợi job tải xong rồi thử lại.');
        const snapshot = await cvatEventBridge.call('rangeSnapshot', { jobId: job.jobId, low, high }, 60000);
        if (!dialog.open) return;
        load(snapshot);
        target.add(new Option('Chọn tag…', ''));
        for (const label of labels) target.add(new Option(label.name, String(label.id)));
        mode.disabled = target.disabled = false;
        display();
      } catch (error) { if (dialog.open) info.textContent = error.message; }
    })();
  }
}
