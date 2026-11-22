/* Project Run web app: screens and phone plumbing. All run maths lives in engine.js. */
(function () {
  'use strict';
  var VERSION = 'web 0.1';
  var $ = function (id) { return document.getElementById(id); };
  function h(tag, attrs, kids) {
    var e = document.createElement(tag), k;
    for (k in attrs || {}) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) e.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  var km = function (m) { return (m / 1000).toFixed(2); };
  var fmtDate = function (ms) { return new Date(ms).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }); };
  var fmtClock = function (ms) { return new Date(ms).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }); };

  /* ---------- storage: profile in localStorage, runs in IndexedDB (memory fallback) ---------- */
  var mem = {};
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : (k in mem ? mem[k] : d); } catch (e) { return k in mem ? mem[k] : d; } }
  function lsSet(k, v) { mem[k] = v; try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } }
  function lsDel(k) { delete mem[k]; try { localStorage.removeItem(k); } catch (e) { } }
  var DB = {
    db: null, fallback: [],
    open: function () {
      return new Promise(function (res) {
        try {
          var rq = indexedDB.open('projectrun', 1);
          rq.onupgradeneeded = function () { rq.result.createObjectStore('runs', { keyPath: 'id' }); };
          rq.onsuccess = function () { DB.db = rq.result; res(); };
          rq.onerror = function () { res(); };
        } catch (e) { res(); }
      });
    },
    tx: function (mode, fn) {
      return new Promise(function (res) {
        if (!DB.db) return res(fn(null));
        try { var t = DB.db.transaction('runs', mode), out = fn(t.objectStore('runs')); t.oncomplete = function () { res(out && out.result !== undefined ? out.result : out); }; t.onerror = function () { res(null); }; }
        catch (e) { res(null); }
      });
    },
    all: function () { return DB.tx('readonly', function (s) { return s ? s.getAll() : DB.fallback.slice(); }).then(function (r) { return (r || []).sort(function (a, b) { return b.startedAt - a.startedAt; }); }); },
    put: function (run) { return DB.tx('readwrite', function (s) { if (s) s.put(run); else { DB.fallback = DB.fallback.filter(function (x) { return x.id !== run.id; }); DB.fallback.push(run); } }); },
    del: function (id) { return DB.tx('readwrite', function (s) { if (s) s.delete(id); else DB.fallback = DB.fallback.filter(function (x) { return x.id !== id; }); }); },
    clear: function () { return DB.tx('readwrite', function (s) { if (s) s.clear(); else DB.fallback = []; }); }
  };

  var S = { profile: lsGet('pr_profile', null), runs: [], tab: 'run', detail: null, gps: null, gpsErr: null, watchId: null, tr: null, wake: null, timer: null, hiddenAt: null, spoken: 0, msg: '' };

  /* ---------- GPS ---------- */
  function startGPS() {
    if (S.watchId !== null) return;
    if (!('geolocation' in navigator)) { S.gpsErr = 'This browser has no location support.'; return; }
    S.gpsErr = null;
    S.watchId = navigator.geolocation.watchPosition(onFix, function (err) {
      S.gpsErr = err.code === 1 ? 'Location is blocked. Allow it for this site in your browser settings, then reload.' : 'Waiting for a GPS signal. Step outside under open sky.';
      if (err.code === 1) { navigator.geolocation.clearWatch(S.watchId); S.watchId = null; }
      chips(); if (S.tab === 'run' && !S.tr) render();
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  }
  function onFix(pos) {
    var c = pos.coords, now = Date.now(), first = !S.gps;
    S.gps = { acc: c.accuracy, t: now }; S.gpsErr = null;
    if (S.tr) {
      S.tr.add({ lat: c.latitude, lon: c.longitude, acc: c.accuracy, t: now, alt: c.altitude, altAcc: c.altitudeAccuracy, speed: c.speed });
      if (S.tr.splits.length > S.spoken) {
        S.spoken = S.tr.splits.length;
        var t = S.tr.movingMs / 1000, p = S.tr.avgPace();
        speak(S.spoken + (S.spoken === 1 ? ' kilometre, ' : ' kilometres, ') + Math.floor(t / 60) + ' minutes ' + Math.round(t % 60) + ' seconds, pace ' + Math.floor(p / 60) + ' ' + Math.round(p % 60));
      }
    }
    chips(); if (first && S.tab === 'run' && !S.tr) render();
  }
  function gpsLevel() {
    if (!S.gps || Date.now() - S.gps.t > 15000) return ['bad', S.gpsErr ? 'No GPS' : 'Finding GPS'];
    if (S.gps.acc <= 10) return ['ok', 'GPS strong'];
    if (S.gps.acc <= 25) return ['mid', 'GPS fair'];
    return ['bad', 'GPS weak'];
  }
  function chips() {
    var g = gpsLevel();
    ['lgps', 'hgps'].forEach(function (id) { var e = $(id); if (e) { e.className = 'chip ' + g[0]; e.lastChild.textContent = g[1] + (S.gps && g[0] !== 'bad' ? ' ±' + Math.round(S.gps.acc) + ' m' : ''); } });
  }
  function speak(text) {
    if (!S.profile || S.profile.voice === false || !('speechSynthesis' in window)) return;
    try { var u = new SpeechSynthesisUtterance(text); u.lang = 'en-IN'; speechSynthesis.speak(u); } catch (e) { }
  }
  function wakeOn() { if ('wakeLock' in navigator) navigator.wakeLock.request('screen').then(function (w) { S.wake = w; }).catch(function () { }); }
  function wakeOff() { if (S.wake) { try { S.wake.release(); } catch (e) { } S.wake = null; } }

  /* ---------- live run ---------- */
  function beginRun() {
    startGPS(); wakeOn(); speak(' ');
    $('live').classList.add('on'); $('count').classList.add('on');
    var n = 3; $('count').textContent = n;
    var iv = setInterval(function () {
      n--; if (n > 0) { $('count').textContent = n; return; }
      clearInterval(iv); $('count').classList.remove('on');
      S.tr = new PR.Tracker({ weightKg: S.profile.weightKg, autoPause: S.profile.autoPause !== false });
      S.tr.start(Date.now()); S.spoken = 0; S.msg = ''; S.lastSave = Date.now();
      S.timer = setInterval(liveTick, 500); liveTick();
    }, 1000);
  }
  function liveMs() {
    var tr = S.tr; if (!tr) return 0;
    var extra = (tr.state === 'running' && tr.last) ? Math.max(0, Math.min(Date.now() - tr.last.t, 15000)) : 0;
    return tr.movingMs + extra;
  }
  function liveTick() {
    var tr = S.tr; if (!tr) return;
    $('ldist').textContent = km(tr.distM);
    $('ltime').textContent = PR.fmtTime(liveMs());
    $('lpace').textContent = PR.fmtPace(tr.currentPace());
    $('lavg').textContent = PR.fmtPace(tr.avgPace());
    $('lkcal').textContent = Math.round(tr.kcal);
    var st = $('lstate'), paused = tr.state !== 'running';
    st.textContent = tr.state === 'autopaused' ? 'Auto-paused' : tr.state === 'paused' ? 'Paused' : 'Running';
    st.className = paused ? 'paused' : '';
    $('bpause').textContent = tr.state === 'paused' ? 'Resume' : 'Pause';
    var g = gpsLevel();
    $('lmsg').textContent = S.msg || (g[0] === 'bad' && tr.state === 'running' ? (S.gpsErr || 'Waiting for a good GPS signal. Distance resumes when it returns.') : tr.state === 'autopaused' ? 'You stopped moving. The clock restarts when you do.' : '');
    chips();
    if (Date.now() - S.lastSave > 20000) { S.lastSave = Date.now(); lsSet('pr_live', tr.toRun()); }
  }
  function endLive() { clearInterval(S.timer); S.timer = null; S.tr = null; wakeOff(); lsDel('pr_live'); $('live').classList.remove('on'); }
  function sheet(title, text, buttons) {
    var b = $('sheetbody'); b.textContent = '';
    b.appendChild(h('h3', { text: title })); b.appendChild(h('p', { text: text }));
    buttons.forEach(function (x) { b.appendChild(h('button', { class: 'btn ' + (x[2] || ''), text: x[0], onclick: function () { $('sheet').classList.remove('on'); if (x[1]) x[1](); } })); });
    $('sheet').classList.add('on');
  }
  function askFinish() {
    var tr = S.tr; if (!tr) return;
    var was = tr.state; tr.pause(); liveTick();
    sheet('Finish this run?', km(tr.distM) + ' km in ' + PR.fmtTime(tr.movingMs) + '.', [
      ['Save run', function () {
        tr.finish(Date.now()); var run = tr.toRun(); endLive();
        if (run.distM < 20) { S.tab = 'run'; render(); sheet('Run not saved', 'It was shorter than 20 metres, so there is nothing to record.', [['OK']]); return; }
        DB.put(run).then(loadRuns).then(function () { S.tab = 'history'; S.detail = run.id; render(); });
      }, 'dark'],
      ['Keep running', function () { if (was !== 'paused') tr.resume(); liveTick(); }],
      ['Discard run', function () { endLive(); render(); }, 'danger']
    ]);
  }
  document.addEventListener('visibilitychange', function () {
    if (!S.tr) return;
    if (document.hidden) { S.hiddenAt = Date.now(); lsSet('pr_live', S.tr.toRun()); }
    else {
      wakeOn();
      if (S.hiddenAt && Date.now() - S.hiddenAt > 8000 && S.tr.state === 'running') {
        S.msg = 'Screen was off for ' + PR.fmtTime(Date.now() - S.hiddenAt) + '. That stretch is counted as a straight line.';
        setTimeout(function () { S.msg = ''; }, 12000);
      }
      S.hiddenAt = null;
    }
  });

  /* ---------- screens ---------- */
  function loadRuns() { return DB.all().then(function (r) { S.runs = r; }); }
  function render() {
    var v = $('view'); v.textContent = '';
    document.querySelectorAll('nav button').forEach(function (b) { if (b.dataset.tab === S.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    if (!S.profile || !S.profile.weightKg) return viewProfile(v, true);
    ({ run: viewRun, history: viewHistory, stats: viewStats, profile: viewProfile })[S.tab](v);
    window.scrollTo(0, 0);
  }
  function stat(val, label) { return h('div', { class: 'stat' }, [h('b', { class: 'num', text: val }), h('small', { text: label })]); }

  function viewRun(v) {
    var st = PR.stats(S.runs), hr = new Date().getHours();
    v.appendChild(h('h1', { text: (hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening') + (S.profile.name ? ', ' + S.profile.name : '') + '.' }));
    v.appendChild(h('div', { class: 'card' }, [
      h('div', { class: 'row' }, [stat(km(st.week.distM), 'km this week'), stat(String(st.week.runs), st.week.runs === 1 ? 'run' : 'runs'), stat(String(st.streak), 'day streak')])
    ]));
    v.appendChild(h('div', { style: 'margin:18px 4px 10px' }, [h('span', { class: 'chip', id: 'hgps' }, [h('i'), h('span', { text: 'GPS' })])]));
    if (S.watchId === null && !S.gps) {
      v.appendChild(h('button', { class: 'btn', text: 'Turn on GPS', onclick: function () { startGPS(); render(); } }));
      v.appendChild(h('p', { class: 'note', text: S.gpsErr || 'Your location is used only to record your runs. It stays on this phone.' }));
    } else if (S.gpsErr) v.appendChild(h('p', { class: 'note warn', text: S.gpsErr }));
    v.appendChild(h('div', { style: 'height:10px' }));
    v.appendChild(h('button', { class: 'big', id: 'bstart', text: 'START RUN', onclick: beginRun }));
    v.appendChild(h('p', { class: 'note warn', text: 'Web version: keep this screen on and the phone unlocked while you run. Tracking stops if the screen locks. The Android app removes this limit.' }));
    chips();
  }

  function viewHistory(v) {
    var run = S.detail && S.runs.filter(function (r) { return r.id === S.detail; })[0];
    if (run) return viewDetail(v, run);
    v.appendChild(h('h1', { text: 'Your runs' }));
    if (!S.runs.length) { v.appendChild(h('p', { class: 'note', text: 'No runs yet. Your first one will show up here.' })); return; }
    S.runs.forEach(function (r) {
      v.appendChild(h('div', { class: 'card', style: 'padding:0' }, [h('button', { class: 'item', onclick: function () { S.detail = r.id; render(); } }, [
        h('span', {}, [h('b', { class: 'num', text: km(r.distM) + ' km' }), h('small', { text: fmtDate(r.startedAt) + ', ' + fmtClock(r.startedAt) + (r.recovered ? ' (recovered)' : '') })]),
        h('span', { style: 'text-align:right' }, [h('b', { class: 'num', text: PR.fmtTime(r.movingMs) }), h('small', { class: 'num', text: PR.fmtPace(r.movingMs / r.distM) + ' /km' })])
      ])]));
    });
  }

  function segments(run) {
    var segs = [], cur = null, last = null;
    run.pts.forEach(function (p) { if (last === null || p[3] !== last) { cur = []; segs.push(cur); last = p[3]; } cur.push(p); });
    return segs;
  }
  function paceSeries(run) {   // pace for each 30 s of movement
    var out = [];
    segments(run).forEach(function (sg) {
      var a = 0, d = 0;
      for (var i = 1; i < sg.length; i++) {
        d += PR.hav({ lat: sg[i - 1][0], lon: sg[i - 1][1] }, { lat: sg[i][0], lon: sg[i][1] });
        if (sg[i][2] - sg[a][2] >= 30000) { if (d > 15) out.push((sg[i][2] - sg[a][2]) / d); a = i; d = 0; }
      }
    });
    return out;   // seconds per km (ms per m is the same number)
  }
  function paceChart(run) {
    var s = paceSeries(run); if (s.length < 3) return null;
    var lo = Math.min.apply(null, s), hi = Math.max.apply(null, s); if (hi - lo < 20) { hi += 10; lo -= 10; }
    var W = 320, H = 110, pad = 8;
    var pts = s.map(function (p, i) { return (pad + i * (W - 2 * pad) / (s.length - 1)).toFixed(1) + ',' + (pad + (p - lo) / (hi - lo) * (H - 2 * pad)).toFixed(1); }).join(' ');
    var box = h('div', { class: 'card' });
    box.innerHTML = '<svg class="pace" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="Pace over the run"><polyline points="' + pts + '" fill="none" stroke="#ff5a1f" stroke-width="2.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>';
    box.appendChild(h('div', { class: 'row', style: 'font-size:12px;color:var(--mute)' }, [h('span', { text: 'Fastest ' + PR.fmtPace(lo) + ' /km (top)' }), h('span', { style: 'text-align:right', text: 'Slowest ' + PR.fmtPace(hi) + ' /km (bottom)' })]));
    return box;
  }
  function viewDetail(v, run) {
    v.appendChild(h('button', { class: 'chip', text: '← All runs', onclick: function () { S.detail = null; render(); } }));
    v.appendChild(h('h1', { text: km(run.distM) + ' km' }));
    v.appendChild(h('p', { class: 'note', style: 'margin-top:-8px', text: fmtDate(run.startedAt) + ', started ' + fmtClock(run.startedAt) + (run.recovered ? '. Recovered after the app closed mid-run.' : '') }));
    v.appendChild(h('div', { id: 'map' }));
    v.appendChild(h('div', { class: 'card', style: 'margin-top:12px' }, [
      h('div', { class: 'row' }, [stat(PR.fmtTime(run.movingMs), 'moving time'), stat(PR.fmtPace(run.movingMs / run.distM), 'avg pace /km')]),
      h('div', { class: 'row', style: 'margin-top:14px' }, [stat(String(run.kcal), 'kcal (estimate)'), stat(run.elevGain ? run.elevGain + ' m' : '–', 'elevation gain')])
    ]));
    v.appendChild(h('p', { class: 'note', text: 'Calories are an estimate from your pace and body weight (' + run.weightKg + ' kg), using the ACSM formula. A connected watch with heart rate will make this more accurate in the Android app.' }));
    if (run.splits.length) {
      v.appendChild(h('h2', { text: 'Splits' }));
      var best = Math.min.apply(null, run.splits.map(function (s) { return s.ms; }));
      var tb = h('table', {}, [h('tr', {}, [h('th', { text: 'Km' }), h('th', { text: 'Time' }), h('th', {})])]);
      run.splits.forEach(function (s) {
        tb.appendChild(h('tr', {}, [h('td', { class: 'num', text: String(s.km) }), h('td', { class: 'num', text: PR.fmtTime(s.ms) }), h('td', { class: 'bar' }, [h('i', { style: 'width:' + Math.round(best / s.ms * 100) + '%' })])]));
      });
      v.appendChild(h('div', { class: 'card' }, [tb]));
    }
    var pc = paceChart(run); if (pc) { v.appendChild(h('h2', { text: 'Pace' })); v.appendChild(pc); }
    v.appendChild(h('button', { class: 'btn danger', text: 'Delete this run', onclick: function () {
      sheet('Delete this run?', 'This cannot be undone.', [['Delete', function () { DB.del(run.id).then(loadRuns).then(function () { S.detail = null; render(); }); }, 'danger'], ['Cancel']]);
    } }));
    drawMap(run);
  }
  function drawMap(run) {
    if (!window.L || !run.pts.length) return;
    try {
      var map = L.map('map', { zoomControl: false });
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
      var all = [];
      segments(run).forEach(function (sg) { var ll = sg.map(function (p) { return [p[0], p[1]]; }); all = all.concat(ll); L.polyline(ll, { color: '#ff5a1f', weight: 5 }).addTo(map); });
      L.circleMarker(all[0], { radius: 7, color: '#fff', weight: 2, fillColor: '#12805c', fillOpacity: 1 }).addTo(map);
      L.circleMarker(all[all.length - 1], { radius: 7, color: '#fff', weight: 2, fillColor: '#101312', fillOpacity: 1 }).addTo(map);
      map.fitBounds(L.latLngBounds(all), { padding: [24, 24] });
    } catch (e) { }
  }

  function viewStats(v) {
    var st = PR.stats(S.runs);
    v.appendChild(h('h1', { text: 'Your numbers' }));
    function block(title, t) {
      v.appendChild(h('h2', { text: title }));
      v.appendChild(h('div', { class: 'card' }, [h('div', { class: 'row' }, [stat(km(t.distM), 'km'), stat(String(t.runs), 'runs'), stat(PR.fmtTime(t.movingMs), 'time'), stat(String(Math.round(t.kcal)), 'kcal')])]));
    }
    block('This week', st.week); block('This month', st.month);
    v.appendChild(h('h2', { text: 'Streak' }));
    v.appendChild(h('div', { class: 'card' }, [h('div', { class: 'row' }, [stat(String(st.streak), 'current, days'), stat(String(st.longestStreak), 'longest, days')])]));
    v.appendChild(h('h2', { text: 'Personal bests' }));
    var f = function (x) { return x === null ? '–' : PR.fmtTime(x); };
    v.appendChild(h('div', { class: 'card' }, [h('div', { class: 'row' }, [stat(f(st.pb.k1), '1 km'), stat(f(st.pb.k5), '5 km'), stat(f(st.pb.k10), '10 km'), stat(st.pb.longestM ? km(st.pb.longestM) : '–', 'longest, km')])]));
    v.appendChild(h('h2', { text: 'Distance, last 8 weeks' }));
    var max = Math.max.apply(null, st.weeks.map(function (w) { return w.distM; })) || 1;
    v.appendChild(h('div', { class: 'card' }, [h('div', { class: 'bars' }, st.weeks.map(function (w) {
      return h('div', {}, [h('b', { class: 'num', style: 'font-size:10px;font-weight:600', text: w.distM ? (w.distM / 1000).toFixed(1) : '' }), h('i', { style: 'height:' + Math.round(w.distM / max * 80) + '%' }), h('span', { text: new Date(w.start).getDate() + '/' + (new Date(w.start).getMonth() + 1) })]);
    }))]));
    var pw = st.weeks.filter(function (w) { return w.distM > 0; });
    if (pw.length > 1) {
      v.appendChild(h('h2', { text: 'Average pace by week' }));
      var tb = h('table'); pw.forEach(function (w) { tb.appendChild(h('tr', {}, [h('td', { text: 'Week of ' + fmtDate(w.start) }), h('td', { class: 'num', style: 'text-align:right', text: PR.fmtPace(w.movingMs / w.distM) + ' /km' })])); });
      v.appendChild(h('div', { class: 'card' }, [tb]));
    }
  }

  function viewProfile(v, first) {
    var p = S.profile || {};
    v.appendChild(h('h1', { text: first ? 'Set up your profile' : 'Profile' }));
    if (first) v.appendChild(h('p', { class: 'note', style: 'margin-top:-8px', text: 'Your weight is needed to estimate calories. Everything stays on this phone.' }));
    function field(label, id, type, val, extra) { var a = { id: id, type: type, value: val === undefined ? '' : val }; for (var k in extra || {}) a[k] = extra[k]; return h('div', {}, [h('label', { for: id, text: label }), h('input', a)]); }
    var sex = h('select', { id: 'fsex' }, [h('option', { value: 'male', text: 'Male' }), h('option', { value: 'female', text: 'Female' })]); sex.value = p.sex || 'male';
    var voice = h('input', { type: 'checkbox', id: 'fvoice' }); voice.checked = p.voice !== false;
    var ap = h('input', { type: 'checkbox', id: 'fap' }); ap.checked = p.autoPause !== false;
    var err = h('p', { class: 'note', style: 'color:var(--bad)', id: 'ferr' });
    v.appendChild(h('div', { class: 'card' }, [
      field('Name', 'fname', 'text', p.name, { maxlength: 30, autocomplete: 'given-name' }),
      h('div', { class: 'row' }, [field('Weight (kg)', 'fw', 'number', p.weightKg, { inputmode: 'decimal', min: 30, max: 200 }), field('Height (cm)', 'fh', 'number', p.heightCm, { inputmode: 'numeric', min: 120, max: 220 })]),
      h('div', { class: 'row' }, [h('div', {}, [h('label', { for: 'fsex', text: 'Sex' }), sex]), field('Birth year', 'fy', 'number', p.birthYear, { inputmode: 'numeric', min: 1930, max: 2015 })]),
      h('div', { class: 'tog', style: 'margin-top:8px' }, [h('label', { for: 'fvoice', style: 'margin:0;font-size:15px;color:var(--ink)', text: 'Voice update every km' }), voice]),
      h('div', { class: 'tog' }, [h('label', { for: 'fap', style: 'margin:0;font-size:15px;color:var(--ink)', text: 'Auto-pause when I stop' }), ap]),
      err,
      h('button', { class: 'btn dark', text: first ? 'Save and continue' : 'Save', onclick: function () {
        var w = parseFloat($('fw').value);
        if (!(w >= 30 && w <= 200)) { err.textContent = 'Enter your weight in kg, between 30 and 200.'; return; }
        S.profile = { name: $('fname').value.trim(), weightKg: w, heightCm: parseFloat($('fh').value) || null, sex: $('fsex').value, birthYear: parseInt($('fy').value, 10) || null, voice: $('fvoice').checked, autoPause: $('fap').checked };
        lsSet('pr_profile', S.profile); if (first) S.tab = 'run'; render();
        if (!first) sheet('Saved', 'Your profile is updated.', [['OK']]);
      } })
    ]));
    if (first) return;
    v.appendChild(h('h2', { text: 'Watch' }));
    v.appendChild(h('div', { class: 'card' }, [h('p', { style: 'font-size:14px', text: 'A browser cannot read a smartwatch. Watch connection (heart rate through Android Health Connect) arrives with the Android app.' })]));
    v.appendChild(h('h2', { text: 'Your data' }));
    v.appendChild(h('button', { class: 'btn danger', text: 'Delete my profile and all runs', onclick: function () {
      sheet('Delete everything?', 'Your profile and ' + S.runs.length + ' saved runs will be removed from this phone. This cannot be undone.', [
        ['Delete everything', function () { DB.clear().then(function () { lsDel('pr_profile'); lsDel('pr_live'); S.profile = null; S.runs = []; S.tab = 'run'; render(); }); }, 'danger'], ['Cancel']]);
    } }));
  }

  /* ---------- start-up ---------- */
  document.querySelectorAll('nav button').forEach(function (b) { b.addEventListener('click', function () { S.tab = b.dataset.tab; S.detail = null; render(); }); });
  $('bpause').addEventListener('click', function () { if (!S.tr) return; if (S.tr.state === 'paused') S.tr.resume(); else S.tr.pause(); liveTick(); });
  $('bfinish').addEventListener('click', askFinish);
  $('ver').textContent = VERSION;
  DB.open().then(function () {
    var left = lsGet('pr_live', null);   // a run that was cut off by the app closing: keep what was recorded
    if (left && left.distM >= 20 && left.pts && left.pts.length) { left.endedAt = left.pts[left.pts.length - 1][2]; left.recovered = true; lsDel('pr_live'); return DB.put(left); }
    lsDel('pr_live');
  }).then(loadRuns).then(function () {
    render();
    if (navigator.permissions && navigator.permissions.query) navigator.permissions.query({ name: 'geolocation' }).then(function (r) { if (r.state === 'granted') { startGPS(); if (S.tab === 'run') render(); } }).catch(function () { });
  });
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(function () { });
  window.__PRS = S;   // for automated tests
})();
