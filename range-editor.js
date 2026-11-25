'use strict';

// Build the exact tag-only mutations. Existing destination tags are never toggled.
function planCVATRangeEdit(tags, frames, mode, sources, target) {
  const scope = new Set(frames);
  const inRange = tags.filter((tag) => scope.has(tag.frame));
  const destinationFrames = new Set(inRange.filter((tag) => tag.label_id === target?.id).map((tag) => tag.frame));
  const changes = { create: [], update: [], delete: [] };
  const attributes = () => (target.attributes || []).map((attribute) => ({
    spec_id: attribute.id, value: String(attribute.default_value ?? ''),
  }));
  if (mode === 'add') {
    for (const frame of frames) {
      if (!destinationFrames.has(frame)) changes.create.push({
        frame, label_id: target.id, source: 'manual', group: 0, attributes: attributes(),
      });
    }
  } else {
    for (const tag of inRange) {
      if (mode === 'all' || (mode === 'remove' && sources.has(tag.label_id))) {
        changes.delete.push(tag);
      } else if (mode === 'replace' && sources.has(tag.label_id) && tag.label_id !== target.id) {
        if (destinationFrames.has(tag.frame)) changes.delete.push(tag);
        else {
          changes.update.push({ ...tag, label_id: target.id, attributes: attributes() });
          destinationFrames.add(tag.frame);
        }
      }
    }
  }
  return changes;
}

