/**
 * The two-step "feature your app here" form — pitch (app lookup + colour),
 * then confirm (who's asking, and why) — extracted from what used to be a
 * landing-page-only modal so `sponsor.html` (and anything else that wants
 * the same flow) can mount it straight into a page section instead of an
 * overlay.
 *
 * Submits to the same `promo_requests` backend the modal always used
 * (`CommunityClient#submitPromoRequest`, lands as `pending` for manual
 * review — see `community/src/routes/promo.js` and `views/admin.js`); a
 * `mailto:` link is the last-resort fallback when the community backend
 * isn't configured or a submit fails, same as before.
 */

import { escapeHtml } from '../views/shared.js';
import { CommunityClient, itunesRelayOptions } from './community.js';
import { ITunesClient } from './itunes.js';
import { RAIL_COLORS } from './promo-colors.js';

const CONTACT_EMAIL = 'kaizenapp.contact@gmail.com';
const PROMO_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function promoMailto({ color, app, name, email, message }) {
  const subject = `Featuring ${app?.name ?? 'my app'} on AppMates`;
  const body = [
    `App: ${app?.name ?? '(not provided)'}${app?.storeUrl ? ` — ${app.storeUrl}` : ''}`,
    `Preferred card colour: ${color}`,
    `Name: ${name || '(not provided)'}`,
    `Email: ${email || '(not provided)'}`,
    '',
    message || '(no message)',
  ].join('\n');
  return `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** Swaps the preview card's icon between the placeholder emoji and a real
 * `<img>` — the same span-to-img swap `fillAppFacts` does for a resolved
 * leaderboard row, just local to this one preview card. */
function setPreviewIcon(preview, artworkUrl) {
  const existing = preview.querySelector('.promo-preview-icon, .rail-icon');
  const node = artworkUrl ? document.createElement('img') : document.createElement('span');
  if (artworkUrl) {
    node.className = 'rail-icon';
    node.src = artworkUrl;
    node.alt = '';
  } else {
    node.className = 'promo-preview-icon';
    node.setAttribute('aria-hidden', 'true');
    node.textContent = '📱';
  }
  existing.replaceWith(node);
}

/**
 * Mounts the form into `container`, wholesale-replacing its `innerHTML` on
 * every step change — simpler than tracking two parallel sets of listeners
 * on the same nodes. State that has to survive a step swap (`selected`,
 * `resolvedApp`, `appQuery`) lives in this function's closure, not the DOM.
 *
 * `presetColor` seeds the swatch picker — used when a visitor arrived via a
 * specific side's "claim this slot" card, so the preview starts on a colour
 * that reads well against that side's neighbours rather than always
 * defaulting to the first swatch.
 */
export function mountPromoForm(container, { presetColor } = {}) {
  let selected = presetColor && RAIL_COLORS.some((c) => c.id === presetColor) ? presetColor : RAIL_COLORS[0].id;
  let resolvedApp = null; // { trackId, name, genre, artwork, storeUrl }
  let appQuery = '';

  const itunes = new ITunesClient(itunesRelayOptions());
  const community = new CommunityClient();
  let lookupTimer;

  function renderPitchStep() {
    container.innerHTML = `
      <div class="promo-preview-wrap">
        <div class="rail-card rail-card--${selected}" id="promoPreviewCard" aria-label="Card preview">
          <span class="promo-preview-icon" aria-hidden="true">📱</span>
          <span class="rail-name">Your app</span>
          <span class="rail-genre">Category</span>
        </div>
      </div>

      <div class="field">
        <label for="promoAppInput">Your app</label>
        <input id="promoAppInput" type="text" placeholder="1438388363 or com.example.app" autocomplete="off">
        <span class="promo-app-status" id="promoAppStatus"></span>
      </div>

      <div class="field">
        <label id="promoColorLabel">Card colour</label>
        <div class="promo-swatches" role="radiogroup" aria-labelledby="promoColorLabel">
          ${RAIL_COLORS.map(
            (c) => `
            <button type="button" class="promo-swatch${c.id === selected ? ' selected' : ''}"
              data-color="${c.id}" style="--swatch:${c.hex}"
              role="radio" aria-checked="${c.id === selected}" aria-label="${escapeHtml(c.label)}"></button>`,
          ).join('')}
        </div>
      </div>

      <div class="promo-price">
        <span class="promo-price-old">$20/mo</span>
        <span class="promo-price-new">Free</span>
      </div>
      <p class="modal-sub">
        Free while AppMates is growing. As traffic and demand pick up, pricing may
        change — at most once a month, never mid-cycle — but you'll always hear about
        it first by email. Nothing is ever charged without your confirmation.
      </p>

      <button type="button" id="promoRequestBtn" class="landing-cta" style="width:100%;margin-top:.4rem">
        Request this slot
      </button>`;

    const preview = container.querySelector('#promoPreviewCard');
    const requestBtn = container.querySelector('#promoRequestBtn');
    const appInput = container.querySelector('#promoAppInput');
    const appStatus = container.querySelector('#promoAppStatus');
    appInput.value = appQuery;

    const applyResolved = (entry) => {
      preview.querySelector('.rail-name').textContent = entry ? entry.name : 'Your app';
      preview.querySelector('.rail-genre').textContent = entry ? entry.genre : 'Category';
      setPreviewIcon(preview, entry ? entry.artwork : '');
    };
    if (resolvedApp) {
      applyResolved(resolvedApp);
      appStatus.textContent = `Found: ${resolvedApp.name}`;
    }

    container.querySelectorAll('.promo-swatch').forEach((btn) => {
      btn.addEventListener('click', () => {
        container.querySelectorAll('.promo-swatch').forEach((b) => {
          b.classList.remove('selected');
          b.setAttribute('aria-checked', 'false');
        });
        btn.classList.add('selected');
        btn.setAttribute('aria-checked', 'true');
        selected = btn.dataset.color;
        preview.className = `rail-card rail-card--${selected}`;
      });
    });

    appInput.addEventListener('input', () => {
      clearTimeout(lookupTimer);
      appQuery = appInput.value.trim();
      appStatus.classList.remove('error');

      if (!appQuery) {
        resolvedApp = null;
        appStatus.textContent = '';
        applyResolved(null);
        return;
      }

      appStatus.textContent = 'Looking up…';
      lookupTimer = setTimeout(async () => {
        let entry = null;
        try {
          entry = await itunes.lookup(appQuery, { country: 'us' });
        } catch {
          appStatus.textContent = "Couldn't reach the App Store catalogue — try again in a moment.";
          return;
        }
        if (!entry) {
          resolvedApp = null;
          appStatus.textContent = "Couldn't find that app — check the id.";
          return;
        }
        resolvedApp = {
          trackId: String(entry.trackId ?? appQuery),
          name: entry.trackName,
          genre: entry.primaryGenreName ?? '',
          artwork: entry.artworkUrl100 ?? entry.artworkUrl512 ?? '',
          storeUrl: entry.trackViewUrl ?? '',
        };
        appStatus.textContent = `Found: ${entry.trackName}`;
        applyResolved(resolvedApp);
      }, 500);
    });

    requestBtn.addEventListener('click', () => {
      if (!resolvedApp) {
        appStatus.textContent = 'Add a valid app above first.';
        appStatus.classList.add('error');
        appInput.focus();
        return;
      }
      renderConfirmStep();
    });
  }

  function renderConfirmStep() {
    container.innerHTML = `
      <div class="promo-preview-wrap">
        <div class="rail-card rail-card--${selected} promo-shine" aria-label="Card preview">
          ${resolvedApp.artwork ? `<img class="rail-icon" src="${escapeHtml(resolvedApp.artwork)}" alt="">` : '<span class="promo-preview-icon" aria-hidden="true">📱</span>'}
          <span class="rail-name">${escapeHtml(resolvedApp.name)}</span>
          ${resolvedApp.genre ? `<span class="rail-genre">${escapeHtml(resolvedApp.genre)}</span>` : ''}
        </div>
      </div>
      <p class="modal-sub">I review every request by hand — this is what I read to decide.</p>

      <div class="field">
        <label for="promoName">Your name</label>
        <input id="promoName" type="text" placeholder="Jane Doe" autocomplete="name">
      </div>
      <div class="field">
        <label for="promoEmail">Your email</label>
        <input id="promoEmail" type="email" placeholder="you@example.com" autocomplete="email">
      </div>
      <div class="field">
        <label for="promoMessage">What's your app about?</label>
        <textarea id="promoMessage" rows="4"
          placeholder="What it does, who it's for, and why you'd like a slot here. If there are more requests than open slots, this is what decides it."></textarea>
      </div>

      <div id="promoSendStatus" class="status"></div>

      <div style="display:flex;gap:.6rem;margin-top:.6rem">
        <button type="button" id="promoBackBtn">Back</button>
        <button type="button" id="promoSendBtn" class="primary" style="flex:1">Send request</button>
      </div>`;

    container.querySelector('#promoBackBtn').addEventListener('click', renderPitchStep);
    container.querySelector('#promoSendBtn').addEventListener('click', () => submitPromoRequest(container, community));
  }

  async function submitPromoRequest(form, communityClient) {
    const name = form.querySelector('#promoName').value.trim();
    const email = form.querySelector('#promoEmail').value.trim();
    const message = form.querySelector('#promoMessage').value.trim();
    const status = form.querySelector('#promoSendStatus');
    const sendBtn = form.querySelector('#promoSendBtn');

    if (!name) return showSendError(status, 'Your name is required.');
    if (!PROMO_EMAIL_RE.test(email)) return showSendError(status, 'A valid email is required.');
    if (message.length < 20) {
      return showSendError(status, 'Say a bit more — at least 20 characters helps me understand your app.');
    }

    sendBtn.disabled = true;
    status.className = 'status';
    status.textContent = 'Sending…';

    if (communityClient.configured) {
      try {
        await communityClient.submitPromoRequest({
          trackId: resolvedApp.trackId,
          name: resolvedApp.name,
          genre: resolvedApp.genre,
          artworkUrl: resolvedApp.artwork,
          storeUrl: resolvedApp.storeUrl,
          color: selected,
          message,
          requesterName: name,
          email,
        });
        status.className = 'status ok';
        status.textContent = "Sent — I'll email you either way once I've reviewed it.";
        sendBtn.textContent = 'Sent';
        return;
      } catch (err) {
        // Falls through to the `mailto` handoff below rather than leaving
        // the visitor stuck on a dead button — the backend rejecting or
        // being unreachable shouldn't cost them the request entirely.
        status.textContent = `Couldn't submit directly (${err.message}) — opening your email app instead.`;
      }
    }

    window.location.href = promoMailto({ color: selected, app: resolvedApp, name, email, message });
    status.className = 'status ok';
    status.textContent = 'Opened in your email app — send it to finish the request.';
    sendBtn.disabled = false;
  }

  function showSendError(status, message) {
    status.className = 'status error';
    status.textContent = message;
  }

  renderPitchStep();
}
