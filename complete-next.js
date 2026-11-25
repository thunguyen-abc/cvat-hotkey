(() => {
  'use strict';

  const menuSelector = 'button.cvat-annotation-header-menu-button';
  const modalSelector = '.cvat-modal-content-finish-job';
  const successSelector = '.cvat-annotation-job-finished-success';
  const saveSelector = 'button.cvat-annotation-header-save-button';
  const cvatMediaType = 'application/vnd.cvat+json';
  let controls;
  let scheduled = false;

  function readJobPath() {
    const match = location.pathname.match(/^\/tasks\/(\d+)\/jobs\/(\d+)\/?$/);
    return match && { taskId: Number(match[1]), jobId: Number(match[2]) };
  }

  async function getJSON(path, signal) {
    const response = await fetch(path, {
      headers: { Accept: cvatMediaType },
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    });
    if (!response.ok) throw new Error(`CVAT trả về lỗi ${response.status}.`);
    return response.json();
  }

  async function findNextJob({ taskId, jobId }, organization, user, signal) {
    const query = new URLSearchParams({ task_id: taskId, sort: 'id', page_size: '100' });
    if (Number.isInteger(organization)) query.set('org_id', organization);
    else query.set('org', '');

    let firstEarlierJob = null;
    for (let page = 1; ; page += 1) {
      query.set('page', page);
      const data = await getJSON(`/api/jobs?${query}`, signal);
      if (!Array.isArray(data.results)) throw new Error('CVAT trả về danh sách job không hợp lệ.');
      for (const job of data.results) {
        if (job.task_id !== taskId || job.assignee?.id !== user.id || !Number.isInteger(job.id) ||
            !['new', 'in progress', 'rejected'].includes(job.state)) continue;
        if (job.id > jobId) return job.id;
        if (job.id < jobId && firstEarlierJob === null) firstEarlierJob = job.id;
      }
      if (!data.next) return firstEarlierJob;
    }
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

  async function completeAndAdvance(control) {
    const { job, menu, button, status, controller } = control;
    const { signal } = controller;
    button.disabled = true;
    status.textContent = 'Đang kiểm tra người được giao…';

    try {
      const endpoint = `/api/jobs/${job.jobId}`;
      const [user, current] = await Promise.all([getJSON('/api/users/self', signal), getJSON(endpoint, signal)]);
      if (!Number.isInteger(user.id) || current.task_id !== job.taskId || current.id !== job.jobId ||
          current.assignee?.id !== user.id) {
        throw new Error('Nút này chỉ hoàn tất job được giao cho tài khoản đang đăng nhập.');
      }

      await finishThroughCVAT(menu, job.jobId, signal, status);
      const saved = await getJSON(endpoint, signal);
      if (saved.state !== 'completed') throw new Error('CVAT chưa chuyển job sang Completed.');

      status.textContent = 'Đang tìm job tiếp theo của bạn…';
      const next = await findNextJob(job, saved.organization, user, signal);
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

  async function readTags(endpoint, signal) {
    const data = await getJSON(endpoint, signal);
    if (!Number.isInteger(data.version) || !Array.isArray(data.tags) ||
        data.tags.some((tag) => !Number.isInteger(tag?.id))) {
      throw new Error('CVAT không trả về danh sách tag hợp lệ.');
    }
    return { version: data.version, tags: data.tags };
  }

  async function saveCurrentAnnotations(signal) {
    const save = document.querySelector(saveSelector);
    const isSaving = () => document.querySelector(saveSelector)
      ?.classList.contains('cvat-annotation-disabled-header-button');
    if (!save || save.disabled || isSaving()) throw new Error('Đợi CVAT lưu xong rồi thử lại.');
    const saveErrors = () => [...document.querySelectorAll('.ant-notification-notice')]
      .filter((notice) => /could not save annotations/i.test(notice.textContent));
    const previousErrors = new Set(saveErrors());
    const savingClass = 'cvat-annotation-disabled-header-button';
    let sawSave = false;
    const observer = new MutationObserver((records) => {
      sawSave ||= isSaving() || records.some(({ target, oldValue }) =>
        target === save && oldValue?.split(/\s+/).includes(savingClass));
    });
    observer.observe(save, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
    try {
      save.click();
      await waitFor(() => sawSave || isSaving(), signal, 4000, 'Không xác nhận được CVAT đã bắt đầu lưu.');
      await waitFor(() => !isSaving(), signal, 90000, 'CVAT chưa lưu xong.');
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (saveErrors().some((error) => !previousErrors.has(error))) {
        throw new Error('CVAT báo lỗi khi lưu annotation.');
      }
    } finally {
      observer.disconnect();
    }
  }

  function showClearDialog(control) {
    const { job, controller, status } = control;
    const signal = controller.signal;
    const endpoint = `/api/jobs/${job.jobId}/annotations`;
    const dialog = document.createElement('dialog');
    dialog.className = 'cvat-event-clear-dialog';
    dialog.setAttribute('aria-labelledby', 'cvat-event-clear-title');
    const title = document.createElement('h2');
    title.id = 'cvat-event-clear-title';
    title.textContent = `Xóa toàn bộ tag của job #${job.jobId}?`;
    const detail = document.createElement('p');
    detail.setAttribute('role', 'status');
    detail.textContent = 'Đang đếm tag đã lưu…';
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
    let sentDelete = false;
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

    async function describeTags() {
      try {
        const { tags } = await readTags(endpoint, signal);
        if (!dialog.open) return;
        detail.textContent = `Job có ${tags.length} tag đã lưu. CVAT sẽ lưu các chỉnh sửa hiện tại trước, rồi xóa tag trên mọi frame của job. Box, shape và track được giữ lại. Thao tác xóa không thể hoàn tác bằng Undo.`;
        confirm.disabled = false;
      } catch (error) {
        if (dialog.open) detail.textContent = error.message;
      }
    }

    async function clearTags() {
      started = true;
      confirm.disabled = true;
      cancel.disabled = true;
      try {
        const cookie = document.cookie.split(';').map((part) => part.trim())
          .find((part) => part.startsWith('csrftoken='));
        if (!cookie) throw new Error('Không thấy phiên CSRF của CVAT. Hãy đăng nhập lại rồi thử lại.');
        detail.textContent = 'Đang lưu annotation trước khi xóa…';
        await saveCurrentAnnotations(signal);
        const { version, tags } = await readTags(endpoint, signal);
        signal.throwIfAborted();
        if (readJobPath()?.jobId !== job.jobId) return;
        if (!tags.length) {
          status.textContent = 'Job này không còn tag.';
          dialog.close();
          return;
        }

        detail.textContent = `Đang xóa ${tags.length} tag…`;
        sentDelete = true;
        const response = await fetch(`${endpoint}?action=delete`, {
          method: 'PATCH',
          headers: {
            Accept: cvatMediaType,
            'Content-Type': 'application/json',
            'X-CSRFTOKEN': decodeURIComponent(cookie.slice('csrftoken='.length)),
          },
          credentials: 'same-origin',
          redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
          body: JSON.stringify({ version, tags, shapes: [], tracks: [] }),
        });
        if (!response.ok) throw new Error(`CVAT trả về lỗi ${response.status} khi xóa tag.`);
        const remaining = await readTags(endpoint, signal);
        if (remaining.tags.length) {
          throw new Error(`CVAT vẫn còn ${remaining.tags.length} tag trong job.`);
        }
        if (readJobPath()?.jobId !== job.jobId) return;
        detail.textContent = `Đã xóa ${tags.length} tag. Đang tải lại job…`;
        location.reload();
      } catch (error) {
        if (signal.aborted) return;
        detail.textContent = error.message || 'Không thể xóa tag.';
        if (sentDelete) {
          confirm.hidden = true;
          cancel.textContent = 'Tải lại job';
          cancel.addEventListener('click', () => location.reload(), { once: true, capture: true });
        } else {
          started = false;
          confirm.disabled = false;
        }
        cancel.disabled = false;
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
        attachCVATRangeEditor(controls, slider, anchor, { getJSON, readTags, saveCurrentAnnotations });
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
