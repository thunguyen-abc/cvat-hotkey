(() => {
  'use strict';

  // cvatEventBridge, cvatEventRequests and describeCVATSave come from bridge-client.js.
  const menuSelector = 'button.cvat-annotation-header-menu-button';
  const modalSelector = '.cvat-modal-content-finish-job';
  const successSelector = '.cvat-annotation-job-finished-success';
  const openStates = ['new', 'in progress', 'rejected'];
  const legacyPageLimit = 20;
  let controls;
  let scheduled = false;

  function readJobPath() {
    const match = location.pathname.match(/^\/tasks\/(\d+)\/jobs\/(\d+)\/?$/);
    return match && { taskId: Number(match[1]), jobId: Number(match[2]) };
  }

  const getJSON = (path, signal) => cvatEventRequests.getJSON(path, signal);

  function organizationQuery(query, organization) {
    if (Number.isInteger(organization)) query.set('org_id', organization);
    else query.set('org', '');
  }

  function isCandidate(job, taskId, user) {
    return job?.task_id === taskId && job.assignee?.id === user.id && Number.isInteger(job.id) &&
      openStates.includes(job.state);
  }

  // Asks the server for exactly one job: the next open job of this user in this task with a
  // larger ID, or else the smallest one. At most two small requests (page_size=1).
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
    try {
      return (await lookup('>')) ?? (await lookup('<'));
    } catch (error) {
      if (error.status !== 400 || typeof user.username !== 'string') throw error;
      return findNextJobByPages({ taskId, jobId }, organization, user, signal);
    }
  }

  // Fallback for servers without JSON filters: walk the task's jobs, 100 per page, through
  // the rate-limited queue, and stop after legacyPageLimit pages.
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

  async function waitFor(lookup, signal, timeout, errorMessage) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const value = lookup();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 75));
    }
    throw new Error(errorMessage);
  }

  // "Finish the job" in CVAT saves the changed annotations (only the changed objects, at
  // most one request each for updated, deleted and created) and sets the job to completed.
  async function finishThroughCVAT(menu, jobId, signal, status) {
    const visibleFinishItem = () => [...document.querySelectorAll('[role="menuitem"]')].find((item) =>
      item.getClientRects().length && item.getAttribute('aria-disabled') !== 'true' &&
      (item.getAttribute('data-menu-id')?.endsWith('-finish_job') ||
        item.textContent.trim() === 'Finish the job'));
    if (document.querySelector(modalSelector)?.getClientRects().length) {
      throw new Error('Hãy đóng hộp xác nhận CVAT đang mở rồi thử lại.');
    }
    if (!visibleFinishItem()) menu.click();
    const finishItem = await waitFor(visibleFinishItem, signal, 2500, 'Không tìm thấy lệnh Finish the job.');
    const oldMessages = new Set(document.querySelectorAll(successSelector));
    finishItem.click();

    const continueButton = await waitFor(() => {
      const candidate = document.querySelector(modalSelector);
      if (!candidate?.getClientRects().length) return null;
      const primary = candidate.querySelector('button.ant-btn-primary');
      return primary?.textContent.trim() === 'Continue' && !primary.disabled ? primary : null;
    }, signal, 2500, 'Không tìm thấy nút Continue trong hộp xác nhận hoàn tất của CVAT.');
    signal.throwIfAborted();
    if (readJobPath()?.jobId !== jobId) throw new Error('Job đã thay đổi trước khi xác nhận.');
    status.textContent = 'Đang chờ CVAT lưu và hoàn tất…';
    continueButton.click();
    await waitFor(() => [...document.querySelectorAll(successSelector)].some((node) => !oldMessages.has(node)),
      signal, 90000, 'Chưa thấy CVAT xác nhận hoàn tất. Kiểm tra trạng thái job trước khi thử lại.');
  }

  // User and assignee come from CVAT's in-memory state. Two small GETs only if the bridge
  // is unavailable.
  async function readSession(job, signal) {
    if (await cvatEventBridge.ready()) {
      const session = await cvatEventBridge.call('session');
      if (session.user && session.job.id === job.jobId) {
        return { user: session.user, assigneeId: session.job.assigneeId, taskId: session.job.taskId, saving: session.saving };
      }
    }
    const user = await getJSON('/api/users/self', signal);
    const current = await getJSON(`/api/jobs/${job.jobId}`, signal);
    if (current.id !== job.jobId) throw new Error('CVAT trả về job không khớp.');
    return { user: { id: user.id, username: user.username }, assigneeId: current.assignee?.id ?? null, taskId: current.task_id };
  }

  async function completeAndAdvance(control) {
    const { job, menu, button, status, controller } = control;
    const { signal } = controller;
    button.disabled = true;
    status.textContent = 'Đang kiểm tra người được giao…';

    try {
      const session = await readSession(job, signal);
      if (session.saving) throw new Error('CVAT đang lưu. Đợi lưu xong rồi thử lại.');
      if (!Number.isInteger(session.user?.id) || session.taskId !== job.taskId || session.assigneeId !== session.user.id) {
        throw new Error('Nút này chỉ hoàn tất job được giao cho tài khoản đang đăng nhập.');
      }

      await finishThroughCVAT(menu, job.jobId, signal, status);
      const saved = await getJSON(`/api/jobs/${job.jobId}`, signal);
      if (saved.state !== 'completed') throw new Error('CVAT chưa chuyển job sang Completed.');
      // The job is done: drop the extension's cached tags and the Start/End marks for it.
      try { sessionStorage.removeItem(`cvat-event-range:${job.jobId}`); } catch { /* Storage may be unavailable. */ }
      await cvatEventBridge.call('clearCache', {}, 3000).catch(() => {});

      status.textContent = 'Đang tìm job tiếp theo của bạn…';
      const next = await findNextJob(job, saved.organization, session.user, signal);
      signal.throwIfAborted();
      if (readJobPath()?.jobId !== job.jobId) return;
      location.assign(next === null ? `/tasks/${job.taskId}` : `/tasks/${job.taskId}/jobs/${next}`);
    } catch (error) {
      if (!signal.aborted) status.textContent = error.message || 'Không thể hoàn tất và chuyển job.';
    } finally {
      button.disabled = false;
      control.clearButton.disabled = false;
    }
  }

  // Removes every tag from CVAT's in-memory annotations. Nothing is sent until CVAT saves,
  // and then only the deleted tags travel, in one request.
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
    control.wrapper.after(dialog);
    dialog.showModal();

    let started = false;
    let expected = 0;
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

    function describe({ count, frames }) {
      expected = count;
      detail.textContent = count
        ? `Job có ${count} tag trên ${frames} frame, tính cả thay đổi chưa lưu. Extension xóa chúng trên trình duyệt; CVAT lưu lên server ở lần lưu tiếp theo. Box, shape và track được giữ lại. Trước khi lưu, có thể Undo (Ctrl+Z) hoặc tải lại trang mà không lưu để bỏ thay đổi.`
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
        const result = await cvatEventBridge.call('clearAll', { jobId: job.jobId, expected }, 180000);
        started = false;
        cancel.disabled = false;
        if (result.stale) {
          detail.textContent = `Số tag vừa thay đổi thành ${result.count}. Kiểm tra lại rồi bấm Xóa.`;
          expected = result.count;
          confirm.disabled = !result.count;
          return;
        }
        status.textContent = `Đã xóa ${result.removed} tag. ${describeCVATSave(result.save)}`;
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
      if (slider && anchor && !anchor.querySelector('.cvat-range-buttons')) {
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
    const status = document.createElement('span');
    status.id = 'cvat-event-complete-status';
    status.setAttribute('role', 'status');
    status.className = 'cvat-event-complete-status';
    const clearButton = document.createElement('button');
    clearButton.type = 'button';
    clearButton.className = 'ant-btn ant-btn-default ant-btn-sm ant-btn-dangerous';
    clearButton.textContent = 'Clear All Tags';
    clearButton.setAttribute('aria-describedby', 'cvat-event-complete-status');
    wrapper.append(button, clearButton, status);
    menu.after(wrapper);
    controls = { job, menu, wrapper, button, clearButton, status, controller: new AbortController() };
    const control = controls;
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
