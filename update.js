const installed = document.getElementById('installed');
const status = document.getElementById('status');
const update = document.getElementById('update');
const retry = document.getElementById('retry');
const help = document.getElementById('install-help');
const updater = document.getElementById('updater');

installed.textContent = `Đang dùng v${chrome.runtime.getManifest().version}`;

// updater-state.json is written into the extension folder by the desktop updater.
// It is display-only data: never trust it for decisions, only render it as text.
async function readUpdaterState() {
  try {
    const response = await fetch(chrome.runtime.getURL('updater-state.json'), { cache: 'no-store' });
    if (!response.ok) return null;
    const state = await response.json();
    return state && typeof state === 'object' ? state : null;
  } catch {
    return null;
  }
}

function describeUpdater(state) {
  if (!state) return 'Trình cập nhật tự động chưa được cài trên máy này.';
  const mode = state.mode === 'auto' ? 'tự cài bản mới' : 'hỏi trước khi cài';
  const checked = Date.parse(state.lastCheck);
  const when = Number.isFinite(checked)
    ? new Date(checked).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' })
    : 'chưa rõ';
  return `Trình cập nhật: ${mode}. Kiểm tra lần cuối ${when}.`;
}

async function checkForUpdate() {
  status.textContent = 'Đang kiểm tra bản mới…';
  retry.hidden = true;
  update.hidden = true;
  help.hidden = true;
  try {
    const local = await chrome.runtime.sendMessage({ type: 'activate-local-update' });
    if (local?.reloading) {
      status.textContent = 'Đang kích hoạt bản mới đã tải về…';
      return;
    }
    const state = await readUpdaterState();
    updater.textContent = describeUpdater(state);
    updater.hidden = false;

    const result = await chrome.runtime.sendMessage({ type: 'check-release' });
    switch (result?.state) {
      case 'available':
        status.textContent = state
          ? `Có bản v${result.version}. Trình cập nhật sẽ cài trong lần kiểm tra tới, hoặc tải thủ công:`
          : `Có bản v${result.version}.`;
        update.href = result.url;
        update.hidden = false;
        help.hidden = false;
        break;
      case 'current':
        status.textContent = 'Bạn đang dùng bản mới nhất.';
        break;
      case 'missing':
        status.textContent = 'Chưa có bản phát hành công khai trên GitHub.';
        retry.hidden = false;
        break;
      case 'missing-asset':
        status.textContent = `Bản v${result.version} chưa có file ZIP.`;
        retry.hidden = false;
        break;
      default:
        throw new Error('Release lookup failed');
    }
  } catch {
    status.textContent = 'Không kiểm tra được GitHub. Vui lòng thử lại.';
    retry.hidden = false;
  }
}

retry.addEventListener('click', () => { void checkForUpdate(); });
void checkForUpdate();
