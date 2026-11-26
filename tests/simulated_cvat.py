"""Regression test for CVAT Event Hotkeys against a simulated CVAT job page.

Loads the extension as an unpacked extension (Developer mode on) into Playwright's
Chromium, serves tests/fake-cvat.html at https://cvat-tai.abcstudio.online/tasks/12/jobs/77,
fakes the CVAT API, and logs every request that reaches the "server".

Checks:
  - Nâng cao dialog (add / replace / remove selected / remove all, several at once) changes
    only tags inside the range, never duplicates, keeps shapes, makes no request and no page
    reload, and keeps Start/End.
  - Quickstart panel: exactly three event boxes, 4/5 marks, Alt+1-3 toggles, = / - queue,
    Enter applies; keys it takes never reach CVAT's shortcut handler, other keys do.
  - A change between preview and Apply is detected instead of applied blindly.
  - CVAT's own Save then uploads only the changed tags.
  - Clear All Tags shows the job's tag count and clears locally, like Apply: no request, no
    reload, view refreshed in place, Start/End, queue and range cache kept.
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
        if path == '/api/jobs' and 'filter' not in query:
            entry['scan'] = True
            jobs = [{'id': i, 'task_id': 12, 'assignee': {'id': 5}, 'state': self.job_state[i]} for i in sorted(self.job_state)]
            return reply({'count': len(jobs), 'next': None, 'results': jobs})
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
            page.wait_for_selector('.cvat-quick-panel .cvat-quick-start')
            page.wait_for_selector('text=Complete & Next')
            sim = lambda expression: page.evaluate(f'window.__sim.{expression}')
            tags_by_frame = lambda: page.evaluate('Object.fromEntries([...Array(100).keys()].map((f) => [f, window.__sim.tagsOn(f)]))')
            tag_count = lambda: sim('count("tag")')
            shapes = sim('count("shape")')
            status = page.locator('#cvat-event-complete-status')
            panel = page.locator('.cvat-quick-panel')
            frame_position = panel.locator('.cvat-quick-frame-position')
            start, end, advanced = (panel.locator(c) for c in ('.cvat-quick-start', '.cvat-quick-end', '.cvat-quick-advanced'))
            rows = panel.locator('.cvat-quick-row')
            info = panel.locator('.cvat-quick-info')
            quick_apply = panel.locator('.cvat-quick-apply')
            event = lambda name: panel.locator(f'.cvat-quick-event[data-event="{name}"]')
            pressed = lambda name: event(name).get_attribute('aria-pressed') == 'true'
            blur = lambda: page.evaluate('document.activeElement && document.activeElement.blur()')
            native = lambda: page.evaluate('window.__sim.nativeKeys.splice(0)')
            EVENTS = ('event_smoke', 'event_drinking', 'event_phone')

            def wait(expression, message, timeout=5000):
                try:
                    page.wait_for_function(expression, timeout=timeout)
                    return True
                except Exception:
                    check(False, message)
                    return False

            def wait_ready():
                return wait('!document.querySelector(".cvat-quick-advanced").disabled', 'panel ready')

            def badge_matches(message):
                if wait('document.querySelector(".cvat-clear-count") && !document.querySelector(".cvat-clear-count").hidden && '
                        'document.querySelector(".cvat-clear-count").textContent === String(window.__sim.count("tag"))',
                        f'{message}: Clear All Tags count matches the job'):
                    check(True, f'{message}: Clear All Tags shows {tag_count()} tags')

            def set_range(low, high):
                sim(f'setFrame({low})'); start.click()
                sim(f'setFrame({high})'); end.click()
                wait_ready()

            def select_only(*names):
                for name in EVENTS:
                    if pressed(name) != (name in names):
                        event(name).click()

            def expected_after(before, low, high, ops, valid):
                result = {}
                for f in range(100):
                    tags = list(before[str(f)])
                    if low <= f <= high:
                        for op in ops:
                            if op[0] == 'remove':
                                tags = [t for t in tags if t not in op[1]]
                            elif op[0] == 'replace':
                                src, dst = op[1][0], op[2]
                                if src in tags:
                                    tags = [t for t in tags if t != src]
                                    if dst not in tags:
                                        tags.append(dst)
                            elif op[0] == 'add' and f in valid and op[2] not in tags:
                                tags.append(op[2])
                    result[str(f)] = sorted(tags)
                return result
            VALID = set(range(100)) - {12, 13}

            print('Quickstart frame position')
            check(frame_position.inner_text() == '0/100', 'player shows frame offset and inclusive job size before marking')
            position_mark = server.mark()
            sim('setFrame(99)')
            check(frame_position.inner_text() == '99/100', 'position updates as the player moves')
            page.evaluate("""() => {
                const handle = document.querySelector('.cvat-player-slider [role="slider"]');
                handle.setAttribute('aria-valuemin', '6400');
                handle.setAttribute('aria-valuemax', '6599');
                handle.setAttribute('aria-valuenow', '6400');
            }""")
            check(frame_position.inner_text() == '0/200', 'a job starting at 6400 starts at position 0/200')
            panel.locator('.cvat-quick-toggle').click()
            check(frame_position.is_visible() and start.is_visible(), 'position and marks stay visible when collapsed')
            panel.locator('.cvat-quick-toggle').click()
            page.evaluate("""() => {
                const handle = document.querySelector('.cvat-player-slider [role="slider"]');
                handle.setAttribute('aria-valuemin', '0');
                handle.setAttribute('aria-valuemax', '99');
                window.__sim.setFrame(0);
            }""")
            check(server.since(position_mark) == [] and sim('takeReads()') == [], 'navigation adds no requests or annotation reads')

            print('Clear All Tags count')
            badge_matches('on job open')
            check(sim('statistics') > 0 and sim('exports') == 0, 'count read from CVAT statistics, no whole-job export')

            def run_edit(low, high, mode, sources=(), target=None, expect_preview=None, tamper=None):
                exports_before = sim('exports')
                set_range(low, high)
                page.wait_for_timeout(300)  # marking Start first may read an intermediate range
                sim('takeReads()')
                advanced.click()
                dialog = page.locator('dialog.cvat-range-dialog')
                dialog.locator('select').first.wait_for()
                page.wait_for_function('!document.querySelector("dialog.cvat-range-dialog select").disabled')
                card = dialog.locator('.cvat-operation-card').first
                card.locator('select').first.select_option(mode)
                for label in sources:
                    card.locator(f'.cvat-source-chips button[data-label-id="{label}"]').click()
                if target is not None:
                    card.locator(f'.cvat-target-chips button[data-label-id="{target}"]').click()
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

            print('Nâng cao dialog (local only)')
            mark = server.mark()
            before = tags_by_frame()
            message = run_edit(10, 30, 'add', target=1, expect_preview='Thêm 13')
            after = tags_by_frame()
            check(all(1 in after[str(f)] for f in range(10, 31) if f not in (12, 13)), 'add: every valid frame has event_smoke')
            check(after['13'] == before['13'], 'add: deleted frame 13 not tagged')
            check('Chưa lưu lên server' in message, f'status explains saving: {message[:70]}…')
            assert_range_edit('add', 10, 30, before, after)
            badge_matches('after Apply')

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

            print('Several operations in one dialog')
            before = tags_by_frame()
            sim('takeReads()')
            set_range(50, 70)
            advanced.click()
            dialog = page.locator('dialog.cvat-range-dialog')
            dialog.locator('.cvat-operation-card select').first.wait_for()
            first = dialog.locator('.cvat-operation-card').first
            check(first.locator('select').first.input_value() == 'replace', 'Nâng cao starts with "Đổi tag"')
            first.locator('select').first.select_option('add')
            offered = first.locator('.cvat-target-chips button').evaluate_all('(nodes) => nodes.map((n) => n.textContent)')
            check(offered == list(EVENTS), f'add offers only the three events {offered}')
            counts = page.evaluate('''() => Object.fromEntries([...document.querySelectorAll('.cvat-range-stat')]
                .map((n) => [n.firstChild.textContent, n.lastChild.textContent]))''')
            real = {name: str(sum(1 for f in range(50, 71) if label in before[str(f)]))
                    for name, label in [('event_smoke', 1), ('event_drinking', 2), ('event_phone', 3)]}
            check(counts == real, f'exactly three event counts at the top of the dialog {counts}')
            check('cigarette' not in counts, 'other tag labels are not shown as event boxes')
            check(dialog.locator('.cvat-range-count').count() == 0, 'no counts inside the chips')
            ops = [('remove', [2], None), ('replace', [1], 3), ('add', [], 2)]
            for index, (mode, sources, target) in enumerate(ops):
                if index:
                    dialog.locator('button', has_text='+ Thêm thao tác').click()
                card = dialog.locator('.cvat-operation-card').nth(index)
                card.locator('select').first.select_option(mode)
                for label in sources:
                    card.locator(f'.cvat-source-chips button[data-label-id="{label}"]').click()
                if target is not None:
                    card.locator(f'.cvat-target-chips button[data-label-id="{target}"]').click()
            check(dialog.locator('.cvat-operation-card').count() == 3, 'three operation cards in one dialog')
            check(dialog.locator('.cvat-range-stat[data-changed="true"]').count() > 0, 'top counts show now → after')
            preview = dialog.locator('p[role="status"]').inner_text()
            dialog.locator('button', has_text='Áp dụng').click()
            page.wait_for_selector('dialog.cvat-range-dialog', state='detached')
            after = tags_by_frame()
            check(after == expected_after(before, 50, 70, ops, VALID),
                  f'remove + replace + add applied together, matching an independent model ({preview})')
            check(all(len(set(v)) == len(v) for v in after.values()), 'batch: no duplicate tags')
            check(start.inner_text() == 'Start 50' and end.inner_text() == 'End 70', 'batch: Start/End kept')
            check(page.evaluate('window.__sim.state.annotation.canvas.ready'), 'batch: canvas still ready')

            print('Conflicting operations are blocked, not resolved silently')
            advanced.click()
            dialog.locator('.cvat-operation-card select').first.wait_for()
            card = dialog.locator('.cvat-operation-card').first
            card.locator('select').first.select_option('remove')
            card.locator('.cvat-source-chips button[data-label-id="3"]').click()
            dialog.locator('button', has_text='+ Thêm thao tác').click()
            second = dialog.locator('.cvat-operation-card').nth(1)
            check(second.locator('select').first.input_value() == 'replace', '"+ Thêm thao tác" starts as "Đổi tag"')
            check(second.locator('.cvat-source-chips button[data-label-id="4"]').count() == 1,
                  'non-event tags can still be chosen as a source in Nâng cao')
            check(second.locator('.cvat-source-chips button[data-label-id="3"]').count() == 0,
                  'card 2 offers only tags that still exist after card 1')
            second.locator('.cvat-target-chips button[data-label-id="1"]').click()
            problem = second.locator('.cvat-operation-problem').inner_text()
            check(bool(problem) and dialog.locator('button', has_text='Áp dụng').is_disabled(),
                  f'incomplete card blocks Apply with a reason ({problem})')
            dialog.locator('button', has_text='Hủy').click()
            page.wait_for_selector('dialog.cvat-range-dialog', state='detached')
            check(page.evaluate('document.activeElement === document.querySelector(".cvat-quick-advanced")'),
                  'Hủy returns focus to Nâng cao')

            check(server.since(mark) == [], f'range editor made {len(server.since(mark))} server requests')
            check(page.evaluate('sessionStorage.getItem("loads")') == '1', 'no page reload')
            check(page.evaluate('window.__sim.refreshes') >= 4, 'CVAT view refreshed after each Apply')

            print('Edit again on the kept range')
            page.wait_for_timeout(900)  # let the post-Apply re-read settle
            sim('takeReads()')
            advanced.click()
            page.wait_for_function('document.querySelector("dialog.cvat-range-dialog select") && '
                                   '!document.querySelector("dialog.cvat-range-dialog select").disabled')
            summary = page.locator('dialog.cvat-range-dialog .cvat-range-summary').inner_text()
            check('50' in summary and '70' in summary, f'Nâng cao reopens on the last marked range without re-marking ({summary})')
            check(sim('takeReads()') == [], 'reopening reads nothing: changed frames were re-cached after Apply')
            page.locator('dialog.cvat-range-dialog button', has_text='Hủy').click()
            page.wait_for_selector('dialog.cvat-range-dialog', state='detached')

            print('Quickstart panel')
            mark = server.mark()
            names = panel.locator('.cvat-quick-event-name').all_inner_texts()
            check(names == list(EVENTS), f'exactly the three event boxes {names}')
            blur(); native()
            sim('setFrame(52)'); page.keyboard.press('4')
            sim('setFrame(68)'); page.keyboard.press('5')
            check(start.inner_text() == 'Start 52' and end.inner_text() == 'End 68', 'keys 4/5 mark Start/End')
            check(native() == [], '4/5 taken by Quickstart: CVAT slot 4/5 not toggled')
            wait_ready()
            before = tags_by_frame()
            check(not any(pressed(n) for n in EVENTS), 'event boxes start off')
            box_counts = [event(n).locator('.cvat-quick-event-count').inner_text() for n in EVENTS]
            real = [f'{sum(1 for f in range(52, 69) if label in before[str(f)])}/17' for label in (1, 2, 3)]
            check(box_counts == real, f'event boxes show tagged frames out of total marked frames {box_counts}')
            check(quick_apply.is_disabled() and panel.locator('.cvat-quick-add').is_disabled(),
                  '+ and Apply locked with no event selected')
            event('event_smoke').click()
            blur(); page.keyboard.press('Alt+3')
            check(pressed('event_smoke') and pressed('event_phone') and not pressed('event_drinking'),
                  'click and Alt+3 toggle the boxes; aria-pressed in sync')
            page.keyboard.press('=')
            check(rows.count() == 1 and rows.nth(0).get_attribute('data-mode') == 'add' and
                  rows.nth(0).locator('.cvat-quick-names').inner_text() == 'event_smoke, event_phone',
                  '= queues one + row with both selected events')
            event('event_phone').click(); event('event_drinking').click()
            check(rows.nth(0).locator('.cvat-quick-names').inner_text() == 'event_smoke, event_phone',
                  'toggling afterwards keeps the queued row')
            blur(); page.keyboard.press('='); page.keyboard.press('-')
            check(rows.count() == 3 and rows.nth(2).get_attribute('data-mode') == 'remove' and
                  rows.nth(2).locator('.cvat-quick-names').inner_text() == 'event_smoke, event_drinking', '- queues one − row')
            rows.nth(1).locator('.cvat-quick-drop').click()
            check(rows.count() == 2 and [rows.nth(i).get_attribute('data-mode') for i in range(2)] == ['add', 'remove'],
                  '× drops the middle row')
            phone = event('event_phone')
            check(phone.locator('.cvat-quick-event-count').inner_text() == real[2] and
                  phone.locator('.cvat-quick-event-next').inner_text() == '→ 17',
                  'event box keeps the current ratio and shows the projected count separately')
            preview = info.inner_text()
            check(preview.startswith('Thêm ') and ' · Xóa ' in preview, f'panel preview shows the totals ({preview})')
            refreshes = sim('refreshes')
            blur(); page.keyboard.press('Enter')
            wait('document.querySelectorAll(".cvat-quick-row").length === 0', 'Enter applied the queue')
            after = tags_by_frame()
            ops = [('add', [], 1), ('add', [], 3), ('remove', [1, 2], None)]
            check(after == expected_after(before, 52, 68, ops, VALID), 'panel Apply (+ then − of an added event) matches the model')
            check('Chưa lưu lên server' in status.inner_text(), 'panel Apply reports the save state')
            check(start.inner_text() == 'Start 52' and end.inner_text() == 'End 68', 'panel Apply keeps Start/End')
            check(native() == [], 'Alt+3, =, - and Enter taken by Quickstart, none passed to CVAT')
            page.keyboard.press('Enter')
            page.wait_for_timeout(300)
            check(sim('refreshes') == refreshes + 1, 'a second Enter with an empty queue applies nothing')
            native()
            badge_matches('after panel Apply')

            wait_ready()
            page.keyboard.press('-')
            check(rows.count() == 1 and rows.nth(0).get_attribute('data-invalid') == 'true' and quick_apply.is_disabled(),
                  f'− of events missing from the range is flagged ({rows.nth(0).inner_text()!r}) and blocks Apply')
            rows.nth(0).locator('.cvat-quick-drop').click()

            blur(); page.keyboard.press('=')
            sim('setFrame(80)')
            page.once('dialog', lambda d: d.dismiss())
            page.keyboard.press('5')
            check(end.inner_text() == 'End 68' and rows.count() == 1, 'new range with a queue asks first; No keeps both')
            page.once('dialog', lambda d: d.accept())
            page.keyboard.press('5')
            check(end.inner_text() == 'End 80' and rows.count() == 0, 'Yes sets the new mark and drops the queue')
            wait_ready()

            print('Nâng cao from the panel queue')
            before = tags_by_frame()
            blur(); page.keyboard.press('=')
            advanced.click()
            dialog = page.locator('dialog.cvat-range-dialog')
            cards = dialog.locator('.cvat-operation-card')
            cards.nth(1).locator('select').wait_for()
            seeded = cards.nth(0).locator('.cvat-target-chips button[aria-pressed="true"]').evaluate_all(
                '(nodes) => nodes.map((b) => b.dataset.labelId)')
            check(cards.count() == 2 and cards.nth(0).locator('select').input_value() == 'add' and seeded == ['1', '2'],
                  f'dialog starts with the queued row, then a new card ({seeded})')
            check(cards.nth(1).locator('select').input_value() == 'replace', 'the added card is Đổi tag')
            dialog.locator('button', has_text='Hủy').click()
            page.wait_for_selector('dialog.cvat-range-dialog', state='detached')
            check(rows.count() == 1, 'Hủy keeps the panel queue')
            advanced.click()
            card = dialog.locator('.cvat-operation-card').nth(1)
            card.locator('select').wait_for()
            card.locator('.cvat-source-chips button[data-label-id="3"]').click()
            card.locator('.cvat-target-chips button[data-label-id="2"]').click()
            dialog.locator('button', has_text='Áp dụng').click()
            page.wait_for_selector('dialog.cvat-range-dialog', state='detached')
            after = tags_by_frame()
            ops = [('add', [], 1), ('add', [], 2), ('replace', [3], 2)]
            check(after == expected_after(before, 52, 80, ops, VALID), 'queued + row and Đổi tag applied as one batch')
            check(rows.count() == 0, 'dialog Apply empties the panel queue')

            print('Keys the panel leaves to CVAT and the browser')
            wait_ready()
            native()
            page.locator('.cvat-player-frame-selector').focus()
            sim('setFrame(60)'); page.keyboard.press('4')
            check(start.inner_text() == 'Start 52', 'typing 4 in the frame field does not mark')
            blur()
            page.evaluate('document.querySelector(".cvat-workspace-selector .ant-select-selection-item").textContent = "Standard"')
            page.keyboard.press('4')
            check(start.inner_text() == 'Start 52' and native() == ['4'], 'Standard workspace: 4 goes to CVAT')
            page.evaluate('document.querySelector(".cvat-workspace-selector .ant-select-selection-item").textContent = "Tag annotation"')
            page.keyboard.press('1')
            check(native() == ['1'], 'slot key 1 still goes to CVAT')
            page.keyboard.down('4'); page.keyboard.down('4'); page.keyboard.up('4')
            check(start.inner_text() == 'Start 60' and native() == [], 'held 4 marks once; auto-repeat not passed to CVAT')
            check(server.since(mark) == [], 'Quickstart made no server request')
            check(page.evaluate('sessionStorage.getItem("loads")') == '1', 'Quickstart: no page reload')

            print('Remount in the same job')
            set_range(50, 70)
            select_only('event_smoke')
            panel.locator('.cvat-quick-add').click()
            page.evaluate('document.querySelector(".cvat-quick-panel").remove()')
            page.wait_for_selector('.cvat-quick-panel .cvat-quick-start')
            check(page.locator('.cvat-quick-panel').count() == 1 and page.locator('.cvat-range-band').count() == 1,
                  'one panel and one band after a remount')
            check(rows.count() == 1 and start.inner_text() == 'Start 50', 'queue and marks survive a remount')
            prompts = []
            def on_dialog(d):
                prompts.append(d.message)
                d.dismiss()
            page.on('dialog', on_dialog)
            blur(); native()
            sim('setFrame(55)'); page.keyboard.press('4')
            page.remove_listener('dialog', on_dialog)
            check(len(prompts) == 1 and native() == [] and start.inner_text() == 'Start 50',
                  f'one key listener after remount ({len(prompts)} confirm, nothing leaked)')
            page.evaluate("""() => {
                const slider = document.querySelector('.cvat-player-slider');
                const replacement = slider.cloneNode(true);
                replacement.querySelector('.cvat-range-band').remove();
                replacement.querySelector('[role="slider"]').setAttribute('aria-valuenow', '56');
                slider.replaceWith(replacement);
            }""")
            wait('document.querySelector(".cvat-quick-frame-position").textContent === "56/100"', 'new slider supplies the frame counter')
            check(rows.count() == 1 and page.locator('.cvat-range-band').count() == 1,
                  'slider replacement keeps the draft and one highlight')
            rows.nth(0).locator('.cvat-quick-drop').click()

            print('Tag cache')
            # Marking Start first can read the range between the new Start and the old End;
            # what matters is that no frame is read twice and the dialog reads nothing.
            def open_and_cancel(low, high):
                set_range(low, high)
                page.wait_for_timeout(300)
                marking = sim('takeReads()')
                advanced.click()
                page.wait_for_function('document.querySelector("dialog.cvat-range-dialog select") && '
                                       '!document.querySelector("dialog.cvat-range-dialog select").disabled')
                page.locator('dialog.cvat-range-dialog button', has_text='Hủy').click()
                page.wait_for_selector('dialog.cvat-range-dialog', state='detached')
                return marking, sim('takeReads()')
            page.wait_for_timeout(900)
            sim('takeReads()')
            first, in_dialog = open_and_cancel(20, 40)
            check(set(range(20, 41)) <= set(first) and len(set(first)) == len(first),
                  f'first range 20-40 read once per frame ({len(first)} frames incl. the intermediate range)')
            check(in_dialog == [], 'Nâng cao reuses what the panel read')
            second, in_dialog = open_and_cancel(25, 45)
            check(not set(second) & set(first) and all(25 <= f <= 45 for f in second) and in_dialog == [],
                  f'overlapping range 25-45 reads only frames not read yet {second}')
            sim('setFrame(70)')
            third, in_dialog = open_and_cancel(20, 45)
            check(third == [] and in_dialog == [], 'reopening after changing frame reads nothing')
            page.evaluate('window.__sim.userAddTag(30, 3)')
            badge_matches('after a tag hotkey')
            page.wait_for_timeout(900)
            check(sorted(sim('takeReads()')) == list(range(20, 46)), 'a CVAT annotation action re-reads the marked range once')
            fourth, in_dialog = open_and_cancel(25, 45)
            check(fourth == [] and in_dialog == [], 'the re-read range is cached again')
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

            print('Clear All Tags (local only, same path as Apply)')
            set_range(10, 20)
            select_only('event_smoke')
            panel.locator('.cvat-quick-add').click()
            badge_matches('before Clear All')
            mark = server.mark()
            refreshes = sim('refreshes')
            page.get_by_role('button', name='Clear All Tags').click()
            confirm = page.locator('dialog button', has_text='Xóa toàn bộ tag')
            page.wait_for_function('[...document.querySelectorAll("dialog button")].some((b) => '
                                   'b.textContent === "Xóa toàn bộ tag" && !b.disabled)')
            detail = page.locator('dialog.cvat-event-clear-dialog p[role="status"]').inner_text()
            check(f'Job có {tag_count()} tag' in detail and 'tải lại trang mà không lưu' not in detail,
                  'dialog counts the tags and says the page stays')
            confirm.click()
            page.wait_for_function('document.querySelector("#cvat-event-complete-status").textContent.startsWith("Đã xóa")')
            check(tag_count() == 0, 'all tags removed in the browser')
            check(sim('count("shape")') == shapes, 'shapes untouched')
            check(sim('refreshes') == refreshes + 1, 'view refreshed in place once, like Apply')
            check('Chưa lưu lên server' in status.inner_text(), 'Clear All reports the save state like Apply')
            badge_matches('after Clear All')
            check(page.locator('.cvat-clear-count').inner_text() == '0', 'Clear All Tags shows 0')
            check(start.inner_text() == 'Start 10' and end.inner_text() == 'End 20' and rows.count() == 1,
                  'Start/End and the queued row kept')
            wait('document.querySelector(".cvat-quick-info").textContent.startsWith("Thêm 9")',
                 'queued + row re-previewed against the cleared job')
            check(page.evaluate('window.__sim.state.annotation.canvas.ready'), 'canvas still ready after Clear All')
            page.wait_for_timeout(900)
            sim('takeReads()')
            advanced.click()
            page.wait_for_function('document.querySelector("dialog.cvat-range-dialog select") && '
                                   '!document.querySelector("dialog.cvat-range-dialog select").disabled')
            check(sim('takeReads()') == [], 'range cache kept through Clear All (nothing re-read)')
            page.locator('dialog.cvat-range-dialog button', has_text='Hủy').click()
            page.wait_for_selector('dialog.cvat-range-dialog', state='detached')
            rows.nth(0).locator('.cvat-quick-drop').click()
            check(server.since(mark) == [], 'Clear All made no server request')
            box = page.locator('.cvat-event-complete-status')
            check(box.is_visible(), 'result message shown')
            page.wait_for_timeout(8500)
            check(not box.is_visible(), 'result message hides itself after 8 s')
            page.evaluate('document.getElementById("cvat-event-complete-status").textContent = "x"')
            check(box.is_visible(), 'message box visible again')
            page.locator('.cvat-event-status-close').click()
            check(not box.is_visible(), '× hides the message box at once')
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
            check([e['action'] for e in calls if 'action' in e] == ['delete'], 'saved only the cleared tags, one request')
            order = [i for i, e in enumerate(calls) if e.get('action') == 'delete'] + \
                    [i for i, e in enumerate(calls) if e['method'] == 'PATCH' and e['path'] == '/api/jobs/77']
            check(len(order) == 2 and order[0] < order[1], 'order: save first, then set Completed')
            check(server.job_state[77] == 'completed', 'job 77 completed on the server')
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

            print('Complete & Next with nothing to save, wrapping to an earlier job')
            page.wait_for_selector('.cvat-quick-panel .cvat-quick-start')
            page.wait_for_function('window.cvatUI !== undefined')
            mark = server.mark()
            page.get_by_role('button', name='Complete & Next').click()
            page.wait_for_url('**/tasks/12/jobs/60', timeout=30000)
            calls = server.since(mark)
            check(not any('action' in e for e in calls), 'nothing unsaved: no annotation request')
            check(server.job_state[80] == 'completed', 'job 80 completed on the server')

            print('Complete & Next when the filter finds nothing: original page scan')
            page.wait_for_selector('.cvat-quick-panel .cvat-quick-start')
            page.wait_for_function('window.cvatUI !== undefined')
            mark = server.mark()
            page.get_by_role('button', name='Complete & Next').click()
            page.wait_for_url('**/tasks/12', timeout=30000)
            calls = server.since(mark)
            check(any(e.get('scan') for e in calls), 'no open job via filter: task job list scanned before giving up')
            check(server.job_state[60] == 'completed', 'job 60 completed, task page opened')
            browser.close()
    finally:
        proc.kill()
        proc.wait(timeout=10)
        for _ in range(10):  # Chromium child processes may still hold profile files for a moment
            shutil.rmtree(profile, ignore_errors=True)
            if not os.path.exists(profile):
                break
            time.sleep(0.5)

    print()
    print('FAILED: ' + str(len(failures)) if failures else 'ALL CHECKS PASSED')
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
