const repository = 'thunguyen-abc/cvat-hotkey';
const alarmName = 'check-github-release';
const localAlarmName = 'check-local-files';
const installedVersion = chrome.runtime.getManifest().version;

function parseVersion(value) {
  if (typeof value !== 'string' || !/^v?\d{1,5}(?:\.\d{1,5}){2,3}$/.test(value)) return null;
  return value.replace(/^v/, '').split('.').map(Number);
}

function isNewer(release, installed) {
  const candidate = parseVersion(release);
  const current = parseVersion(installed);
  if (!candidate || !current) return false;
  for (let index = 0; index < 4; index += 1) {
    const difference = (candidate[index] ?? 0) - (current[index] ?? 0);
    if (difference) return difference > 0;
  }
  return false;
}

async function checkRelease() {
  const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' },
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.timeout(12000),
  });
  if (response.status === 404) return { state: 'missing' };
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);

  const release = await response.json();
  if (release.draft || release.prerelease || !parseVersion(release.tag_name)) return { state: 'missing' };
  if (!isNewer(release.tag_name, installedVersion)) {
    await chrome.action.setBadgeText({ text: '' });
    return { state: 'current' };
  }

  const version = release.tag_name.replace(/^v/, '');
  const filename = `cvat-event-hotkeys-v${version}.zip`;
  const url = `https://github.com/${repository}/releases/download/${release.tag_name}/${filename}`;
  const asset = release.assets?.find((item) =>
    item.name === filename && item.state === 'uploaded' && item.browser_download_url === url);
  if (!asset) return { state: 'missing-asset', version };

  await chrome.action.setBadgeBackgroundColor({ color: '#146c43' });
  await chrome.action.setBadgeText({ text: 'NEW' });
  return { state: 'available', version, url };
}

async function safeCheck() {
  try {
    return await checkRelease();
  } catch {
    return { state: 'error' };
  }
}

// The desktop updater (updater/cvat-hotkey-updater.ps1) replaces the files of an
// unpacked install on disk, writing manifest.json last. Chrome keeps running the
// version it loaded, so compare the manifest on disk with the running one and
// reload the extension once the new files are complete. Reloading the extension
// does not reload CVAT tabs; open tabs keep the old scripts until they reload.
async function activateLocalUpdate() {
  try {
    const response = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' });
    if (!response.ok) return false;
    const manifest = await response.json();
    if (manifest?.name !== chrome.runtime.getManifest().name) return false;
    // Any change counts: a newer release, or an older one restored by `rollback`.
    if (!parseVersion(manifest.version) || manifest.version === installedVersion) return false;
    chrome.runtime.reload();
    return true;
  } catch {
    return false;
  }
}

async function startChecks() {
  await chrome.alarms.create(alarmName, { periodInMinutes: 360 });
  await chrome.alarms.create(localAlarmName, { periodInMinutes: 1 });
  if (await activateLocalUpdate()) return;
  await safeCheck();
}

chrome.runtime.onInstalled.addListener(() => { void startChecks(); });
chrome.runtime.onStartup.addListener(() => { void startChecks(); });
chrome.alarms.onAlarm.addListener(({ name }) => {
  if (name === alarmName) void safeCheck();
  if (name === localAlarmName) void activateLocalUpdate();
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.url !== chrome.runtime.getURL('update.html')) return false;
  if (message?.type === 'check-release') {
    void (async () => respond(await safeCheck()))();
    return true;
  }
  if (message?.type === 'activate-local-update') {
    void (async () => respond({ reloading: await activateLocalUpdate() }))();
    return true;
  }
  return false;
});
