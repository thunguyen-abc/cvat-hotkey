const installed = document.getElementById('installed');
const status = document.getElementById('status');
const update = document.getElementById('update');
const retry = document.getElementById('retry');
const help = document.getElementById('install-help');

installed.textContent = `Đang dùng v${chrome.runtime.getManifest().version}`;

async function checkForUpdate() {
  status.textContent = 'Đang kiểm tra bản mới…';
  retry.hidden = true;
  update.hidden = true;
  help.hidden = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'check-release' });
    switch (result?.state) {
      case 'available':
        status.textContent = `Có bản v${result.version}.`;
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
