'use strict';

// Isolated-world helpers shared by range-editor.js and complete-next.js.

// Calls cvat-bridge.js in the page. Every bridge method works on the annotations CVAT
// already holds in the browser and makes no server request.
const cvatEventBridge = (() => {
  const REQUEST = 'cvat-event-hotkeys:request';
  const RESPONSE = 'cvat-event-hotkeys:response';
  const pending = new Map();
  let sequence = 0;

  document.addEventListener(RESPONSE, (event) => {
    let message;
    try { message = JSON.parse(event.detail); } catch { return; }
    const waiter = pending.get(message?.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.ok) waiter.resolve(message.result);
    else waiter.reject(new Error(String(message.error || 'CVAT không phản hồi.')));
  });

  function call(method, params = {}, timeout = 15000) {
    return new Promise((resolve, reject) => {
      sequence += 1;
      const id = `${Date.now()}-${sequence}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('CVAT chưa sẵn sàng cho extension. Đợi job tải xong rồi thử lại.'));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      document.dispatchEvent(new CustomEvent(REQUEST, { detail: JSON.stringify({ id, method, params }) }));
    });
  }

  async function ready() {
    try { return (await call('ping', {}, 1500)).ready === true; } catch { return false; }
  }

  return { call, ready };
})();

// Server GETs made directly by the extension go through one queue per tab: at most one
// request in flight, at least 250 ms apart (≤ 4 per second). 429/502/503/504 responses
// are retried twice with backoff, honouring Retry-After (capped at 30 s).
const cvatEventRequests = (() => {
  const minimumGap = 250;
  const retryable = new Set([429, 502, 503, 504]);
  let lastStart = 0;
  let queue = Promise.resolve();

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
  }

  async function run(path, signal) {
    for (let attempt = 0; ; attempt += 1) {
      const wait = lastStart + minimumGap - Date.now();
      if (wait > 0) await sleep(wait, signal);
      signal?.throwIfAborted();
      lastStart = Date.now();
      const response = await fetch(path, {
        headers: { Accept: 'application/vnd.cvat+json' },
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      });
      if (response.ok) return response.json();
      if (!retryable.has(response.status) || attempt >= 2) {
        const error = new Error(`CVAT trả về lỗi ${response.status}.`);
        error.status = response.status;
        throw error;
      }
      const retryAfter = Number(response.headers.get('Retry-After'));
      await sleep(retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : 1000 * 2 ** attempt, signal);
    }
  }

  function getJSON(path, signal) {
    const result = queue.then(() => run(path, signal));
    queue = result.catch(() => {});
    return result;
  }

  return { getJSON };
})();

function describeCVATSave(save) {
  if (!save?.unsaved) return 'Không còn thay đổi chưa lưu.';
  if (save.autoSave && save.interval > 0) {
    const every = save.interval >= 60000 ? `${Math.round(save.interval / 60000)} phút` : `${Math.round(save.interval / 1000)} giây`;
    return `Chưa lưu lên server. CVAT tự lưu theo chu kỳ ${every}, hoặc bấm Save (Ctrl+S) hay Complete & Next.`;
  }
  return 'Chưa lưu lên server. Autosave đang tắt: bấm Save (Ctrl+S) hoặc Complete & Next để lưu.';
}
