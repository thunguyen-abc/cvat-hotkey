const installed = document.getElementById('installed');
const status = document.getElementById('status');
const install = document.getElementById('install');
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

function formatTime(value) {
  const time = Date.parse(value);
  return Number.isFinite(time)
    ? new Date(time).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' })
    : 'chưa rõ';
}

function describeUpdater(state, helper) {
  if (helper?.ok) {
    const mode = helper.mode === 'auto' ? 'tự cài bản mới' : 'hỏi trước khi cài';
    return `Trình cập nhật: ${mode}. Kiểm tra lần cuối ${formatTime(helper.lastCheck)}.`;
  }
  if (helper?.error === 'forbidden' || helper?.error === 'origin') {
    return `Trình cập nhật chưa nhận extension này (ID ${helper.extensionId}). Chạy lại updater\\Setup-Updater.cmd để bật nút Cập nhật ngay.`;
  }
  if (state) {
    return `Trình cập nhật đang chạy theo lịch (kiểm tra lần cuối ${formatTime(state.lastCheck)}). Nút Cập nhật ngay có sau lần kiểm tra kế tiếp, hoặc chạy lại updater\\Setup-Updater.cmd.`;
  }
  return 'Chưa cài trình cập nhật. Chạy updater\\Setup-Updater.cmd trong thư mục extension một lần để cập nhật bằng một nút bấm.';
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The updater writes updater-state.json when it finishes; wait for a result newer than the click.
async function waitForResult(since, version) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await wait(1500);
    const state = await readUpdaterState();
    if (!state || !(Date.parse(state.lastCheck) >= since - 2000)) continue;
    switch (state.result) {
      case 'installed':
        status.textContent = `Đã cài v${version}. Đang kích hoạt…`;
        await chrome.runtime.sendMessage({ type: 'activate-local-update' });
        return;
      case 'current':
        status.textContent = 'Bạn đang dùng bản mới nhất.';
        return;
      case 'declined':
        status.textContent = 'Đã hủy cài đặt.';
        install.disabled = false;
        return;
      default:
        status.textContent = String(state.message || 'Không cài được bản mới.');
        install.disabled = false;
        return;
    }
  }
  status.textContent = 'Chưa thấy kết quả. Chạy updater\\Setup-Updater.cmd status để xem nhật ký.';
  install.disabled = false;
}

async function installNow(version) {
  install.disabled = true;
  status.textContent = `Đang tải và cài v${version}… Có thể đóng cửa sổ này.`;
  const since = Date.now();
  const result = await chrome.runtime.sendMessage({ type: 'install-update' });
  if (!result?.ok) {
    status.textContent = 'Không gọi được trình cập nhật. Dùng nút Update để tải thủ công.';
    install.disabled = false;
    update.hidden = false;
    return;
  }
  if (result.running) status.textContent = 'Trình cập nhật đang chạy. Đang chờ kết quả…';
  await waitForResult(since, version);
}

async function checkForUpdate() {
  status.textContent = 'Đang kiểm tra bản mới…';
  retry.hidden = true;
  install.hidden = true;
  update.hidden = true;
  help.hidden = true;
  try {
    const local = await chrome.runtime.sendMessage({ type: 'activate-local-update' });
    if (local?.reloading) {
      status.textContent = 'Đang kích hoạt bản mới đã tải về…';
      return;
    }
    const [state, helper] = await Promise.all([readUpdaterState(), chrome.runtime.sendMessage({ type: 'updater-status' })]);
    updater.textContent = describeUpdater(state, helper);
    updater.hidden = false;

    const result = await chrome.runtime.sendMessage({ type: 'check-release' });
    switch (result?.state) {
      case 'available':
        status.textContent = `Có bản v${result.version}.`;
        update.href = result.url;
        if (helper?.ok) {
          install.hidden = false;
          install.onclick = () => { void installNow(result.version); };
        } else {
          update.hidden = false;
          help.hidden = false;
        }
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