function attachCVATRangeEditor(control, slider, anchor, api) {
  const { job, controller } = control;
  const signal = controller.signal;
  const base = '/api/jobs/' + job.jobId;
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

  async function loadLabels() {
    const labels = [];
    for (let page = 1; ; page++) {
      const data = await api.getJSON('/api/labels?job_id=' + job.jobId + '&page_size=100&page=' + page, signal);
      labels.push(...data.results.filter((label) => ['any', 'tag'].includes(label.type)));
      if (!data.next) return labels;
    }
  }

  function openEditor(low, high) {
    const dialog = element('dialog', undefined, 'cvat-event-clear-dialog cvat-range-dialog');
    dialog.setAttribute('aria-label', 'Chỉnh tag trong khoảng frame');
    const title = element('h2', 'Chỉnh tag · frame ' + low + ' – ' + high);
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
    apply.disabled = true;
    const actions = element('div', undefined, 'cvat-event-clear-actions');
    actions.append(cancel, apply);
    dialog.append(title, modeField, sourceField, targetField, info, actions);
    document.body.append(dialog);
    dialog.showModal();
    let busy = false;
    let needsReload = false;
    let tags = [];
    let labels = [];
    let frames = [];
    let addFrames = [];
    const selected = new Set();
    const close = () => dialog.close();
    signal.addEventListener('abort', close, { once: true });
    dialog.addEventListener('close', () => {
      signal.removeEventListener('abort', close);
      dialog.remove();
    }, { once: true });
    dialog.oncancel = (event) => { if (busy || needsReload) event.preventDefault(); };
    for (const eventType of ['keydown', 'keypress', 'keyup']) {
      dialog.addEventListener(eventType, (event) => event.stopPropagation());
    }
    function reload() {
      const url = new URL(location.href);
      url.searchParams.set('frame', String(frame('now')));
      location.replace(url.href);
    }
    cancel.onclick = () => needsReload ? reload() : close();

    function plan(input) {
      const label = labels.find((item) => String(item.id) === target.value);
      if (['add', 'replace'].includes(mode.value) && !label) return null;
      return planCVATRangeEdit(input, mode.value === 'add' ? addFrames : frames, mode.value, selected, label);
    }
    function preview() {
      const change = plan(tags);
      const counts = change ? [change.create.length, change.update.length, change.delete.length] : [0, 0, 0];
      info.textContent = 'Thêm ' + counts[0] + ' · Đổi ' + counts[1] + ' · Xóa ' + counts[2] + ' tag';
      apply.disabled = !counts.some(Boolean);
    }
    function display() {
      const present = new Map();
      for (const tag of tags) if (tag.frame >= low && tag.frame <= high) {
        present.set(tag.label_id, (present.get(tag.label_id) || 0) + 1);
      }
      const selectable = ['remove', 'replace'].includes(mode.value);
      targetField.hidden = !['add', 'replace'].includes(mode.value);
      chips.replaceChildren();
      if (!present.size) chips.append(element('span', 'Chưa có tag'));
      for (const [id, count] of present) {
        const chip = button((labels.find((label) => label.id === id)?.name ?? '#' + id) + ' · ' + count);
        chip.disabled = !selectable;
        chip.setAttribute('aria-pressed', String(selected.has(id)));
        chip.onclick = () => {
          if (selected.has(id)) selected.delete(id);
          else {
            if (mode.value === 'replace') selected.clear();
            selected.add(id);
          }
          display();
        };
        chips.append(chip);
      }
      preview();
    }
    mode.onchange = () => { selected.clear(); display(); };
    target.onchange = preview;
    const endpoint = base + '/annotations';
    async function patch(action, batch, version) {
      const csrf = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('csrftoken='));
      if (!csrf) throw new Error('Hãy đăng nhập lại vào CVAT.');
      const result = await fetch(endpoint + '?action=' + action, {
        method: 'PATCH', credentials: 'same-origin', redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
        headers: { Accept: 'application/vnd.cvat+json', 'Content-Type': 'application/json',
          'X-CSRFTOKEN': decodeURIComponent(csrf.slice(10)) },
        body: JSON.stringify({ version, tags: batch, shapes: [], tracks: [] }),
      });
      if (!result.ok) throw new Error('CVAT HTTP ' + result.status);
      return (await result.json()).version;
    }
    apply.onclick = async () => {
      if (apply.disabled || busy) return;
      const initial = plan(tags);
      busy = true;
      for (const node of dialog.querySelectorAll('select, button')) node.disabled = true;
      try {
        info.textContent = 'Đang lưu các chỉnh sửa hiện tại…';
        await api.saveCurrentAnnotations(signal);
        const fresh = await api.readTags(endpoint, signal);
        const change = plan(fresh.tags);
        if (JSON.stringify(initial) !== JSON.stringify(change)) {
          tags = fresh.tags;
          mode.disabled = target.disabled = cancel.disabled = false;
          display();
          info.textContent += ' · Dữ liệu đã thay đổi. Kiểm tra lại rồi bấm Áp dụng.';
          return;
        }
        let version = fresh.version;
        for (const action of ['create', 'update', 'delete']) {
          if (!change[action].length) continue;
          signal.throwIfAborted();
          needsReload = true;
          version = await patch(action, change[action], version);
        }
        const result = await api.readTags(endpoint, signal);
        const pending = plan(result.tags);
        if (Object.values(pending).some((batch) => batch.length)) throw new Error('Khoảng frame vẫn còn thay đổi cần kiểm tra.');
        reload();
      } catch (error) {
        if (signal.aborted) return;
        info.textContent = error.message;
        cancel.disabled = false;
        if (needsReload) cancel.textContent = 'Tải lại job';
        else { mode.disabled = target.disabled = false; display(); info.textContent = error.message; }
      } finally { busy = false; }
    };
    mode.disabled = target.disabled = true;
    void (async () => {
      try {
        info.textContent = 'Đang lưu các chỉnh sửa để đọc đủ tag trong khoảng…';
        await api.saveCurrentAnnotations(signal);
        if (!dialog.open) return;
        const [snapshot, options, meta] = await Promise.all([
          api.readTags(endpoint, signal), loadLabels(), api.getJSON(base + '/data/meta', signal),
        ]);
        if (!dialog.open) return;
        tags = snapshot.tags;
        labels = options;
        frames = Array.from({ length: high - low + 1 }, (_, i) => low + i);
        const deleted = new Set(meta.deleted_frames || []);
        const included = Array.isArray(meta.included_frames) ? new Set(meta.included_frames) : null;
        const step = Number(/step\s*=\s*(\d+)/.exec(meta.frame_filter || '')?.[1] || 1);
        const first = frame('min');
        addFrames = frames.filter((f) => !deleted.has(f) && (!included || included.has(meta.start_frame + (f - first) * step)));
        target.add(new Option('Chọn tag…', ''));
        for (const label of labels) target.add(new Option(label.name, String(label.id)));
        mode.disabled = target.disabled = false;
        display();
      } catch (error) { info.textContent = error.message; }
    })();
  }
}
