'use strict';

// planCVATRangeBatch comes from range-plan.js; cvatEventBridge and
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
    const orderHint = element('small', 'Các thao tác chạy theo thứ tự từ trên xuống; mỗi thao tác dùng kết quả của các thao tác phía trên.');
    orderHint.hidden = true;
    const rows = element('div', undefined, 'cvat-operation-list');
    const addOperation = button('+ Thêm thao tác');
    addOperation.classList.add('cvat-add-operation');
    addOperation.disabled = true;
    const info = element('p', 'Đang đọc tag…');
    info.setAttribute('role', 'status');
    const cancel = button('Hủy');
    const apply = button('Áp dụng');
    apply.classList.add('cvat-event-primary');
    apply.disabled = true;
    const actions = element('div', undefined, 'cvat-event-clear-actions');
    actions.append(cancel, apply);
    const footer = element('footer', undefined, 'cvat-batch-footer');
    footer.append(info, actions);
    dialog.append(heading, orderHint, rows, addOperation, footer);
    document.body.append(dialog);
    dialog.showModal();

    let busy = false;
    let tags = [];
    let labels = [];
    let addFrames = [];
    let snapshotKey = '';
    const editors = [];
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

    const modes = { add: 'Thêm tag', replace: 'Đổi tag', remove: 'Xóa tag đã chọn', all: 'Xóa toàn bộ tag trong khoảng' };
    const nameOf = (id) => labels.find((label) => label.id === id)?.name ?? '#' + id;

    function plan() {
      return planCVATRangeBatch({ tags, low, high, addFrames, operations: editors.map((editor) => editor.read()) });
    }
    function refresh() {
      orderHint.hidden = editors.length < 2;
      const result = plan();
      editors.forEach((editor, index) => editor.render(index, result.steps[index]));
      const { add, replace, remove } = result.counts;
      info.textContent = 'Thêm ' + add + ' · Đổi ' + replace + ' · Xóa ' + remove + ' tag';
      if (!result.complete) info.textContent += ' · Hoàn tất các thao tác được đánh dấu.';
      apply.disabled = busy || !result.complete || !(add || replace || remove);
      apply.classList.toggle('cvat-event-danger', remove > 0 && !add && !replace);
      return result;
    }

    function appendEditor() {
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
      const modeField = element('label', 'Thao tác');
      modeField.append(mode);
      const chips = element('div', undefined, 'cvat-range-chips');
      const source = element('fieldset');
      const legend = element('legend');
      source.append(legend, chips);
      const target = element('select');
      target.add(new Option('Chọn tag…', ''));
      for (const label of labels) target.add(new Option(label.name, String(label.id)));
      const targetField = element('label', 'Tag đích');
      targetField.append(target);
      const problem = element('p', undefined, 'cvat-operation-problem');
      problem.setAttribute('role', 'alert');
      const removeOperation = button('Bỏ thao tác');
      const selected = new Set();
      fields.append(modeField, source, targetField, problem, removeOperation);
      card.append(summary, fields);
      rows.append(card);

      const editor = {
        card, fields,
        read: () => ({
          mode: mode.value,
          sources: [...selected],
          targetId: ['add', 'replace'].includes(mode.value) && target.value ? Number(target.value) : null,
        }),
        render(index, step) {
          const op = editor.read();
          const multiple = editors.length > 1;
          ordinal.textContent = 'Thao tác ' + (index + 1);
          const names = op.sources.map(nameOf).join(', ');
          const targetName = op.targetId === null ? '' : nameOf(op.targetId);
          caption.textContent = op.mode === 'replace' && names && targetName ? names + ' → ' + targetName
            : modes[op.mode] + (op.mode === 'add' && targetName ? ' · ' + targetName : names ? ' · ' + names : '');
          summary.hidden = removeOperation.hidden = !multiple;
          if (!multiple) card.open = true;
          card.dataset.operation = op.mode;
          card.dataset.invalid = String(Boolean(step.problem));
          problem.textContent = step.problem || '';
          problem.hidden = !step.problem;
          const selectable = ['replace', 'remove'].includes(op.mode);
          legend.textContent = op.mode === 'remove' ? 'Chọn tag cần xóa'
            : op.mode === 'replace' ? 'Chọn tag cần đổi' : 'Tag hiện có trong khoảng';
          targetField.hidden = !['add', 'replace'].includes(op.mode);
          // Chips show the tags present at this step, i.e. after the operations above.
          const focusId = chips.contains(document.activeElement) ? document.activeElement.dataset.labelId : null;
          chips.replaceChildren();
          for (const id of new Set([...step.present.keys(), ...selected])) {
            const count = step.present.get(id) || 0;
            const chip = button(nameOf(id));
            chip.append(element('span', String(count), 'cvat-range-count'));
            chip.dataset.labelId = id;
            chip.setAttribute('aria-label', nameOf(id) + ' · ' + count);
            chip.setAttribute('aria-pressed', String(selected.has(id)));
            chip.disabled = busy || !selectable;
            chip.onclick = () => {
              if (selected.has(id)) selected.delete(id);
              else {
                if (mode.value === 'replace') selected.clear();
                selected.add(id);
              }
              refresh();
            };
            chips.append(chip);
            if (String(id) === focusId) chip.focus({ preventScroll: true });
          }
          if (!chips.childElementCount) chips.append(element('span', 'Chưa có tag'));
        },
      };
      editors.push(editor);
      mode.onchange = () => { selected.clear(); target.value = ''; refresh(); };
      target.onchange = refresh;
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
    addOperation.onclick = appendEditor;

    function lock(locked) {
      for (const editor of editors) editor.fields.disabled = locked;
      addOperation.disabled = cancel.disabled = locked;
      if (locked) apply.disabled = true;
    }
    function load(snapshot) {
      tags = snapshot.tags;
      labels = snapshot.labels;
      addFrames = snapshot.addFrames;
      snapshotKey = snapshot.key;
    }

    // All operations are combined into one final difference and applied in one go.
    apply.onclick = async () => {
      if (apply.disabled || busy) return;
      const change = refresh();
      if (!change.complete) return;
      busy = true;
      lock(true);
      info.textContent = 'Đang cập nhật tag trên trình duyệt…';
      try {
        const result = await cvatEventBridge.call('applyRange', {
          jobId: job.jobId, low, high, key: snapshotKey,
          create: change.create, remove: change.delete.map((item) => item.clientID),
        }, 120000);
        busy = false;
        if (result.stale) {
          load(result.snapshot);
          lock(false);
          refresh();
          info.textContent += ' · Dữ liệu vừa thay đổi. Kiểm tra lại rồi bấm Áp dụng.';
          return;
        }
        const { add, replace, remove } = change.counts;
        control.status.textContent = 'Frame ' + low + '–' + high + ': thêm ' + add + ', đổi ' + replace + ', xóa ' + remove +
          ' tag. ' + describeCVATSave(result.save);
        // Start/End stay marked (and highlighted) for the next edit; Complete & Next clears them.
        paint();
        close();
      } catch (error) {
        if (signal.aborted) return;
        busy = false;
        lock(false);
        refresh();
        info.textContent = error.message + ' Các thao tác vẫn được giữ để thử lại.';
      }
    };

    void (async () => {
      try {
        if (!await cvatEventBridge.ready()) throw new Error('CVAT chưa sẵn sàng cho extension. Đợi job tải xong rồi thử lại.');
        const snapshot = await cvatEventBridge.call('rangeSnapshot', { jobId: job.jobId, low, high }, 60000);
        if (!dialog.open) return;
        load(snapshot);
        addOperation.disabled = false;
        appendEditor();
      } catch (error) { if (dialog.open) info.textContent = error.message; }
    })();
  }
}
