/**
 * The favorites tray in the top bar: a shortcut back to apps starred on the
 * Overview page. It lives in the shared top bar rather than the Overview
 * view itself, so it stays reachable while using any other tool.
 */

import { favorites, onFavoritesChange } from '../lib/favorites.js';
import { el, escapeHtml, appIcon } from './shared.js';

let onSelect = null;

export function initFavoritesTray({ onSelectApp }) {
  onSelect = onSelectApp;

  const tray = el('favTray');
  const toggle = el('favTrayToggle');
  const dropdown = el('favDropdown');

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('hidden');
    toggle.setAttribute('aria-expanded', String(!dropdown.classList.contains('hidden')));
  });

  document.addEventListener('click', (e) => {
    if (!tray.contains(e.target)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });

  dropdown.addEventListener('click', (e) => {
    const removeBtn = e.target.closest('.fav-remove');
    if (removeBtn) {
      e.preventDefault();
      e.stopPropagation();
      favorites.remove(removeBtn.dataset.trackId);
      return;
    }
    const item = e.target.closest('.fav-item');
    if (item) {
      e.preventDefault();
      close();
      onSelect?.(item.dataset.bundleId || item.dataset.trackId, item.dataset.country);
    }
  });

  function close() {
    dropdown.classList.add('hidden');
    toggle.setAttribute('aria-expanded', 'false');
  }

  onFavoritesChange(render);
  render();
}

function render() {
  const list = favorites.list();
  const tray = el('favTray');
  tray.classList.toggle('hidden', list.length === 0);
  if (!list.length) return;

  el('favTrayIcons').innerHTML = list
    .slice(0, 5)
    .map((a) => appIcon(a.artwork, a.name))
    .join('');

  el('favDropdown').innerHTML = `
    <div class="fav-dropdown-head">Favorite apps</div>
    ${list
      .map(
        (a) => `
      <a class="fav-item" href="#overview" data-track-id="${escapeHtml(a.trackId)}"
         data-bundle-id="${escapeHtml(a.bundleId ?? '')}" data-country="${escapeHtml(a.country ?? 'us')}">
        ${appIcon(a.artwork, a.name)}
        <span class="fav-item-body">
          <strong>${escapeHtml(a.name)}</strong>
          <span class="muted">${escapeHtml(a.seller ?? '')}</span>
        </span>
        <button type="button" class="fav-remove" data-track-id="${escapeHtml(a.trackId)}"
          title="Remove from favorites">×</button>
      </a>`,
      )
      .join('')}`;
}
