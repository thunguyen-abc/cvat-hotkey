"""Regression test for CVAT Event Hotkeys against a simulated CVAT job page.

Loads the extension as an unpacked extension (Developer mode on) into Playwright's
Chromium, serves tests/fake-cvat.html at https://cvat-tai.abcstudio.online/tasks/12/jobs/77,
fakes the CVAT API, and logs every request that reaches the "server".

Checks:
  - Range Edit (add / replace / remove selected / remove all) changes only tags inside the
    range, never duplicates, keeps shapes, makes no request and no page reload, and resets
    Start/End afterwards.
  - A change between preview and Apply is detected instead of applied blindly.
  - CVAT's own Save then uploads only the changed tags.
  - Clear All Tags works locally with no request.
  - Complete & Next uses the in-memory session, saves through CVAT, retries a 503 politely,
    finds the next job with one filtered page_size=1 query, and opens it.

Usage:  python tests/simulated_cvat.py [path-to-chrome.exe]
Default browser: the newest Playwright Chromium in %LOCALAPPDATA%/ms-playwright.
"""
import glob
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
HTML = (ROOT / 'tests' / 'fake-cvat.html').read_text(encoding='utf-8')
ORIGIN = 'https://cvat-tai.abcstudio.online'
PORT = 9339


def find_chrome():
    if len(sys.argv) > 1:
        return sys.argv[1]
    base = os.path.join(os.environ.get('LOCALAPPDATA', ''), 'ms-playwright')
    found = sorted(glob.glob(os.path.join(base, 'chromium-*', 'chrome-win64', 'chrome.exe')))
    if not found:
        sys.exit('Chromium not found; pass the path to chrome.exe')
    return found[-1]


class FakeServer:
    def __init__(self):
        self.log = []
        self.job_state = {77: 'in progress', 80: 'new', 60: 'new'}
        self.fail_job_get_once = False
        self.next_id = 50000

    def mark(self):
        return len(self.log)

    def since(self, mark):
        return self.log[mark:]

    def handle(self, route, request):
        url = urlparse(request.url)
        path, query = url.path, parse_qs(url.query)
        if path.startswith('/tasks/'):
            return route.fulfill(status=200, content_type='text/html; charset=utf-8', body=HTML)
        body = request.post_data or ''
        entry = {'t': time.monotonic(), 'method': request.method, 'path': path, 'query': url.query, 'bytes': len(body)}
        self.log.append(entry)

        def reply(data, status=200, headers=None):
            route.fulfill(status=status, content_type='application/json', body=json.dumps(data), headers=headers or {})

        if path == '/api/users/self':
            return reply({'id': 5, 'username': 'annotator'})
        match = re.fullmatch(r'/api/jobs/(\d+)', path)
        if match:
            job_id = int(match.group(1))
            if request.method == 'PATCH':
                self.job_state[job_id] = json.loads(body)['state']
            elif self.fail_job_get_once:
                self.fail_job_get_once = False
                entry['status'] = 503
                return reply({'detail': 'busy'}, 503, {'Retry-After': '1'})
            return reply({'id': job_id, 'task_id': 12, 'state': self.job_state.get(job_id), 'assignee': {'id': 5},
                          'organization': None})
        if path == '/api/jobs':
            rules = json.loads(query['filter'][0])['and']
            entry['filter'] = rules
            assert query['page_size'] == ['1'], query
            comparison = next(op for rule in rules for op in rule if op in ('>', '<'))
            candidates = [80] if comparison == '>' else [60]
            results = [{'id': i, 'task_id': 12, 'assignee': {'id': 5}, 'state': self.job_state[i]} for i in candidates]
            return reply({'count': len(results), 'next': None, 'results': results})
        match = re.fullmatch(r'/api/jobs/\d+/annotations', path)
        if match and request.method == 'PATCH':
            data = json.loads(body)
            entry['action'] = query['action'][0]
            entry['tags'] = len(data['tags'])
            for tag in data['tags']:
                if tag.get('id') is None:
                    self.next_id += 1
                    tag['id'] = self.next_id
            return reply({'version': 2, 'tags': data['tags'], 'shapes': [], 'tracks': []})
        entry['status'] = 404
        return reply({'detail': 'not simulated'}, 404)


