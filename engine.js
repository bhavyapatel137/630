/* Project Run engine: GPS filtering, distance, pace, splits, calories, stats.
   Pure logic, no screen code, so the same file is reused by the Android app. */
(function (root) {
  'use strict';
  var R = 6371000, RAD = Math.PI / 180;
  var CFG = {
    maxAccuracyM: 25,      // ignore fixes worse than this
    maxSpeedMps: 8,        // ignore jumps faster than this (28.8 km/h)
    minStepM: 1.5,         // ignore jitter smaller than this
    autoPauseKmh: 1,       // below this speed ...
    autoPauseSec: 10,      // ... for this long = auto-pause
    paceWindowSec: 30,     // rolling window for "current pace"
    runThresholdMpm: 134   // ACSM: running at or above about 8 km/h
  };

  function hav(a, b) {
    var dl = (b.lat - a.lat) * RAD, dn = (b.lon - a.lon) * RAD;
    var h = Math.sin(dl / 2) * Math.sin(dl / 2) +
      Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dn / 2) * Math.sin(dn / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  /* Kalman filter that tracks position and speed (constant-velocity model), one per axis,
     in local metres. Each fix is trusted according to its reported accuracy. */
  function Axis() { this.x = 0; this.v = 0; this.p = [0, 0, 0, 0]; }
  Axis.prototype.init = function (z, r) { this.x = z; this.v = 0; this.p = [r, 0, 0, 25]; };
  Axis.prototype.step = function (z, r, dt, qa) {
    var p = this.p, q = qa * qa, dt2 = dt * dt;
    this.x += this.v * dt;
    var p00 = p[0] + dt * (p[1] + p[2]) + dt2 * p[3] + q * dt2 * dt2 / 4,
      p01 = p[1] + dt * p[3] + q * dt2 * dt / 2, p10 = p[2] + dt * p[3] + q * dt2 * dt / 2, p11 = p[3] + q * dt2;
    var s = p00 + r, k0 = p00 / s, k1 = p10 / s, y = z - this.x;
    this.x += k0 * y; this.v += k1 * y;
    this.p = [(1 - k0) * p00, (1 - k0) * p01, p10 - k1 * p00, p11 - k1 * p01];
  };
  function Kalman(qa) { this.qa = qa || 0.6; this.on = false; this.ax = new Axis(); this.ay = new Axis(); }
  Kalman.prototype.step = function (lat, lon, acc, tMs) {
    if (acc < 3) acc = 3;
    var r = acc * acc;
    if (!this.on) {
      this.on = true; this.lat0 = lat; this.lon0 = lon; this.t = tMs;
      this.mx = 111320 * Math.cos(lat * RAD); this.my = 110540;
      this.ax.init(0, r); this.ay.init(0, r);
    } else {
      var dt = Math.min(30, Math.max(0.001, (tMs - this.t) / 1000)); this.t = tMs;
      this.ax.step((lon - this.lon0) * this.mx, r, dt, this.qa);
      this.ay.step((lat - this.lat0) * this.my, r, dt, this.qa);
    }
    return { lat: this.lat0 + this.ay.x / this.my, lon: this.lon0 + this.ax.x / this.mx,
      speed: Math.sqrt(this.ax.v * this.ax.v + this.ay.v * this.ay.v) };
  };

  /* ACSM metabolic equations. speed in m/min, grade as a decimal. Returns kcal per minute. */
  function kcalPerMin(speedMpm, weightKg, grade) {
    grade = grade || 0;
    var vo2 = speedMpm >= CFG.runThresholdMpm
      ? 0.2 * speedMpm + 0.9 * speedMpm * grade + 3.5
      : 0.1 * speedMpm + 1.8 * speedMpm * grade + 3.5;
    return vo2 * weightKg / 1000 * 5;
  }
  /* Keytel et al. 2005, for when a watch supplies heart rate (used by the Android app). */
  function kcalPerMinHR(hr, weightKg, age, sex) {
    var v = sex === 'female'
      ? (-20.4022 + 0.4472 * hr - 0.1263 * weightKg + 0.074 * age) / 4.184
      : (-55.0969 + 0.6309 * hr + 0.1988 * weightKg + 0.2017 * age) / 4.184;
    return Math.max(0, v);
  }

  function Tracker(opts) {
    opts = opts || {};
    this.weightKg = opts.weightKg || 70;
    this.autoPause = opts.autoPause !== false;
    this.k = new Kalman();
    this.pts = [];            // accepted, smoothed points: {lat, lon, t, seg}
    this.distM = 0; this.movingMs = 0; this.kcal = 0;
    this.splits = [];         // {km, ms} time taken for each full km
    this.lastSplitMs = 0;
    this.win = [];            // recent {t, d} for rolling pace
    this.state = 'idle';      // idle | running | paused | autopaused | done
    this.last = null; this.seg = 0; this.recent = [];
    this.slowSince = null;
    this.discarded = { accuracy: 0, jump: 0 };
    this.startedAt = null; this.endedAt = null;
    this.elevGain = 0; this.lastAlt = null;
  }
  Tracker.prototype.start = function (tMs) { this.state = 'running'; this.startedAt = tMs; };
  Tracker.prototype.pause = function () {
    if (this.state === 'running' || this.state === 'autopaused') { this.state = 'paused'; this._break(); }
  };
  Tracker.prototype.resume = function () { if (this.state === 'paused') { this.state = 'running'; this.slowSince = null; } };
  Tracker.prototype.finish = function (tMs) { this.state = 'done'; this.endedAt = tMs; };
  Tracker.prototype._break = function () { this.last = null; this.seg++; this.k = new Kalman(); this.win = []; this.recent = []; };

  /* Feed one GPS fix: {lat, lon, acc (m), t (ms), alt, altAcc}. Returns what happened to it. */
  Tracker.prototype.add = function (fix) {
    if (this.state !== 'running' && this.state !== 'autopaused') return 'ignored';
    if (!(fix.acc <= CFG.maxAccuracyM)) { this.discarded.accuracy++; return 'accuracy'; }
    if (this.last) {
      var rawDt = (fix.t - this.last.rawT) / 1000;
      if (rawDt <= 0) return 'ignored';
      var rawD = hav({ lat: this.last.rawLat, lon: this.last.rawLon }, fix);
      // allow for the stated uncertainty of both fixes, so ordinary GPS wobble is not mistaken for a jump
      if (Math.max(0, rawD - fix.acc - this.last.rawAcc) / rawDt > CFG.maxSpeedMps) { this.discarded.jump++; return 'jump'; }
    }
    var s = this.k.step(fix.lat, fix.lon, fix.acc, fix.t);
    var p = { lat: s.lat, lon: s.lon, t: fix.t, seg: this.seg };
    if (!this.last) {
      this.last = { lat: p.lat, lon: p.lon, t: p.t, rawLat: fix.lat, rawLon: fix.lon, rawT: fix.t, rawAcc: fix.acc };
      this.pts.push(p); return 'first';
    }
    this.recent.push(p);
    while (this.recent.length > 2 && fix.t - this.recent[0].t > 10000) this.recent.shift();
    // speed for auto-pause: the phone's own reading when it gives one, else movement over the last 10 s
    var sp = (typeof fix.speed === 'number' && fix.speed >= 0) ? fix.speed : null;
    var limit = CFG.autoPauseKmh;
    if (sp === null) {     // no speed from the phone: use net movement over the last 10 s, with a little more tolerance
      var r0 = this.recent[0], rt = (fix.t - r0.t) / 1000;
      if (rt >= 8) { sp = hav(r0, p) / rt; limit = CFG.autoPauseKmh * (this.state === 'autopaused' ? 2.5 : 1.5); }
    }
    this.last.rawLat = fix.lat; this.last.rawLon = fix.lon; this.last.rawT = fix.t; this.last.rawAcc = fix.acc;
    if (this.autoPause && sp !== null) {
      if (sp * 3.6 < limit) {
        if (this.slowSince === null) this.slowSince = fix.t;
        if (this.state === 'running' && fix.t - this.slowSince >= CFG.autoPauseSec * 1000) { this.state = 'autopaused'; this.win = []; }
      } else {
        this.slowSince = null;
        if (this.state === 'autopaused') {   // moving again: restart measuring from here
          this.state = 'running'; this.seg++; p.seg = this.seg;
          this.last.lat = p.lat; this.last.lon = p.lon; this.last.t = p.t;
          this.pts.push(p); return 'resumed';
        }
      }
    }
    if (this.state === 'autopaused') return 'autopaused';
    var dt = (fix.t - this.last.t) / 1000;
    var d = hav(this.last, p);
    var speed = dt > 0 ? d / dt : 0;
    if (d < CFG.minStepM) {   // jitter: count the time, keep waiting for real movement
      return 'still';
    }
    this.distM += d; this.movingMs += dt * 1000;
    this.kcal += kcalPerMin(speed * 60, this.weightKg, 0) * (dt / 60);
    if (typeof fix.alt === 'number' && fix.altAcc && fix.altAcc <= 10) {
      if (this.lastAlt !== null && fix.alt - this.lastAlt > 1) { this.elevGain += fix.alt - this.lastAlt; this.lastAlt = fix.alt; }
      else if (this.lastAlt === null || fix.alt < this.lastAlt) this.lastAlt = fix.alt;
    }
    while (this.distM >= (this.splits.length + 1) * 1000) {
      this.splits.push({ km: this.splits.length + 1, ms: this.movingMs - this.lastSplitMs });
      this.lastSplitMs = this.movingMs;
    }
    this.win.push({ t: fix.t, d: this.distM });
    while (this.win.length > 2 && fix.t - this.win[0].t > CFG.paceWindowSec * 1000) this.win.shift();
    this.last.lat = p.lat; this.last.lon = p.lon; this.last.t = p.t;
    this.pts.push(p);
    return 'ok';
  };
  /* Seconds per km over the last 30 seconds, or null when not moving. */
  Tracker.prototype.currentPace = function () {
    if (this.state !== 'running' || this.win.length < 2) return null;
    var a = this.win[0], b = this.win[this.win.length - 1];
    var d = b.d - a.d, t = (b.t - a.t) / 1000;
    return d > 5 ? t / (d / 1000) : null;
  };
  Tracker.prototype.avgPace = function () { return this.distM > 10 ? (this.movingMs / 1000) / (this.distM / 1000) : null; };
  Tracker.prototype.toRun = function () {
    return {
      id: 'r' + this.startedAt, startedAt: this.startedAt, endedAt: this.endedAt,
      distM: Math.round(this.distM * 10) / 10, movingMs: Math.round(this.movingMs),
      kcal: Math.round(this.kcal), calMethod: 'ACSM (pace and weight)',
      elevGain: Math.round(this.elevGain), splits: this.splits.slice(),
      discarded: this.discarded, weightKg: this.weightKg,
      pts: this.pts.map(function (p) { return [+p.lat.toFixed(6), +p.lon.toFixed(6), p.t, p.seg]; })
    };
  };

  /* Fastest time (ms) to cover targetM anywhere inside a run, from its saved points. */
  function bestEffort(run, targetM) {
    var p = run.pts; if (!p || p.length < 2 || run.distM < targetM) return null;
    var cd = [0], ct = [0], i;
    for (i = 1; i < p.length; i++) {
      var same = p[i][3] === p[i - 1][3];
      cd.push(cd[i - 1] + (same ? hav({ lat: p[i - 1][0], lon: p[i - 1][1] }, { lat: p[i][0], lon: p[i][1] }) : 0));
      ct.push(ct[i - 1] + (same ? p[i][2] - p[i - 1][2] : 0));
    }
    var best = null, j = 0;
    for (i = 1; i < p.length; i++) {
      while (cd[i] - cd[j + 1] >= targetM) j++;
      if (cd[i] - cd[j] >= targetM) { var t = ct[i] - ct[j]; if (best === null || t < best) best = t; }
    }
    return best;
  }

  function dayKey(ms) { var d = new Date(ms); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function weekStart(ms) { var d = new Date(ms); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); }

  /* Totals, streaks, personal bests and the last 8 weeks, from the list of saved runs. */
  function stats(runs, nowMs) {
    var now = nowMs || Date.now(), ws = weekStart(now), d0 = new Date(now), ms0 = new Date(d0.getFullYear(), d0.getMonth(), 1).getTime();
    function tot(from) {
      var o = { runs: 0, distM: 0, movingMs: 0, kcal: 0 };
      runs.forEach(function (r) { if (r.startedAt >= from) { o.runs++; o.distM += r.distM; o.movingMs += r.movingMs; o.kcal += r.kcal; } });
      return o;
    }
    var days = {}; runs.forEach(function (r) { days[dayKey(r.startedAt)] = 1; });
    var keys = Object.keys(days).sort(), longest = 0, cur = 0, prev = null;
    keys.forEach(function (k) {
      var t = new Date(k + 'T00:00:00').getTime();
      cur = (prev !== null && Math.round((t - prev) / 864e5) === 1) ? cur + 1 : 1;
      if (cur > longest) longest = cur; prev = t;
    });
    var streak = 0, t0 = new Date(now); t0.setHours(0, 0, 0, 0);
    var c = t0.getTime(); if (!days[dayKey(c)]) c -= 864e5;      // today not run yet does not break the streak
    while (days[dayKey(c)]) { streak++; var n = new Date(c); n.setDate(n.getDate() - 1); c = n.getTime(); }
    var pb = { k1: null, k5: null, k10: null, longestM: 0 };
    runs.forEach(function (r) {
      if (r.distM > pb.longestM) pb.longestM = r.distM;
      [['k1', 1000], ['k5', 5000], ['k10', 10000]].forEach(function (x) {
        var b = bestEffort(r, x[1]); if (b !== null && (pb[x[0]] === null || b < pb[x[0]])) pb[x[0]] = b;
      });
    });
    var weeks = [];
    for (var i = 7; i >= 0; i--) {
      var a = new Date(ws); a.setDate(a.getDate() - 7 * i); var b = new Date(a); b.setDate(b.getDate() + 7);
      var o = { start: a.getTime(), distM: 0, movingMs: 0 };
      runs.forEach(function (r) { if (r.startedAt >= a.getTime() && r.startedAt < b.getTime()) { o.distM += r.distM; o.movingMs += r.movingMs; } });
      weeks.push(o);
    }
    return { week: tot(ws), month: tot(ms0), all: tot(0), streak: streak, longestStreak: longest, pb: pb, weeks: weeks };
  }

  function fmtPace(secPerKm) {
    if (secPerKm === null || !isFinite(secPerKm) || secPerKm > 3599) return '--:--';
    var s = Math.round(secPerKm); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }
  function fmtTime(ms) {
    var s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return (h ? h + ':' + ('0' + m).slice(-2) : m) + ':' + ('0' + x).slice(-2);
  }

  var api = { CFG: CFG, hav: hav, Kalman: Kalman, Tracker: Tracker, kcalPerMin: kcalPerMin, kcalPerMinHR: kcalPerMinHR,
    bestEffort: bestEffort, stats: stats, fmtPace: fmtPace, fmtTime: fmtTime, dayKey: dayKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PR = api;
})(typeof self !== 'undefined' ? self : this);
