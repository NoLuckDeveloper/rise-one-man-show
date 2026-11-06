'use strict';
// Rise One Man Show — small client helpers: live timer, GPS travel miles,
// dynamic parts rows, photo downscale-to-dataURL, sheet open/close.

// --- Live timer -------------------------------------------------------------
setInterval(() => {
  document.querySelectorAll('.live-timer').forEach((el) => {
    const since = el.getAttribute('data-since');
    if (!since) return;
    const ms = Date.now() - new Date(since).getTime();
    if (ms < 0) return;
    const s = Math.floor(ms / 1000);
    const h = String(Math.floor(s / 3600)).padStart(2, '0');
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    el.textContent = `${h}:${m}:${ss}`;
  });
}, 1000);

// --- Sheets -------------------------------------------------------------------
document.querySelectorAll('[data-open]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const el = document.getElementById(btn.getAttribute('data-open'));
    if (el) el.hidden = false;
  });
});
document.querySelectorAll('[data-close]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const sheet = btn.closest('.sheet');
    if (sheet) sheet.hidden = true;
  });
});

// --- GPS travel miles -----------------------------------------------------------
function haversineMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const gpsBtn = document.getElementById('gps-start');
if (gpsBtn) {
  // Inside the native app, the foreground service tracks this trip — the
  // page GPS would double-count miles and stops when backgrounded, so it
  // stays off and the native status shows instead.
  if (window.RiseNative && window.RiseNative.isNative && window.RiseNative.isNative()) {
    gpsBtn.textContent = 'Native GPS tracking';
    gpsBtn.disabled = true;
    const status = document.getElementById('gps-status');
    if (status) status.textContent = 'Tracking in the background — miles update live.';
  } else {
  let watchId = null;
  let last = null;
  let total = 0;
  gpsBtn.addEventListener('click', () => {
    const status = document.getElementById('gps-status');
    const out = document.getElementById('gps-miles');
    const input = document.getElementById('miles-input');
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
      gpsBtn.textContent = 'Start GPS';
      if (status) status.textContent = 'GPS stopped.';
      return;
    }
    if (!navigator.geolocation) {
      if (status) status.textContent = 'Geolocation not available on this device.';
      return;
    }
    gpsBtn.textContent = 'Stop GPS';
    if (status) status.textContent = 'Tracking… keep this page open.';
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        if (last) {
          const d = haversineMiles(last.lat, last.lng, latitude, longitude);
          if (d > 0.005) { total += d; last = { lat: latitude, lng: longitude }; }
        } else {
          last = { lat: latitude, lng: longitude };
        }
        const rounded = Math.round(total * 100) / 100;
        if (out) out.textContent = rounded.toFixed(2);
        if (input) input.value = rounded;
      },
      () => { if (status) status.textContent = 'Location permission denied — type miles instead.'; },
      { enableHighAccuracy: true, maximumAge: 5000 }
    );
  });
  }
}

// --- Native app bridge: background trip tracking -------------------------------
// On the traveling page, tell the native app which call's trip is open so its
// foreground service posts live positions for it (the trip row already exists
// by the time this page loads, so there is no start race). Stop tracking when
// the job starts or the travel leg is canceled. In a browser this is a no-op.
if (window.RiseNative && window.RiseNative.isNative && window.RiseNative.isNative()) {
  const jobForm = document.querySelector('form[action$="/start-job"]');
  if (jobForm) {
    const m = jobForm.action.match(/\/app\/calls\/(\d+)\/start-job/);
    if (m) window.RiseNative.startTrip(parseInt(m[1], 10));
    jobForm.addEventListener('submit', () => window.RiseNative.stopTrip());
  }
  document.querySelectorAll('form[action$="/cancel-travel"]').forEach((f) => {
    f.addEventListener('submit', () => window.RiseNative.stopTrip());
  });
}
// Manual miles override the GPS value at submit time.
const milesManual = document.getElementById('miles-manual');
if (milesManual) {
  milesManual.addEventListener('input', () => {
    const input = document.getElementById('miles-input');
    if (input && milesManual.value) input.value = milesManual.value;
  });
}

