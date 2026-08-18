/**
 * Progressive enhancement only. Every flow works without this file — forms
 * post normally, the consent gate is enforced server-side, and the CSV upload
 * degrades to a plain field. This just makes the common paths pleasant.
 */

(function () {
  'use strict';

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
})();
