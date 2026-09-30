// Toast notifications — bottom-left stack with optional action button.

import { icon } from './icons.js';

const host = () => document.getElementById('toast-host');

export function toast(msg, opts = {}) {
  const { type = 'info', icon: ico, timeout = 4200, action } = opts;
  const el = document.createElement('div');
  el.className = `toast ${type === 'error' ? 'err' : type === 'ok' ? 'ok' : ''}`;
  const iconName = ico || (type === 'error' ? 'alert' : type === 'ok' ? 'check' : 'info');
  el.innerHTML = `
    <span class="t-ico">${icon(iconName, 18)}</span>
    <span class="t-msg"></span>
    ${action ? `<button class="t-act"></button>` : ''}`;
  el.querySelector('.t-msg').textContent = msg;
  if (action) {
    const btn = el.querySelector('.t-act');
    btn.textContent = action.label;
    btn.onclick = () => { dismiss(); action.onClick(); };
  }
  host().appendChild(el);
  let timer = timeout ? setTimeout(dismiss, timeout) : null;
  // hover pauses the countdown; leaving resumes it so a toast can never
  // get pinned forever by a mouse that wandered across it
  el.addEventListener('mouseenter', () => timer && clearTimeout(timer));
  el.addEventListener('mouseleave', () => {
    if (timeout) timer = setTimeout(dismiss, Math.min(timeout, 4000));
  });
  function dismiss() {
    if (!el.isConnected) return;
    el.classList.add('out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 500);
  }
  return dismiss;
}

export const toastOk = (msg, opts = {}) => toast(msg, { type: 'ok', ...opts });
export const toastErr = (msg, opts = {}) => toast(msg, { type: 'error', timeout: 6000, ...opts });