// --- Parts rows -------------------------------------------------------------------
const addPartBtn = document.getElementById('add-part');
if (addPartBtn) {
  addPartBtn.addEventListener('click', () => {
    const row = document.querySelector('.part-row').cloneNode(true);
    row.querySelectorAll('input').forEach((i) => (i.value = ''));
    document.getElementById('parts').appendChild(row);
    bindPartRemovers();
  });
}
function bindPartRemovers() {
  document.querySelectorAll('[data-remove-part]').forEach((btn) => {
    btn.onclick = () => {
      const rows = document.querySelectorAll('.part-row');
      if (rows.length > 1) btn.closest('.part-row').remove();
    };
  });
}
bindPartRemovers();

// --- Follow-up reveal ---------------------------------------------------------------
const fuCheck = document.getElementById('follow-up-check');
if (fuCheck) {
  fuCheck.addEventListener('change', () => {
    const box = document.getElementById('follow-up-box');
    if (box) box.hidden = !fuCheck.checked;
  });
}

// --- Photo handling: downscale to dataURL --------------------------------------------
function fileToDataUrl(file, maxDim) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => resolve('');
    img.src = url;
  });
}

// Single receipt photo: <input type=file data-photo-input="fieldName">
document.querySelectorAll('[data-photo-input]').forEach((input) => {
  input.addEventListener('change', async () => {
    const form = input.closest('form');
    const hidden = form.querySelector(`input[name="${input.getAttribute('data-photo-input')}"]`);
    const row = form.querySelector('.thumb-row');
    if (!input.files.length) return;
    const dataUrl = await fileToDataUrl(input.files[0], 1200);
    if (hidden) hidden.value = dataUrl;
    if (row && dataUrl) row.innerHTML = `<img class="thumb" src="${dataUrl}">`;
  });
});

// Multi photos for job reports: keeps a JSON array in #photos-json.
document.querySelectorAll('[data-photo-multi]').forEach((input) => {
  input.addEventListener('change', async () => {
    const hidden = document.getElementById('photos-json');
    const thumbs = document.getElementById('photo-thumbs');
    let photos = [];
    try { photos = JSON.parse(hidden.value || '[]'); } catch (e) { photos = []; }
    for (const file of input.files) {
      const dataUrl = await fileToDataUrl(file, 1200);
      if (dataUrl) {
        photos.push(dataUrl);
        if (thumbs) thumbs.innerHTML += `<img class="thumb" src="${dataUrl}">`;
      }
    }
    hidden.value = JSON.stringify(photos);
  });
});

// --- Signature pad (public proposal approval) ---------------------------------
// Canvas drawing with pointer events; the Approve button stays blocked until
// the customer has actually drawn something. The server re-validates the
// captured image, so clearing this client check alone cannot approve.
const sigPad = document.getElementById('sig-pad');
if (sigPad) {
  const ctx = sigPad.getContext('2d');
  ctx.strokeStyle = '#111827';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  let drawing = false;
  let signed = false;
  let last = null;
  const pos = (e) => {
    const r = sigPad.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (sigPad.width / r.width), y: (e.clientY - r.top) * (sigPad.height / r.height) };
  };
  sigPad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    drawing = true;
    last = pos(e);
    sigPad.setPointerCapture(e.pointerId);
  });
  sigPad.addEventListener('pointermove', (e) => {
    if (!drawing || !last) return;
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last = p;
    signed = true;
    const err = document.getElementById('sig-error');
    if (err) err.hidden = true;
  });
  const stop = () => { drawing = false; last = null; };
  sigPad.addEventListener('pointerup', stop);
  sigPad.addEventListener('pointercancel', stop);
  const clearBtn = document.getElementById('sig-clear');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      ctx.clearRect(0, 0, sigPad.width, sigPad.height);
      signed = false;
      const data = document.getElementById('sig-data');
      if (data) data.value = '';
    });
  }
  const approveForm = document.getElementById('approve-form');
  if (approveForm) {
    approveForm.addEventListener('submit', (e) => {
      if (!signed) {
        e.preventDefault();
        const err = document.getElementById('sig-error');
        if (err) err.hidden = false;
        sigPad.focus();
        return;
      }
      const data = document.getElementById('sig-data');
      if (data) data.value = sigPad.toDataURL('image/png');
    });
  }
}
