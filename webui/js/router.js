// Hash router with lazy view modules and animated transitions.

import { set, get } from './store.js';
import { renderSidebarPlaylists } from './actions.js';

const routes = {
  home:     () => import('./views/home.js'),
  search:   () => import('./views/search.js'),
  radio:    () => import('./views/radio.js'),
  library:  () => import('./views/library.js'),
  playlist: () => import('./views/playlist.js'),
  settings: () => import('./views/settings.js'),
};

let currentView = null;
let currentName = null;

export function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '') || 'home';
  const [pathPart, queryPart] = raw.split('?');
  const segs = pathPart.split('/').filter(Boolean);
  const name = segs[0] || 'home';
  const params = {};
  if (name === 'playlist' && segs[1]) params.id = segs[1];
  const query = new URLSearchParams(queryPart || '');
  for (const [k, v] of query) params[k] = v;
  return { name: routes[name] ? name : 'home', params };
}

export async function navigate() {
  const route = parseHash();
  const root = document.getElementById('view-root');

  // tear down previous
  if (currentView && typeof currentView.unmount === 'function') {
    try { currentView.unmount(); } catch (e) { console.warn('[router] unmount failed', e); }
  }
  currentView = null;
  set({ route }, false);

  // nav highlight
  document.querySelectorAll('.nav-item[data-route]').forEach(a => {
    a.classList.toggle('active', a.dataset.route === route.name);
  });
  document.getElementById('btn-settings')?.classList.toggle('active', route.name === 'settings');
  renderSidebarPlaylists();

  root.innerHTML = '';
  root.scrollTop = 0;

  try {
    const mod = await routes[route.name]();
    const container = document.createElement('div');
    container.className = 'view enter';
    root.appendChild(container);
    currentView = await mod.mount(container, route.params);
    currentName = route.name;
  } catch (e) {
    console.error('[router] view failed', e);
    root.innerHTML = `
      <div class="view">
        <div class="empty">
          <h3>That view crashed 😵</h3>
          <p style="font-family:var(--mono);font-size:12px">${String(e.message || e).slice(0, 200)}</p>
          <a class="btn primary" href="#/home">Back home</a>
        </div>
      </div>`;
  }
}

export function initRouter() {
  window.addEventListener('hashchange', navigate);
  if (!location.hash) location.hash = '#/home';
  navigate();
}
