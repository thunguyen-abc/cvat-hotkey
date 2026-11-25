const repository = 'thunguyen-abc/cvat-hotkey';
const alarmName = 'check-github-release';
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

async function startChecks() {
  await chrome.alarms.create(alarmName, { periodInMinutes: 360 });
  await safeCheck();
}

chrome.runtime.onInstalled.addListener(() => { void startChecks(); });
chrome.runtime.onStartup.addListener(() => { void startChecks(); });
chrome.alarms.onAlarm.addListener(({ name }) => {
  if (name === alarmName) void safeCheck();
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.url !== chrome.runtime.getURL('update.html') || message?.type !== 'check-release') return false;
  void (async () => respond(await safeCheck()))();
  return true;
});
