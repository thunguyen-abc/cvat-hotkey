(() => {
  'use strict';

  const labelsByKey = new Map([
    ['1', 'event_smoke'],
    ['2', 'event_drinking'],
    ['3', 'event_phone'],
  ]);
  const panelSelector = '.cvat-tag-annotation-label-selects';
  const configuredPanels = new WeakSet();
  let jobPath = '';
  let workspaceHandled = false;
  let processing = false;
  let configuringPanel = null;
  let scheduled = false;

  function currentJobPath() {
    return location.pathname.match(/^\/tasks\/\d+\/jobs\/\d+(?=\/?$)/)?.[0] ?? '';
  }

  function afterRender() {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  function findSelect(panel, key) {
    const shortcut = [...panel.querySelectorAll('code')].find((element) =>
      element.textContent.replace(/^Shortcut:\s*/, '').split(',').some((value) => value.trim() === key));
    return shortcut?.closest('.ant-row')?.querySelector('.cvat-tag-annotation-label-select');
  }

  async function chooseOption(select, label) {
    const selection = select.querySelector('.ant-select-selection-item');
    if (selection?.textContent.trim() === label || select.classList.contains('ant-select-disabled')) return;

    const input = select.querySelector('input[role="combobox"]');
    const trigger = select.querySelector('.ant-select-selector');
    if (!input || !trigger) return;

    const previousFocus = document.activeElement;
    const mouseDown = () => trigger.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
    }));

    mouseDown();
    await afterRender();
    try {
      if (!input.isConnected || input.getAttribute('aria-expanded') !== 'true') return;
      const list = document.getElementById(input.getAttribute('aria-controls'));
      const dropdown = list?.closest('.ant-select-dropdown');
      if (!dropdown) return;

      const holder = dropdown.querySelector('.rc-virtual-list-holder');
      while (input.isConnected && input.getAttribute('aria-expanded') === 'true') {
        const option = [...dropdown.querySelectorAll('.ant-select-item-option-content')]
          .find((item) => item.textContent.trim() === label);
        if (option) {
          option.click();
          await afterRender();
          return;
        }

        if (!holder?.clientHeight) return;
        const next = Math.min(
          holder.scrollTop + holder.clientHeight * 0.8,
          holder.scrollHeight - holder.clientHeight,
        );
        if (next <= holder.scrollTop) return;
        holder.scrollTop = next;
        await afterRender();
      }
    } finally {
      if (input.isConnected && input.getAttribute('aria-expanded') === 'true') {
        mouseDown();
        await afterRender();
      }
      if (document.activeElement === input) {
        input.blur();
        if (previousFocus !== document.body && previousFocus?.isConnected) {
          previousFocus.focus({ preventScroll: true });
        }
      }
    }
  }

  async function configureJob() {
    if (processing) return;
    const path = currentJobPath();
    if (path !== jobPath) {
      jobPath = path;
      workspaceHandled = false;
    }
    if (!path) return;
    if (document.querySelector('.ant-select input[aria-expanded="true"]')) return;

    const workspace = document.querySelector('.cvat-workspace-selector');
    const panel = document.querySelector(panelSelector);
    const changeWorkspace = !workspaceHandled && workspace?.getClientRects().length;
    const configurePanel = panel?.getClientRects().length && !configuredPanels.has(panel);
    if (!changeWorkspace && !configurePanel) return;

    processing = true;
    try {
      if (changeWorkspace) {
        workspaceHandled = true;
        const selection = workspace.querySelector('.ant-select-selection-item')?.textContent.trim();
        if (selection === 'Standard') {
          await chooseOption(workspace, 'Tag annotation');
          return;
        }
      }

      if (!configurePanel) return;
      configuringPanel = panel;
      configuredPanels.add(panel);
      for (const [key, label] of labelsByKey) {
        if (currentJobPath() !== path || !panel.isConnected) return;
        const select = findSelect(panel, key);
        if (select) await chooseOption(select, label);
      }
    } catch (error) {
      console.warn('CVAT Event Hotkeys could not configure this workspace.', error);
    } finally {
      configuringPanel = null;
      processing = false;
      scheduleConfiguration();
    }
  }

  function scheduleConfiguration() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      void configureJob();
    });
  }

  window.addEventListener('keydown', (event) => {
    if (!configuringPanel || !labelsByKey.has(event.key)) return;
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    if (event.target instanceof HTMLElement &&
        event.target.closest('input, textarea, [contenteditable="true"]')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  const observer = new MutationObserver(scheduleConfiguration);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-expanded'],
  });
  scheduleConfiguration();
})();
