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
