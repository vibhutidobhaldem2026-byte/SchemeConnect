/**
 * Progressive enhancement only. Every flow works without this file — forms
 * post normally, the consent gate is enforced server-side, and the CSV upload
 * degrades to a plain field. This just makes the common paths pleasant.
 */

(function () {
  'use strict';

  // ------------------------------------------------------- brand mark ----
  /**
   * The logo image is cropped by a frame with overflow:hidden, so if the file
   * ever 404s the alt text would be clipped to a 30px circle. Hide the frame
   * instead and let the "SchemeConnect" wordmark beside it stand alone.
   *
   * Capture phase: `error` does not bubble, and this cannot be an onerror
   * attribute — the Content Security Policy blocks inline handlers.
   */
  document.addEventListener('error', function (e) {
    var img = e.target;
    if (!img || img.tagName !== 'IMG' || !img.hasAttribute('data-logo')) return;
    var frame = img.parentNode;
    if (frame && frame.classList) frame.classList.add('is-broken');
  }, true);

  // ------------------------------------------------- clickable rows -------
  /**
   * Table rows that behave like links.
   *
   * These used to be inline onclick attributes, which the Content Security
   * Policy blocks — script-src 'self' does not permit inline handlers, so
   * clicking a batch or a student silently did nothing. Every such row also
   * carries a real <a> in its first cell, so the destination is reachable,
   * keyboard-focusable and openable in a new tab even without this script.
   */
  document.addEventListener('click', function (e) {
    var row = e.target.closest('[data-href]');
    if (!row) return;
    // Let real controls inside the row handle their own clicks.
    if (e.target.closest('a, button, input, select, label')) return;
    pageLoaderArm();
    window.location.href = row.getAttribute('data-href');
  });

  // ------------------------------------------------------ confirmations ---
  /**
   * Destructive actions confirm first. This was an inline onsubmit, so the CSP
   * silently removed the confirmation from account deletion — the account went
   * without a prompt.
   *
   * Capture phase, so it runs before the progress handler below and a cancelled
   * submit never leaves the button stuck in a busy state.
   */
  document.addEventListener('submit', function (e) {
    var form = e.target.closest('form[data-confirm]');
    if (form && !window.confirm(form.getAttribute('data-confirm'))) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  // -------------------------------------------------------- back links ----
  // A real href to the fallback destination, upgraded to history.back() when
  // there is somewhere to go back to. Previously a javascript: URL, which the
  // CSP blocks.
  Array.prototype.forEach.call(document.querySelectorAll('[data-back]'), function (link) {
    link.addEventListener('click', function (e) {
      if (window.history.length > 1) {
        e.preventDefault();
        window.history.back();
      }
    });
  });

  // ---------------------------------------------------- submit progress ---
  /**
   * Tells the user something is happening.
   *
   * Importing a batch of students takes a few seconds, and with no feedback the
   * page looked frozen — indistinguishable from a failure. The button is
   * disabled on the way out so the work cannot be submitted twice.
   *
   * Disabling happens on the next tick, after the browser has already begun
   * submitting, so the form still posts normally.
   */
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form || form.hasAttribute('data-no-progress')) return;
    if (typeof form.checkValidity === 'function' && !form.checkValidity()) return;

    // The page-level indicator as well as the button-level one: a post that
    // takes seconds should not leave the rest of the page looking live.
    pageLoaderArm({ skeleton: plFormRefinesThisPage(form) });

    var button = form.querySelector('button[type="submit"], button:not([type])');
    if (!button || button.disabled) return;

    window.setTimeout(function () {
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      button.classList.add('is-busy');
      button.dataset.idleLabel = button.textContent.trim();
      button.textContent = button.getAttribute('data-busy-label') || 'Working…';
    }, 0);
  });

  /**
   * Restores the page when the browser returns to it from history — bfcache
   * serves the old DOM, which would otherwise show a permanently busy button.
   */
  window.addEventListener('pageshow', function (event) {
    if (!event.persisted) return;
    Array.prototype.forEach.call(document.querySelectorAll('button.is-busy'), function (button) {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.classList.remove('is-busy');
      if (button.dataset.idleLabel) button.textContent = button.dataset.idleLabel;
    });
  });

  // ---------------------------------------------------------- OTP inputs ---
  var otpGroup = document.getElementById('otpGroup');
  if (otpGroup) {
    var inputs = Array.prototype.slice.call(otpGroup.querySelectorAll('input'));
    inputs[0] && inputs[0].focus();

    inputs.forEach(function (input, idx) {
      input.addEventListener('input', function () {
        this.value = this.value.replace(/\D/g, '').slice(0, 1);
        if (this.value && idx < inputs.length - 1) inputs[idx + 1].focus();
        if (inputs.every(function (i) { return i.value; })) {
          var form = document.getElementById('otpForm');
          if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
        }
      });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Backspace' && !this.value && idx > 0) inputs[idx - 1].focus();
        if (e.key === 'ArrowLeft' && idx > 0) inputs[idx - 1].focus();
        if (e.key === 'ArrowRight' && idx < inputs.length - 1) inputs[idx + 1].focus();
      });
      // Pasting the whole code into any box fills the row.
      input.addEventListener('paste', function (e) {
        var text = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '');
        if (!text) return;
        e.preventDefault();
        inputs.forEach(function (box, i) { box.value = text[i] || ''; });
        var next = inputs.findIndex(function (b) { return !b.value; });
        (next === -1 ? inputs[inputs.length - 1] : inputs[next]).focus();
        if (next === -1) {
          var form = document.getElementById('otpForm');
          if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
        }
      });
    });
  }

  // ------------------------------------------------------- consent gate ----
  // The server refuses a sign-up without consent regardless; this mirrors that
  // in the UI so the button state matches what will actually happen.
  var signupForm = document.getElementById('signupForm');
  if (signupForm) {
    var consent = document.getElementById('consent');
    var submit = document.getElementById('signupSubmit');
    var isMinor = document.getElementById('isMinor');
    var guardianBox = document.getElementById('guardianBox');

    var sync = function () {
      var ok = consent && consent.checked;
      if (isMinor && isMinor.checked) {
        var name = document.getElementById('guardianName');
        var contact = document.getElementById('guardianContact');
        ok = ok && name && name.value.trim() && contact && contact.value.trim();
      }
      if (submit) submit.disabled = !ok;
    };

    consent && consent.addEventListener('change', sync);
    if (isMinor && guardianBox) {
      isMinor.addEventListener('change', function () {
        guardianBox.classList.toggle('show', isMinor.checked);
        var name = document.getElementById('guardianName');
        var contact = document.getElementById('guardianContact');
        if (name) name.required = isMinor.checked;
        if (contact) contact.required = isMinor.checked;
        sync();
      });
      guardianBox.addEventListener('input', sync);
    }
    sync();
  }

  // ------------------------------------------------------- batch upload ----
  var batchDropzone = document.getElementById('batchDropzone');
  if (batchDropzone) {
    var fileInput = document.getElementById('batchFileInput');
    var chosen = document.getElementById('batchChosen');
    var fileNameEl = document.getElementById('batchFileName');
    var csvField = document.getElementById('batchCsvField');
    var xlsxField = document.getElementById('batchXlsxField');
    var nameField = document.getElementById('batchNameField');
    var batchSubmit = document.getElementById('batchSubmit');
    var removeBtn = document.getElementById('batchRemove');

    var accept = function (file, label) {
      nameField.value = file.name;
      fileNameEl.textContent = file.name + ' · ' + Math.round(file.size / 1024) + ' KB · ' + label;
      chosen.hidden = false;
      batchDropzone.hidden = true;
      batchSubmit.disabled = false;
    };

    var readFile = function (file) {
      if (!file) return;
      // Base64 inflates by ~33%, so keep the raw cap below the server's body limit.
      if (file.size > 6 * 1024 * 1024) {
        alert('That file is larger than 6 MB. Split it into smaller batches.');
        return;
      }
      csvField.value = '';
      if (xlsxField) xlsxField.value = '';

      var isXlsx = /\.xlsx$/i.test(file.name)
        || file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

      if (/\.xls$/i.test(file.name)) {
        alert('That is an older .xls file. Open it in Excel and "Save As" .xlsx or .csv, then upload again.');
        return;
      }

      var reader = new FileReader();
      reader.onerror = function () { alert('Could not read that file.'); };

      if (isXlsx) {
        // Excel files are binary, so send them base64-encoded in the form field.
        reader.onload = function (e) {
          var bytes = new Uint8Array(e.target.result);
          var binary = '';
          var chunk = 0x8000; // chunked to avoid blowing the argument limit
          for (var i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
          }
          xlsxField.value = btoa(binary);
          accept(file, 'Excel');
        };
        reader.readAsArrayBuffer(file);
      } else {
        reader.onload = function (e) {
          csvField.value = e.target.result;
          accept(file, 'CSV');
        };
        reader.readAsText(file);
      }
    };

    batchDropzone.addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () { readFile(this.files[0]); });

    ['dragenter', 'dragover'].forEach(function (evt) {
      batchDropzone.addEventListener(evt, function (e) {
        e.preventDefault();
        batchDropzone.classList.add('drag');
      });
    });
    ['dragleave', 'drop'].forEach(function (evt) {
      batchDropzone.addEventListener(evt, function (e) {
        e.preventDefault();
        batchDropzone.classList.remove('drag');
      });
    });
    batchDropzone.addEventListener('drop', function (e) {
      readFile(e.dataTransfer.files[0]);
    });

    removeBtn && removeBtn.addEventListener('click', function () {
      csvField.value = '';
      if (xlsxField) xlsxField.value = '';
      nameField.value = '';
      fileInput.value = '';
      chosen.hidden = true;
      batchDropzone.hidden = false;
      batchSubmit.disabled = true;
    });
  }

  // --------------------------------------------------- document upload -----
  var docDropzone = document.getElementById('docDropzone');
  if (docDropzone) {
    var docInput = document.getElementById('docFileInput');
    var docChosen = document.getElementById('docChosen');
    var docName = document.getElementById('docFileName');
    var docSubmit = document.getElementById('docSubmit');
    var docRemove = document.getElementById('docRemove');

    docDropzone.addEventListener('click', function () { docInput.click(); });
    docInput.addEventListener('change', function () {
      var file = this.files[0];
      if (!file) return;
      docName.textContent = file.name;
      docChosen.hidden = false;
      docDropzone.hidden = true;
      docSubmit.disabled = false;
    });
    docRemove && docRemove.addEventListener('click', function () {
      docInput.value = '';
      docChosen.hidden = true;
      docDropzone.hidden = false;
      docSubmit.disabled = true;
    });
  }

  // ------------------------------------------------- mark-applied ping ----
  // Opening the official application marks the scheme as applied, so the
  // student's "Applied" list reflects what they actually acted on.
  var applyLink = document.querySelector('[data-mark-applied]');
  if (applyLink && applyLink.getAttribute('data-mark-applied')) {
    applyLink.addEventListener('click', function () {
      var id = this.getAttribute('data-mark-applied');
      if (navigator.sendBeacon) navigator.sendBeacon('/applied/' + id);
      else fetch('/applied/' + id, { method: 'POST', keepalive: true });
    });
  }

  // ------------------------------------------ guided form: auto-advance ----
  // Selecting a radio on a single-question step moves straight on, which is
  // what makes the six-question form feel like it takes two minutes.
  var stepForm = document.querySelector('form[action="/onboarding"]');
  if (stepForm) {
    var radios = stepForm.querySelectorAll('input[type="radio"]');
    if (radios.length) {
      radios.forEach(function (radio) {
        radio.addEventListener('change', function () {
          setTimeout(function () {
            stepForm.requestSubmit ? stepForm.requestSubmit() : stepForm.submit();
          }, 180);
        });
      });
    }
    var select = stepForm.querySelector('select');
    if (select) {
      select.addEventListener('change', function () {
        if (this.value) setTimeout(function () {
          stepForm.requestSubmit ? stepForm.requestSubmit() : stepForm.submit();
        }, 180);
      });
    }
  }

  // ------------------------------------------- full-page loading state ----
  /**
   * Navigations and posts take real time — a scheme search hits the catalogue,
   * a batch import chews through a spreadsheet. Without a signal the browser
   * just sits there and the app reads as broken.
   *
   * Everything here is built in JavaScript and appended to the body, so with
   * scripting off the overlay does not exist at all and there is nothing that
   * can be left stuck on screen. The button-level spinner above still handles
   * the form it belongs to; this is the page-level companion to it.
   */
  var PL_SHOW_DELAY = 250;    // fast navigations finish before this and never flash
  var PL_SLOW_AFTER = 15000;  // after this we admit something is wrong

  var plRoot = null;
  var plSlowNote = null;
  var plActions = null;
  var plShowTimer = null;
  var plSlowTimer = null;
  var plArmed = false;
  var plHidden = [];    // real elements we hid behind skeletons
  var plInserted = [];  // skeleton placeholders we added

  function pageLoaderBuild() {
    if (plRoot || !document.body) return;

    plRoot = document.createElement('div');
    plRoot.className = 'page-loader';
    plRoot.id = 'pageLoader';
    plRoot.hidden = true;
    plRoot.setAttribute('aria-hidden', 'true');

    var panel = document.createElement('div');
    panel.className = 'pl-panel';
    panel.setAttribute('role', 'status');
    panel.setAttribute('aria-live', 'polite');

    var badge = document.createElement('div');
    badge.className = 'pl-badge';
    var ring = document.createElement('span');
    ring.className = 'pl-ring';
    var logo = document.createElement('img');
    logo.src = '/img/logo.jpeg';
    logo.alt = '';           // decorative; the status text carries the meaning
    logo.width = 56;
    logo.height = 56;
    // If the logo file ever goes missing, the framed ring stands on its own
    // rather than showing a broken-image glyph.
    logo.addEventListener('error', function () { badge.classList.add('is-broken'); });
    badge.appendChild(ring);
    badge.appendChild(logo);

    var text = document.createElement('p');
    text.className = 'pl-text';
    text.textContent = 'Loading…';

    plSlowNote = document.createElement('p');
    plSlowNote.className = 'pl-slow';
    plSlowNote.hidden = true;
    plSlowNote.textContent = 'This is taking longer than usual. It may still arrive — '
      + 'you can wait, reload, or carry on with the page underneath.';

    plActions = document.createElement('div');
    plActions.className = 'pl-actions';
    plActions.hidden = true;

    var reload = document.createElement('button');
    reload.type = 'button';
    reload.className = 'pl-btn pl-btn-primary';
    reload.textContent = 'Reload';
    reload.addEventListener('click', function () { window.location.reload(); });

    var dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'pl-btn';
    dismiss.textContent = 'Hide this';
    dismiss.addEventListener('click', pageLoaderReset);

    plActions.appendChild(reload);
    plActions.appendChild(dismiss);

    panel.appendChild(badge);
    panel.appendChild(text);
    panel.appendChild(plSlowNote);
    panel.appendChild(plActions);
    plRoot.appendChild(panel);
    document.body.appendChild(plRoot);
  }

  /** Starts the clock. Nothing is shown yet — see PL_SHOW_DELAY. */
  function pageLoaderArm(options) {
    if (plArmed) return;
    pageLoaderBuild();
    if (!plRoot) return;
    plArmed = true;
    document.documentElement.classList.add('is-navigating');
    plShowTimer = window.setTimeout(pageLoaderShow, PL_SHOW_DELAY);
    if (options && options.skeleton) pageSkeletonShow();
  }

  function pageLoaderShow() {
    plShowTimer = null;
    if (!plRoot) return;
    plRoot.hidden = false;
    plRoot.setAttribute('aria-hidden', 'false');
    var reveal = function () { plRoot.classList.add('is-visible'); };
    if (window.requestAnimationFrame) window.requestAnimationFrame(reveal);
    else reveal();
    plSlowTimer = window.setTimeout(pageLoaderSlow, PL_SLOW_AFTER);
  }

  /** Never spin forever: say so, and offer a way out. */
  function pageLoaderSlow() {
    plSlowTimer = null;
    if (plSlowNote) plSlowNote.hidden = false;
    if (plActions) plActions.hidden = false;
  }

  /** Back to rest: timers cleared, overlay gone, skeletons swapped back. */
  function pageLoaderReset() {
    if (plShowTimer) window.clearTimeout(plShowTimer);
    if (plSlowTimer) window.clearTimeout(plSlowTimer);
    plShowTimer = plSlowTimer = null;
    plArmed = false;
    document.documentElement.classList.remove('is-navigating');
    if (plRoot) {
      plRoot.classList.remove('is-visible');
      plRoot.hidden = true;
      plRoot.setAttribute('aria-hidden', 'true');
    }
    if (plSlowNote) plSlowNote.hidden = true;
    if (plActions) plActions.hidden = true;
    pageSkeletonRestore();
  }

  // ------------------------------------------------------ skeleton rows ---
  /**
   * When a search or a filter reloads the same list, the results that are
   * about to be replaced step aside for placeholders. Stale rows sitting under
   * a loading overlay look like the answer; these do not.
   *
   * The originals are hidden, not removed, so dismissing the overlay puts the
   * page back exactly as it was.
   */
  function plSkeletonCard() {
    var card = document.createElement('div');
    card.className = 'skeleton-card';
    card.setAttribute('aria-hidden', 'true');
    ['w-60', 'w-85', 'w-40'].forEach(function (width) {
      var line = document.createElement('div');
      line.className = 'skeleton-line ' + width;
      card.appendChild(line);
    });
    return card;
  }

  function plSkeletonRow(cells) {
    var row = document.createElement('tr');
    row.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < cells; i++) {
      var cell = document.createElement('td');
      var line = document.createElement('div');
      line.className = 'skeleton-line';
      cell.appendChild(line);
      row.appendChild(cell);
    }
    return row;
  }

  function pageSkeletonShow() {
    var scope = document.querySelector('.main-area') || document.body;
    var cards = Array.prototype.slice.call(scope.querySelectorAll('.scheme-card'));
    var rows = cards.length
      ? []
      : Array.prototype.slice.call(scope.querySelectorAll('table tbody tr'));
    var real = cards.length ? cards : rows;
    if (!real.length) return;

    var anchor = real[0];
    var count = Math.min(real.length, 5);
    for (var i = 0; i < count; i++) {
      var placeholder = cards.length
        ? plSkeletonCard()
        : plSkeletonRow(anchor.children.length || 3);
      anchor.parentNode.insertBefore(placeholder, anchor);
      plInserted.push(placeholder);
    }
    real.forEach(function (el) {
      el.classList.add('skeleton-hidden');
      plHidden.push(el);
    });
  }

  /** True for a GET form that reloads the list already on screen — search, filters. */
  function plFormRefinesThisPage(form) {
    var method = (form.getAttribute('method') || 'get').toLowerCase();
    if (method !== 'get') return false;
    try {
      return new URL(form.action, window.location.href).pathname === window.location.pathname;
    } catch (err) {
      return false;
    }
  }

  function pageSkeletonRestore() {
    plInserted.forEach(function (el) {
      if (el.parentNode) el.parentNode.removeChild(el);
    });
    plHidden.forEach(function (el) { el.classList.remove('skeleton-hidden'); });
    plInserted = [];
    plHidden = [];
  }

  // ---------------------------------------------------- link navigation ---
  /**
   * A same-origin link that really navigates gets the same indicator as a
   * form post. Everything that does not replace this page is left alone:
   * external hosts, new tabs, downloads, in-page anchors, and modified clicks
   * (cmd/ctrl/shift/alt, middle button) which open elsewhere.
   */
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented) return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (!e.target || !e.target.closest) return;

    var link = e.target.closest('a[href]');
    if (!link) return;
    if (link.hasAttribute('download')) return;
    if (link.hasAttribute('data-back')) return;          // history.back(), usually instant
    if (link.hasAttribute('data-no-progress')) return;

    var target = link.getAttribute('target');
    if (target && target !== '_self') return;

    var href = link.getAttribute('href') || '';
    if (!href || href.charAt(0) === '#') return;
    if (/^(mailto|tel|sms|javascript|blob|data):/i.test(href)) return;

    var url;
    try { url = new URL(link.href, window.location.href); } catch (err) { return; }
    if (url.origin !== window.location.origin) return;
    // Served as an attachment: the browser downloads it and this page stays put.
    if (/\.(csv|json|xlsx|xls|pdf|zip)$/i.test(url.pathname)) return;

    var samePage = url.pathname === window.location.pathname && url.search === window.location.search;
    if (samePage && url.hash !== window.location.hash) return;  // jump within this page

    pageLoaderArm({ skeleton: url.pathname === window.location.pathname });
  });

  // ----------------------------------------------------- escape hatches ---
  // Whatever happens, the overlay is never a trap.
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && plArmed) pageLoaderReset();
  });

  /**
   * Dismissed on arrival, and again when the browser hands back a cached page
   * on back/forward — bfcache restores the DOM exactly as it was left, overlay
   * included, so without this a "back" would land on a frozen loading screen.
   */
  window.addEventListener('pageshow', function () { pageLoaderReset(); });
  window.addEventListener('load', function () { pageLoaderReset(); });

  pageLoaderBuild();
})();