def main():
    chrome = find_chrome()
    profile = tempfile.mkdtemp(prefix='cvat-sim-')
    proc = subprocess.Popen([chrome, '--headless=new', f'--remote-debugging-port={PORT}',
                             '--enable-unsafe-extension-debugging', f'--user-data-dir={profile}',
                             '--no-first-run', 'about:blank'])
    server = FakeServer()
    failures = []

    def check(condition, message):
        print(('  ok   ' if condition else '  FAIL ') + message)
        if not condition:
            failures.append(message)

    try:
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
            setup = context.new_page()
            setup.goto('chrome://extensions')
            setup.evaluate('chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode: true})')
            setup.close()
            browser.new_browser_cdp_session().send('Extensions.loadUnpacked', {'path': str(ROOT)})
            context.route(f'{ORIGIN}/**', server.handle)

            page = context.new_page()
            page.goto(f'{ORIGIN}/tasks/12/jobs/77')
            page.wait_for_selector('.cvat-range-buttons button')
            page.wait_for_selector('text=Complete & Next')
            sim = lambda expression: page.evaluate(f'window.__sim.{expression}')
            tags_by_frame = lambda: page.evaluate('Object.fromEntries([...Array(100).keys()].map((f) => [f, window.__sim.tagsOn(f)]))')
            shapes = sim('count("shape")')
            status = page.locator('#cvat-event-complete-status')
            start, end, edit = (page.locator('.cvat-range-buttons button').nth(i) for i in range(3))

            def run_edit(low, high, mode, sources=(), target=None, expect_preview=None, tamper=None):
                sim('takeReads()')
                exports_before = sim('exports')
                sim(f'setFrame({low})'); start.click()
                sim(f'setFrame({high})'); end.click()
                edit.click()
                dialog = page.locator('dialog.cvat-range-dialog')
                dialog.locator('select').first.wait_for()
                page.wait_for_function('!document.querySelector("dialog.cvat-range-dialog select").disabled')
                dialog.locator('select').first.select_option(mode)
                for label in sources:
                    dialog.locator(f'.cvat-range-chips button[data-label-id="{label}"]').click()
                if target is not None:
                    dialog.locator('select').nth(1).select_option(str(target))
                preview = dialog.locator('p[role="status"]').inner_text()
                if expect_preview:
                    check(expect_preview in preview, f'preview "{preview}" contains "{expect_preview}"')
                if tamper:
                    sim(tamper)
                    dialog.locator('button', has_text='Áp dụng').click()
                    page.wait_for_function('document.querySelector("dialog.cvat-range-dialog p[role=status]")'
                                           '.textContent.includes("Dữ liệu vừa thay đổi")')
                    check(True, 'stale data detected; nothing applied blindly')
                dialog.locator('button', has_text='Áp dụng').click()
                page.wait_for_selector('dialog.cvat-range-dialog', state='detached')
                reads = sim('takeReads()')
                check(reads and all(low <= f <= high for f in reads), f'{mode}: only frames {low}-{high} read ({len(reads)} reads)')
                check(sim('exports') == exports_before, f'{mode}: no whole-job export')
                return status.inner_text()

            def assert_range_edit(name, low, high, before, after):
                outside = [f for f in range(100) if not (low <= f <= high)]
                check(all(before[str(f)] == after[str(f)] for f in outside), f'{name}: frames outside {low}-{high} unchanged')
                check(all(len(set(v)) == len(v) for v in after.values()), f'{name}: no duplicate tags on any frame')
                check(sim('count("shape")') == shapes, f'{name}: shapes untouched')
                check(start.inner_text() == f'Start {low}' and end.inner_text() == f'End {high}', f'{name}: Start/End kept')
                check(page.evaluate('!document.querySelector(".cvat-range-band").hidden'), f'{name}: range still highlighted')
                check(page.evaluate('window.__sim.state.annotation.canvas.ready'), f'{name}: CVAT canvas still ready (no stuck loading)')

            print('Range editor (local only)')
            mark = server.mark()
            before = tags_by_frame()
            message = run_edit(10, 30, 'add', target=1, expect_preview='Thêm 13')
            after = tags_by_frame()
            check(all(1 in after[str(f)] for f in range(10, 31) if f not in (12, 13)), 'add: every valid frame has event_smoke')
            check(after['13'] == before['13'], 'add: deleted frame 13 not tagged')
            check('Chưa lưu lên server' in message, f'status explains saving: {message[:70]}…')
            assert_range_edit('add', 10, 30, before, after)

            before = tags_by_frame()
            run_edit(0, 20, 'replace', sources=[1], target=3)
            after = tags_by_frame()
            check(all(1 not in after[str(f)] for f in range(0, 21)), 'replace: no event_smoke left in 0-20')
            check(all((3 in after[str(f)]) == (1 in before[str(f)] or 3 in before[str(f)]) for f in range(0, 21)),
                  'replace: event_phone exactly where event_smoke was')
            assert_range_edit('replace', 0, 20, before, after)

            before = tags_by_frame()
            run_edit(40, 60, 'remove', sources=[2], tamper='addTag(45, 2)')
            after = tags_by_frame()
            check(all(2 not in after[str(f)] for f in range(40, 61)), 'remove: no event_drinking left in 40-60 (incl. tampered tag)')
            check(all(1 in after[str(f)] for f in range(40, 61) if 1 in before[str(f)]), 'remove: other tags kept')
            assert_range_edit('remove', 40, 60, before, after)

            before = tags_by_frame()
            run_edit(90, 99, 'all')
            after = tags_by_frame()
            check(all(after[str(f)] == [] for f in range(90, 100)), 'all: no tags left in 90-99')
            assert_range_edit('all', 90, 99, before, after)

            check(server.since(mark) == [], f'range editor made {len(server.since(mark))} server requests')
            check(page.evaluate('sessionStorage.getItem("loads")') == '1', 'no page reload')
            check(page.evaluate('window.__sim.refreshes') >= 4, 'CVAT view refreshed after each Apply')

            print('Edit again on the kept range')
            sim('takeReads()')
            edit.click()
            page.wait_for_function('document.querySelector("dialog.cvat-range-dialog select") && '
                                   '!document.querySelector("dialog.cvat-range-dialog select").disabled')
            summary = page.locator('dialog.cvat-range-dialog .cvat-range-summary').inner_text()
            check('90' in summary and '99' in summary, f'Edit reopens on the kept range without re-marking ({summary})')
            check(sim('takeReads()') == [], 'reopening reads nothing: changed frames were re-cached after Apply')
            page.locator('dialog.cvat-range-dialog button', has_text='Hủy').click()
            page.wait_for_selector('dialog.cvat-range-dialog', state='detached')

            print('Tag cache')
            def open_and_cancel(low, high):
                sim(f'setFrame({low})'); start.click()
                sim(f'setFrame({high})'); end.click()
                edit.click()
                page.wait_for_function('document.querySelector("dialog.cvat-range-dialog select") && '
                                       '!document.querySelector("dialog.cvat-range-dialog select").disabled')
                page.locator('dialog.cvat-range-dialog button', has_text='Hủy').click()
                page.wait_for_selector('dialog.cvat-range-dialog', state='detached')
            def frames_read():
                return sorted(set(sim('takeReads()')))
            sim('takeReads()')
            open_and_cancel(20, 40)
            first = frames_read()
            check(first == list(range(20, 41)), f'first open reads frames 20-40 only ({len(first)} frames)')
            open_and_cancel(25, 45)
            second = frames_read()
            check(second == list(range(41, 46)), f'overlapping range 25-45 reads only the missing frames {second}')
            sim('setFrame(70)')
            open_and_cancel(20, 45)
            check(frames_read() == [], 'reopening after changing frame reads nothing')
            page.evaluate('window.__sim.userAddTag(30, 3)')
            open_and_cancel(25, 45)
            check(frames_read() == list(range(25, 46)), 'a CVAT annotation action invalidates the cache')
            sim('setFrame(5)'); start.click()

            print('Native CVAT save after the edits')
            mark = server.mark()
            unsaved = page.evaluate('window.__sim.job.annotations.hasUnsavedChanges()')
            page.locator('.cvat-annotation-header-save-button').click()
            page.wait_for_function('!window.__sim.state.annotation.annotations.saving.uploading && '
                                   '!window.__sim.job.annotations.hasUnsavedChanges()')
            saves = server.since(mark)
            check(unsaved, 'edits were pending before Save')
            check([e['action'] for e in saves] == ['delete', 'create'], f'save used {len(saves)} requests: '
                  + ', '.join(f"{e['action']}({e['tags']})" for e in saves))
            check(page.evaluate('sessionStorage.getItem("loads")') == '1', 'Save did not reload the page')
            check(start.inner_text().startswith('Start ') and end.inner_text().startswith('End '), 'Start/End kept after Save')

            print('Clear All Tags (local only)')
            mark = server.mark()
            page.get_by_role('button', name='Clear All Tags').click()
            confirm = page.locator('dialog button', has_text='Xóa toàn bộ tag')
            page.wait_for_function('[...document.querySelectorAll("dialog button")].some((b) => '
                                   'b.textContent === "Xóa toàn bộ tag" && !b.disabled)')
            confirm.click()
            page.wait_for_function('document.querySelector("#cvat-event-complete-status").textContent.startsWith("Đã xóa")')
            check(sim('count("tag")') == 0, 'all tags removed in the browser')
            check(sim('count("shape")') == shapes, 'shapes untouched')
            check(server.since(mark) == [], 'Clear All made no server request')
            check(page.evaluate('sessionStorage.getItem("loads")') == '1', 'Clear All did not reload the page')

            print('Complete & Next')
            mark = server.mark()
            server.fail_job_get_once = True
            page.get_by_role('button', name='Complete & Next').click()
            page.wait_for_url('**/tasks/12/jobs/80', timeout=30000)
            calls = server.since(mark)
            for e in calls:
                extra = e.get('action') or ('filter' if e.get('filter') else '') or ''
                print(f"       {e['method']:5} {e['path']} {extra} {e.get('tags', '')} {e.get('status', 200)}")
            paths = [(e['method'], e['path']) for e in calls]
            check(('GET', '/api/users/self') not in paths, 'user read from CVAT state, not requested')
            check(page.evaluate('sessionStorage.getItem("cvat-event-range:77")') is None, 'Start/End of the completed job cleared')
            check([e['action'] for e in calls if 'action' in e] == ['delete'], 'Finish saved only the cleared tags, one request')
            job_gets = [e for e in calls if (e['method'], e['path']) == ('GET', '/api/jobs/77')]
            check(len(job_gets) == 2 and job_gets[0].get('status') == 503, '503 retried once')
            check(job_gets[1]['t'] - job_gets[0]['t'] >= 0.95, f"retry waited Retry-After ({job_gets[1]['t'] - job_gets[0]['t']:.2f}s)")
            lists = [e for e in calls if e['path'] == '/api/jobs']
            check(len(lists) == 1, f'next job found with {len(lists)} list request(s)')
            rules = json.dumps(lists[0]['filter']) if lists else ''
            check('"annotator"' in rules and '{">": [{"var": "id"}, 77]}' in rules, 'list request filtered by assignee and id on the server')
            gets = [e for e in calls if e['method'] == 'GET']
            gaps = [b['t'] - a['t'] for a, b in zip(gets, gets[1:])]
            check(all(g >= 0.24 for g in gaps), 'extension GETs spaced ≥ 250 ms')
            browser.close()
    finally:
        proc.kill()
        time.sleep(0.5)
        shutil.rmtree(profile, ignore_errors=True)

    print()
    print('FAILED: ' + str(len(failures)) if failures else 'ALL CHECKS PASSED')
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
