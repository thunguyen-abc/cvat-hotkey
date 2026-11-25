"""End-to-end test of the "Cập nhật ngay" button (native messaging) on Windows.

1. Copies the extension to a temporary folder and marks it as an older version.
2. Runs the updater's setup in test mode (CVAT_HOTKEYS_UPDATER_HOME): the native host is
   registered for Chromium only (HKCU\\Software\\Chromium\\NativeMessagingHosts), so the
   real Chrome and Edge are not touched.
3. Loads the copy as an unpacked extension into Playwright's Chromium, opens the popup
   page and clicks "Cập nhật ngay".
4. Expects the updater to install the latest GitHub release into the folder and the
   extension to activate it without any manual step.
Everything is removed afterwards (registry key, scheduled task, temporary folders).

Needs network access to GitHub and a published release newer than FAKE_VERSION.
Usage:  python tests/native_update.py [path-to-chrome.exe]
"""
import glob
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
FAKE_VERSION = '1.6.0'
PORT = 9341
FILES = ['manifest.json', 'range-plan.js', 'cvat-bridge.js', 'bridge-client.js', 'hotkeys.js', 'range-editor.js',
         'complete-next.js', 'complete-next.css', 'updates.js', 'update.html', 'update.js']


def chrome_path():
    if len(sys.argv) > 1:
        return sys.argv[1]
    base = os.path.join(os.environ.get('LOCALAPPDATA', ''), 'ms-playwright')
    return sorted(glob.glob(os.path.join(base, 'chromium-*', 'chrome-win64', 'chrome.exe')))[-1]


def powershell(script, args, env, stdin=''):
    return subprocess.run(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(script), *args],
                          input=stdin, capture_output=True, text=True, encoding='utf-8', errors='replace', env=env, timeout=180)


def main():
    latest = json.load(urllib.request.urlopen('https://api.github.com/repos/thunguyen-abc/cvat-hotkey/releases/latest'))['tag_name'][1:]
    tmp = pathlib.Path(tempfile.mkdtemp(prefix='cvat-native-'))
    ext, home, profile = tmp / 'ext', tmp / 'home', tmp / 'profile'
    (ext / 'updater').mkdir(parents=True)
    for name in FILES:
        shutil.copy(ROOT / name, ext / name)
    for name in ['cvat-hotkey-updater.ps1', 'Setup-Updater.cmd']:
        shutil.copy(ROOT / 'updater' / name, ext / 'updater' / name)
    manifest = json.loads((ext / 'manifest.json').read_text(encoding='utf-8'))
    manifest['version'] = FAKE_VERSION
    (ext / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    env = {**os.environ, 'CVAT_HOTKEYS_UPDATER_HOME': str(home)}
    script = ext / 'updater' / 'cvat-hotkey-updater.ps1'
    failures = []
    proc = None

    def check(condition, message):
        print(('  ok   ' if condition else '  FAIL ') + message)
        if not condition:
            failures.append(message)

    try:
        print(f'Setup (test mode), fake install v{FAKE_VERSION}, latest release v{latest}')
        result = powershell(script, ['setup', '-ExtensionDir', str(ext), '-Mode', 'confirm', '-Yes'], env, stdin='n\n')
        check(result.returncode == 0, f'setup exit code {result.returncode}')
        # The test task would otherwise fire during the test with the real data folder.
        subprocess.run(['powershell.exe', '-NoProfile', '-Command',
                        "Unregister-ScheduledTask -TaskName 'CVAT Event Hotkeys Updater (test)' -Confirm:$false"], capture_output=True)
        host = json.loads((home / 'com.abcstudio.cvat_event_hotkeys.json').read_text(encoding='utf-8'))
        check(isinstance(host['allowed_origins'], list) and len(host['allowed_origins']) == 1, f"host manifest origins {host['allowed_origins']}")
        reg = subprocess.run(['reg', 'query', r'HKCU\Software\Chromium\NativeMessagingHosts\com.abcstudio.cvat_event_hotkeys', '/ve'],
                             capture_output=True, text=True)
        check(str(home / 'com.abcstudio.cvat_event_hotkeys.json') in reg.stdout, 'host registered for Chromium')
        check(json.loads((ext / 'manifest.json').read_text(encoding='utf-8'))['version'] == FAKE_VERSION, 'setup did not install (answered no)')

        proc = subprocess.Popen([chrome_path(), '--headless=new', f'--remote-debugging-port={PORT}', '--enable-unsafe-extension-debugging',
                                 f'--user-data-dir={profile}', '--no-first-run', 'about:blank'], env=env)
        deadline = time.time() + 30
        while True:
            try:
                urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/version', timeout=1).read()
                break
            except OSError:
                if time.time() > deadline:
                    raise
                time.sleep(0.5)
        with sync_playwright() as p:
            browser = p.chromium.connect_over_cdp(f'http://127.0.0.1:{PORT}')
            context = browser.contexts[0]
            dev = context.new_page()
            dev.goto('chrome://extensions')
            dev.evaluate('chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode: true})')
            ext_id = browser.new_browser_cdp_session().send('Extensions.loadUnpacked', {'path': str(ext)})['id']
            check(host['allowed_origins'] == [f'chrome-extension://{ext_id}/'], f'computed extension ID matches Chrome ({ext_id})')

            print('Popup: click "Cập nhật ngay"')
            popup = context.new_page()
            popup.goto(f'chrome-extension://{ext_id}/update.html')
            popup.wait_for_selector('#install:not([hidden])', timeout=20000)
            check('Trình cập nhật' in popup.locator('#updater').inner_text(), 'popup sees the updater: ' + popup.locator('#updater').inner_text()[:60])
            started = time.time()
            popup.click('#install')
            disk = FAKE_VERSION
            while time.time() - started < 120 and disk != latest:
                time.sleep(1)
                disk = json.loads((ext / 'manifest.json').read_text(encoding='utf-8'))['version']
            check(disk == latest, f'files on disk updated to v{disk} in {time.time() - started:.0f}s')
            version = None
            while time.time() - started < 150:
                time.sleep(1)
                info = dev.evaluate('chrome.developerPrivate.getExtensionsInfo().then((l) => l.map((e) => [e.id, e.version, e.state]))')
                version = next((v for i, v, st in info if i == ext_id and st == 'ENABLED'), None)
                if version == latest:
                    break
            check(version == latest, f'Chrome now runs v{version} (no Reload click, no unzip)')
            backups = list((home / 'backups').iterdir())
            check(len(backups) == 1 and backups[0].name.startswith(f'v{FAKE_VERSION}-'), 'previous version backed up')
            browser.close()
    finally:
        if proc:
            proc.kill()
        # The installed release may ship an older updater; uninstall with this checkout's script.
        powershell(ROOT / 'updater' / 'cvat-hotkey-updater.ps1', ['uninstall', '-Yes'], env)
        left = subprocess.run(['reg', 'query', r'HKCU\Software\Chromium\NativeMessagingHosts\com.abcstudio.cvat_event_hotkeys'],
                              capture_output=True, text=True)
        print('  cleanup: registry key removed' if left.returncode else '  cleanup: REGISTRY KEY LEFT')
        if proc:
            proc.wait(timeout=10)
        for _ in range(10):  # Chromium child processes may still hold profile files for a moment
            shutil.rmtree(tmp, ignore_errors=True)
            if not tmp.exists():
                break
            time.sleep(0.5)

    print()
    print('FAILED: ' + str(len(failures)) if failures else 'ALL CHECKS PASSED')
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
