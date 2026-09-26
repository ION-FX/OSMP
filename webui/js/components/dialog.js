// Promise-based modal dialogs: confirm, prompt, custom content.

import { hydrateIcons } from './icons.js';

const host = () => document.getElementById('modal-host');
let _open = [];

export function closeAllModals() {
  _open.forEach(m => m.remove());
  _open = [];
}

function mount(innerHtml, onMount) {
  return new Promise(resolve => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = innerHtml;
    host().appendChild(backdrop);
    _open.push(backdrop);
    hydrateIcons(backdrop);

    const close = (value) => {
      if (!backdrop.isConnected) return;
      backdrop.style.animation = 'fade-in .2s var(--ease) reverse both';
      setTimeout(() => {
        backdrop.remove();
        _open = _open.filter(m => m !== backdrop);
      }, 180);
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(null); });

    onMount(backdrop, close);
  });
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false, cancelLabel = 'Cancel' }) {
  return mount(`
    <div class="modal" role="dialog" aria-modal="true">
      <h2></h2>
      <div class="modal-sub"></div>
      <div class="modal-actions">
        <button class="btn ghost" data-act="cancel"></button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-act="ok"></button>
      </div>
    </div>`, (root, close) => {
    root.querySelector('h2').textContent = title;
    root.querySelector('.modal-sub').textContent = message || '';
    root.querySelector('[data-act="cancel"]').textContent = cancelLabel;
    root.querySelector('[data-act="ok"]').textContent = confirmLabel;
    root.querySelector('[data-act="cancel"]').onclick = () => close(false);
    root.querySelector('[data-act="ok"]').onclick = () => close(true);
    setTimeout(() => root.querySelector('[data-act="ok"]').focus(), 60);
  });
}

export function promptDialog({ title, message = '', placeholder = '', value = '',
                               confirmLabel = 'OK', multiline = false }) {
  return mount(`
    <div class="modal" role="dialog" aria-modal="true">
      <h2></h2>
      ${message ? '<div class="modal-sub"></div>' : ''}
      <div class="modal-body">
        ${multiline
          ? '<textarea class="textarea" rows="3"></textarea>'
          : '<input class="input" type="text" maxlength="140">'}
      </div>
      <div class="modal-actions">
        <button class="btn ghost" data-act="cancel">Cancel</button>
        <button class="btn primary" data-act="ok"></button>
      </div>
    </div>`, (root, close) => {
    root.querySelector('h2').textContent = title;
    if (message) root.querySelector('.modal-sub').textContent = message;
    root.querySelector('[data-act="ok"]').textContent = confirmLabel;
    const input = root.querySelector(multiline ? 'textarea' : 'input');
    input.placeholder = placeholder;
    input.value = value;
    const ok = () => {
      const v = input.value.trim();
      if (!v) { input.focus(); return; }
      close(v);
    };
    root.querySelector('[data-act="cancel"]').onclick = () => close(null);
    root.querySelector('[data-act="ok"]').onclick = ok;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !multiline) ok();
      if (e.key === 'Enter' && multiline && (e.ctrlKey || e.metaKey)) ok();
    });
    setTimeout(() => { input.focus(); input.select(); }, 60);
  });
}

/**
 * Custom-content dialog. build(root, close) fills .modal-body and wires actions.
 * `actions` is HTML inserted into .modal-actions.
 */
export function customDialog({ title, message = '', wide = false, bodyHtml = '', actionsHtml = '' }, build) {
  return mount(`
    <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
      <h2></h2>
      ${message ? '<div class="modal-sub"></div>' : ''}
      <div class="modal-body">${bodyHtml}</div>
      ${actionsHtml ? `<div class="modal-actions">${actionsHtml}</div>` : ''}
    </div>`, (root, close) => {
    root.querySelector('h2').textContent = title;
    if (message) root.querySelector('.modal-sub').textContent = message;
    if (build) build(root, close);
  });
}
