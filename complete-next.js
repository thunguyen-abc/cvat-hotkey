(() => {
  'use strict';

  // cvatEventBridge, cvatEventRequests and describeCVATSave come from bridge-client.js.
  const menuSelector = 'button.cvat-annotation-header-menu-button';
  const modalSelector = '.cvat-modal-content-finish-job';
  const saveSelector = 'button.cvat-annotation-header-save-button';
  const openStates = ['new', 'in progress', 'rejected'];
  const legacyPageLimit = 20;
  let controls;
  let scheduled = false;

  function readJobPath() {
    const match = location.pathname.match(/^\/tasks\/(\d+)\/jobs\/(\d+)\/?$/);
    return match && { taskId: Number(match[1]), jobId: Number(match[2]) };
  }

  const getJSON = (path, signal) => cvatEventRequests.getJSON(path, signal);
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function organizationQuery(query, organization) {
    if (Number.isInteger(organization)) query.set('org_id', organization);
    else query.set('org', '');
  }

  function isCandidate(job, taskId, user) {
    return job?.task_id === taskId && job.assignee?.id === user.id && Number.isInteger(job.id) &&
      openStates.includes(job.state);
  }

  // Next open job (New, In progress, Rejected) of this user in this task: the smallest ID
  // above the current one, else the smallest ID below it. The server filters, so normally
  // this costs one or two page_size=1 requests. If the filter fails or finds nothing, the
  // task's job list is scanned as in earlier versions, so no job is skipped.
  async function findNextJob({ taskId, jobId }, organization, user, signal) {
    const lookup = async (comparison) => {
      const filter = { and: [
        { '==': [{ var: 'task_id' }, taskId] },
        { '==': [{ var: 'assignee' }, user.username] },
        { [comparison]: [{ var: 'id' }, jobId] },
        { or: openStates.map((state) => ({ '==': [{ var: 'state' }, state] })) },
      ] };
      const query = new URLSearchParams({ filter: JSON.stringify(filter), sort: 'id', page_size: '1', page: '1' });
      organizationQuery(query, organization);
      const data = await getJSON(`/api/jobs?${query}`, signal);
      if (!Array.isArray(data.results)) throw new Error('CVAT trả về danh sách job không hợp lệ.');
      const job = data.results[0];
      return isCandidate(job, taskId, user) ? job.id : null;
    };
    if (typeof user.username === 'string') {
      try {
        const found = (await lookup('>')) ?? (await lookup('<'));
        if (found !== null) return found;
      } catch (error) {
        if (signal.aborted) throw error;
      }
    }
    return findNextJobByPages({ taskId, jobId }, organization, user, signal);
  }

  // The original search: the task's jobs, 100 per page, through the rate-limited queue,
  // stopping at the first match and after legacyPageLimit pages.
  async function findNextJobByPages({ taskId, jobId }, organization, user, signal) {
    const query = new URLSearchParams({ task_id: taskId, sort: 'id', page_size: '100' });
    organizationQuery(query, organization);
    let firstEarlierJob = null;
    for (let page = 1; page <= legacyPageLimit; page += 1) {
      query.set('page', page);
      const data = await getJSON(`/api/jobs?${query}`, signal);
      if (!Array.isArray(data.results)) throw new Error('CVAT trả về danh sách job không hợp lệ.');
      for (const job of data.results) {
        if (!isCandidate(job, taskId, user)) continue;
        if (job.id > jobId) return job.id;
        if (job.id < jobId && firstEarlierJob === null) firstEarlierJob = job.id;
      }
      if (!data.next) break;
    }
    return firstEarlierJob;
  }

  async function waitFor(lookup, signal, timeout, errorMessage, interval = 75) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const value = await lookup();
      if (value) return value;
      await pause(interval);
    }
    throw new Error(errorMessage);
  }

  const saveErrors = () => [...document.querySelectorAll('.ant-notification-notice')]
    .filter((notice) => /could not save/i.test(notice.textContent));

  // Step 1: save. Clicks CVAT's own Save (diff-only upload) when something is unsaved, then
  // waits until CVAT has finished and nothing is left unsaved. Nothing to save: no request.
  async function saveThroughCVAT(job, signal, status) {
    const read = () => cvatEventBridge.call('saveStatus', { jobId: job.jobId });
    let current = await read();
    if (current.saving) {
      status.textContent = 'Đợi CVAT lưu xong…';
      current = await waitFor(async () => { const s = await read(); return s.saving ? null : s; },
        signal, 120000, 'CVAT chưa lưu xong. Thử lại sau.', 300);
    }
    if (!current.unsaved) return;
    const save = document.querySelector(saveSelector);
    if (!save || save.disabled) throw new Error('Không tìm thấy nút Save của CVAT.');
    const previousErrors = new Set(saveErrors());
    status.textContent = 'Đang lưu thay đổi…';
    save.click();
    await waitFor(async () => {
      const s = await read();
      if (!s.saving && !s.unsaved) return true;
      if (!s.saving && saveErrors().some((notice) => !previousErrors.has(notice))) {
        throw new Error('CVAT báo lỗi khi lưu. Job chưa được hoàn tất.');
      }
      return false;
    }, signal, 120000, 'CVAT chưa lưu xong. Job chưa được hoàn tất.', 300);
  }

  // Fallback without the bridge: CVAT's "Finish the job" (it saves, then sets completed).
  // CVAT 2.56 shows no success message when it completes a job, so the server is asked.
  async function finishThroughMenu(menu, job, signal, status) {
    const visibleFinishItem = () => [...document.querySelectorAll('[role="menuitem"]')].find((item) =>
      item.getClientRects().length && item.getAttribute('aria-disabled') !== 'true' &&
      (item.getAttribute('data-menu-id')?.endsWith('-finish_job') ||
        item.textContent.trim() === 'Finish the job'));
    if (document.querySelector(modalSelector)?.getClientRects().length) {
      throw new Error('Hãy đóng hộp xác nhận CVAT đang mở rồi thử lại.');
    }
    if (!visibleFinishItem()) menu.click();
    const finishItem = await waitFor(visibleFinishItem, signal, 2500, 'Không tìm thấy lệnh Finish the job.');
    finishItem.click();
    const continueButton = await waitFor(() => {
      const candidate = document.querySelector(modalSelector);
      if (!candidate?.getClientRects().length) return null;
      const primary = candidate.querySelector('button.ant-btn-primary');
      return primary?.textContent.trim() === 'Continue' && !primary.disabled ? primary : null;
    }, signal, 2500, 'Không tìm thấy nút Continue trong hộp xác nhận hoàn tất của CVAT.');
    if (readJobPath()?.jobId !== job.jobId) throw new Error('Job đã thay đổi trước khi xác nhận.');
    status.textContent = 'Đang chờ CVAT lưu và hoàn tất…';
    continueButton.click();
    return waitFor(async () => {
      const current = await getJSON(`/api/jobs/${job.jobId}`, signal);
      return current.state === 'completed' ? current : null;
    }, signal, 60000, 'Chưa thấy job chuyển sang Completed. Kiểm tra trạng thái job trước khi thử lại.', 2000);
  }

  // User and assignee come from CVAT's in-memory state. Two small GETs only if the bridge
  // is unavailable.
  async function readSession(job, signal, bridged) {
    if (bridged) {
      const session = await cvatEventBridge.call('session');
      if (session.user && session.job.id === job.jobId) {
        return { user: session.user, assigneeId: session.job.assigneeId, taskId: session.job.taskId };
      }
    }
    const user = await getJSON('/api/users/self', signal);
    const current = await getJSON(`/api/jobs/${job.jobId}`, signal);
    if (current.id !== job.jobId) throw new Error('CVAT trả về job không khớp.');
    return { user: { id: user.id, username: user.username }, assigneeId: current.assignee?.id ?? null, taskId: current.task_id };
  }

  // Save -> Completed -> next job. Each step is confirmed before the next one starts; on
  // any error the user stays on the current job with the reason shown.
  async function completeAndAdvance(control) {
    const { job, menu, button, status, controller } = control;
    const { signal } = controller;
    button.disabled = true;
    control.notify('Đang kiểm tra người được giao…', 'progress');

    try {
      const bridged = await cvatEventBridge.ready();
      const session = await readSession(job, signal, bridged);
      if (!Number.isInteger(session.user?.id) || session.taskId !== job.taskId || session.assigneeId !== session.user.id) {
        throw new Error('Nút này chỉ hoàn tất job được giao cho tài khoản đang đăng nhập.');
      }

      let saved;
      if (bridged) {
        await saveThroughCVAT(job, signal, status);
        status.textContent = 'Đang chuyển job sang Completed…';
        const result = await cvatEventBridge.call('completeJob', { jobId: job.jobId }, 60000);
        if (result.state !== 'completed') throw new Error('CVAT chưa chuyển job sang Completed.');
        saved = await getJSON(`/api/jobs/${job.jobId}`, signal);
      } else {
        saved = await finishThroughMenu(menu, job, signal, status);
      }
      if (saved.state !== 'completed') throw new Error('Server chưa ghi nhận job ở trạng thái Completed.');
      // The job is done: drop the extension's cached tags and the Start/End marks for it.
      try { sessionStorage.removeItem(`cvat-event-range:${job.jobId}`); } catch { /* Storage may be unavailable. */ }
      await cvatEventBridge.call('clearCache', {}, 3000).catch(() => {});

      status.textContent = 'Đã hoàn tất. Đang tìm job tiếp theo của bạn…';
      const next = await findNextJob(job, saved.organization, session.user, signal);
      signal.throwIfAborted();
      if (readJobPath()?.jobId !== job.jobId) return;
      location.assign(next === null ? `/tasks/${job.taskId}` : `/tasks/${job.taskId}/jobs/${next}`);
    } catch (error) {
      if (!signal.aborted) control.notify(error.message || 'Không thể hoàn tất và chuyển job.', 'error');
    } finally {
      button.disabled = false;
      control.clearButton.disabled = false;
    }
  }

  // Removes every tag from CVAT's in-memory annotations, the same way the range editor's
  // Apply changes them: the view refreshes in place (no page reload, no request), Start/End
  // and the panel's queue stay, and CVAT's next save uploads only the deletions.
  function showClearDialog(control) {
    const { job, controller, status } = control;
    const signal = controller.signal;
    const dialog = document.createElement('dialog');
    dialog.className = 'cvat-event-clear-dialog';
    dialog.setAttribute('aria-labelledby', 'cvat-event-clear-title');
    const title = document.createElement('h2');
    title.id = 'cvat-event-clear-title';
    title.textContent = `Xóa toàn bộ tag của job #${job.jobId}?`;
    const detail = document.createElement('p');
    detail.setAttribute('role', 'status');
    detail.textContent = 'Đang đếm tag…';
    const actions = document.createElement('div');
    actions.className = 'cvat-event-clear-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'ant-btn';
    cancel.textContent = 'Hủy';
    cancel.autofocus = true;
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'ant-btn ant-btn-primary ant-btn-dangerous';
    confirm.textContent = 'Xóa toàn bộ tag';
    confirm.classList.add('cvat-event-danger');
    confirm.disabled = true;
    actions.append(cancel, confirm);
    dialog.append(title, detail, actions);
    document.body.append(dialog);
    dialog.showModal();

    let started = false;
    let expected = 0;
    let key = null;
    cancel.addEventListener('click', () => dialog.close());
    dialog.addEventListener('keydown', (event) => event.stopPropagation());
    dialog.addEventListener('cancel', (event) => { if (started) event.preventDefault(); });
    const closeOnNavigation = () => dialog.close();
    signal.addEventListener('abort', closeOnNavigation, { once: true });
    dialog.addEventListener('close', () => {
      signal.removeEventListener('abort', closeOnNavigation);
      dialog.remove();
      control.button.disabled = false;
      control.clearButton.disabled = false;
    }, { once: true });

    function describe({ count, frames, key: fingerprint }) {
      expected = count;
      key = typeof fingerprint === 'string' ? fingerprint : null;
      control.showTagCount(count);
      detail.textContent = count
        ? `Job có ${count} tag trên ${frames} frame, tính cả thay đổi chưa lưu. Extension xóa chúng ngay trên trình duyệt như khi Áp dụng chỉnh theo khoảng: trang không tải lại, frame, Start/End và các thao tác đang xếp được giữ. Box, shape và track được giữ lại. CVAT lưu lên server ở lần lưu tiếp theo; trước đó có thể Undo (Ctrl+Z).`
        : 'Job này không có tag nào.';
      confirm.disabled = !count;
    }

    async function describeTags() {
      try {
        if (!await cvatEventBridge.ready()) throw new Error('CVAT chưa sẵn sàng cho extension. Đợi job tải xong rồi thử lại.');
        const snapshot = await cvatEventBridge.call('clearSnapshot', { jobId: job.jobId }, 60000);
        if (dialog.open) describe(snapshot);
      } catch (error) {
        if (dialog.open) detail.textContent = error.message;
      }
    }

    async function clearTags() {
      started = true;
      confirm.disabled = true;
      cancel.disabled = true;
      detail.textContent = `Đang xóa ${expected} tag trên trình duyệt…`;
      try {
        const result = await cvatEventBridge.call('clearAll', { jobId: job.jobId, key, expected }, 180000);
        started = false;
        cancel.disabled = false;
        if (result.stale) {
          describe(result);
          detail.textContent = `Tag của job vừa thay đổi: hiện có ${result.count} tag. Kiểm tra lại rồi bấm Xóa.`;
          return;
        }
        control.showTagCount(0);
        control.notify(`Đã xóa ${result.removed} tag. ${describeCVATSave(result.save)}`);
        dialog.close();
      } catch (error) {
        if (signal.aborted) return;
        started = false;
        detail.textContent = error.message || 'Không thể xóa tag.';
        cancel.disabled = false;
        confirm.disabled = false;
      }
    }

    confirm.addEventListener('click', () => { void clearTags(); });
    void describeTags();
  }

  function showControls() {
    const job = readJobPath();
    const menu = document.querySelector(menuSelector);
    if (controls && (!job || controls.job.jobId !== job.jobId || controls.menu !== menu)) {
      controls.controller.abort();
      controls.wrapper.remove();
      controls = null;
    }
    if (!job || !menu) return;
    if (controls) {
      const slider = document.querySelector('.cvat-player-slider');
      const anchor = document.querySelector('.cvat-player-frame-selector')?.parentElement;
      if (!slider || !anchor) {
        controls.rangeMount?.abort();
        controls.rangeSlider = null;
      } else if (controls.rangeSlider !== slider || !anchor.querySelector('.cvat-range-buttons')) {
        controls.rangeSlider = slider;
        attachCVATRangeEditor(controls, slider, anchor);
      }
      return;
    }

    const wrapper = document.createElement('span');
    wrapper.className = 'cvat-event-complete-next';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ant-btn ant-btn-default ant-btn-sm';
    button.textContent = 'Complete & Next';
    button.classList.add('cvat-event-primary');
    button.setAttribute('aria-describedby', 'cvat-event-complete-status');
    // Metadata sits below the job buttons beside Menu, separate from the player.
    const meta = document.createElement('span');
    meta.className = 'cvat-job-meta';
    const eventCounts = document.createElement('span');
    eventCounts.className = 'cvat-job-event-counts';
    eventCounts.setAttribute('role', 'group');
    eventCounts.setAttribute('aria-label', 'Tổng số event trong job');
    const makeButton = (text, className, label) => {
      const node = document.createElement('button');
      node.type = 'button';
      node.className = 'ant-btn ant-btn-default ant-btn-sm ' + className;
      node.textContent = text;
      node.title = label;
      node.setAttribute('aria-label', label);
      node.disabled = true;
      return node;
    };
    const counters = CVAT_EVENT_LABELS.map((name) => {
      const item = document.createElement('span');
      item.className = 'cvat-job-event-count';
      item.dataset.event = name;
      const label = displayCVATLabel(name);
      const value = document.createElement('strong');
      value.textContent = '—';
      const add = makeButton('+', 'cvat-job-event-add', 'Thêm ' + label + ' cho toàn job');
      const remove = makeButton('−', 'cvat-job-event-remove', 'Xóa ' + label + ' khỏi toàn job');
      const caption = document.createElement('span');
      caption.textContent = label;
      caption.append(value);
      item.append(caption, add, remove);
      eventCounts.append(item);
      return { name, label, value, add, remove };
    });
    const historyButtons = document.createElement('span');
    historyButtons.className = 'cvat-job-edit-history';
    historyButtons.setAttribute('role', 'group');
    historyButtons.setAttribute('aria-label', 'Lịch sử Apply của extension');
    const undo = makeButton('Undo Apply', 'cvat-job-undo', 'Undo lần Apply của extension');
    const redo = makeButton('Redo Apply', 'cvat-job-redo', 'Redo lần Apply của extension');
    historyButtons.append(undo, redo);
    const statusBox = document.createElement('span');
    statusBox.className = 'cvat-event-complete-status';
    const status = document.createElement('span');
    status.id = 'cvat-event-complete-status';
    status.setAttribute('role', 'status');
    const hide = document.createElement('button');
    hide.type = 'button';
    hide.className = 'cvat-event-status-close';
    hide.textContent = '×';
    hide.title = 'Ẩn thông báo';
    hide.setAttribute('aria-label', 'Ẩn thông báo');
    statusBox.append(status, hide);
    let hideTimer = 0;
    const notify = (text, kind = 'info') => {
      clearTimeout(hideTimer);
      statusBox.dataset.kind = kind;
      status.textContent = text;
      if (text && kind === 'info') {
        hideTimer = setTimeout(() => { if (status.textContent === text) status.textContent = ''; }, 8000);
      }
    };
    hide.addEventListener('click', () => {
      clearTimeout(hideTimer);
      status.textContent = '';
    });
    const clearButton = document.createElement('button');
    clearButton.type = 'button';
    clearButton.className = 'ant-btn ant-btn-default ant-btn-sm ant-btn-dangerous';
    clearButton.setAttribute('aria-describedby', 'cvat-event-complete-status');
    // The job's tag count, unsaved changes included, kept current by the bridge after
    // every annotation change. Hidden until the first count arrives.
    const clearCount = document.createElement('span');
    clearCount.className = 'cvat-clear-count';
    clearCount.hidden = true;
    clearButton.append('Clear All Tags', clearCount);
    const showTagCount = (count) => {
      if (!Number.isInteger(count)) return;
      clearCount.hidden = false;
      clearCount.textContent = String(count);
      clearCount.dataset.empty = String(count === 0);
      clearButton.title = `Job có ${count} tag, tính cả thay đổi chưa lưu`;
      clearButton.setAttribute('aria-label', `Clear All Tags (${count} tag)`);
    };
    meta.append(eventCounts, historyButtons, statusBox);
    wrapper.append(button, clearButton, meta);
    menu.after(wrapper);
    controls = { job, menu, wrapper, button, clearButton, status, notify, showTagCount, controller: new AbortController() };
    const control = controls;
    const { signal } = control.controller;
    let latestCounts;
    let historyStatus;
    function syncEditButtons() {
      const busy = button.disabled || clearButton.disabled;
      for (const { name, add, remove } of counters) {
        const count = latestCounts?.byLabel?.[name];
        add.disabled = busy || !Number.isInteger(count);
        remove.disabled = busy || !(count > 0);
      }
      undo.disabled = busy || !historyStatus?.undo;
      redo.disabled = busy || !historyStatus?.redo;
    }
    function showCounts(counts) {
      latestCounts = counts;
      historyStatus = counts.editHistory;
      showTagCount(counts.count);
      for (const { name, value } of counters) {
        const text = String(counts.byLabel?.[name] ?? 0);
        if (value.textContent !== text) value.textContent = text;
      }
      syncEditButtons();
    }
    const lockObserver = new MutationObserver(syncEditButtons);
    for (const action of [button, clearButton]) lockObserver.observe(action, { attributeFilter: ['disabled'] });
    signal.addEventListener('abort', () => {
      lockObserver.disconnect();
      clearTimeout(hideTimer);
    }, { once: true });

    async function runEdit(progress, edit) {
      if (signal.aborted || button.disabled || clearButton.disabled) return;
      button.disabled = clearButton.disabled = true;
      syncEditButtons();
      notify(progress, 'progress');
      try {
        await edit();
      } catch (error) {
        if (!signal.aborted) notify(error.message, 'error');
      } finally {
        if (!signal.aborted) {
          button.disabled = clearButton.disabled = false;
          syncEditButtons();
        }
      }
    }
    async function editJobEvent({ name, label }, mode) {
      const args = { jobId: job.jobId };
      const snapshot = await cvatEventBridge.call('rangeSnapshot', { ...args, wholeJob: true }, 120000);
      if (signal.aborted) return;
      const id = snapshot.labels.find((candidate) => candidate.name === name)?.id;
      if (id === undefined) throw new Error('Job thiếu nhãn ' + name + '.');
      const operation = mode === 'add' ? { mode, targets: [id] } : { mode, sources: [id] };
      const change = planCVATRangeBatch({ ...snapshot, operations: [operation] });
      const count = change.create.length + change.delete.length;
      if (!count) {
        notify('Không có thay đổi cho ' + label + ' trong job này.');
        return;
      }
      if (mode === 'remove' && !window.confirm('Xóa ' + count + ' tag ' + label + ' khỏi toàn bộ job đang mở?')) {
        notify('');
        return;
      }
      const result = await cvatEventBridge.call('applyRange', {
        ...args, low: snapshot.low, high: snapshot.high, key: snapshot.key,
        create: change.create, remove: change.delete.map((item) => item.clientID),
      }, 120000);
      if (signal.aborted) return;
      if (result.stale) throw new Error('Tag trong job vừa thay đổi. Kiểm tra rồi bấm lại.');
      notify((mode === 'add' ? 'Đã thêm ' : 'Đã xóa ') + count + ' tag ' + label + '. ' + describeCVATSave(result.save));
    }
    for (const counter of counters) {
      counter.add.onclick = () => { void runEdit('Đang đọc tag của job…', () => editJobEvent(counter, 'add')); };
      counter.remove.onclick = () => { void runEdit('Đang đọc tag của job…', () => editJobEvent(counter, 'remove')); };
    }
    for (const [node, direction] of [[undo, 'undo'], [redo, 'redo']]) {
      node.onclick = () => {
        void runEdit('Đang cập nhật lịch sử Apply…', async () => {
          const result = await cvatEventBridge.call('replayRangeEdit', { jobId: job.jobId, direction }, 120000);
          if (signal.aborted) return;
          historyStatus = result.editHistory;
          notify((direction === 'undo' ? 'Đã hoàn tác Apply. ' : 'Đã làm lại Apply. ') + describeCVATSave(result.save));
        });
      };
    }
    cvatEventBridge.onTagsChanged((counts) => { if (counts.jobId === job.jobId) showCounts(counts); }, signal);
    // First count: the bridge may register, or the job finish loading, after this mounts.
    void (async () => {
      for (let attempt = 0; attempt < 40 && !signal.aborted; attempt += 1) {
        try {
          const counts = await cvatEventBridge.call('tagCount', { jobId: job.jobId }, 1500);
          if (!signal.aborted && !latestCounts) showCounts(counts);
          return;
        } catch { await pause(1000); }
      }
    })();
    button.addEventListener('click', () => {
      if (button.disabled) return;
      clearButton.disabled = true;
      void completeAndAdvance(control);
    });
    clearButton.addEventListener('click', () => {
      if (clearButton.disabled) return;
      button.disabled = true;
      clearButton.disabled = true;
      status.textContent = '';
      showClearDialog(control);
    });
  }

  function scheduleControls() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      showControls();
    });
  }

  new MutationObserver(scheduleControls).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('popstate', scheduleControls);
  scheduleControls();
})();
