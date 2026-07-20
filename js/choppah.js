/* CHOPPAH — sample chopper / re-pitch instrument (internal engine).
   Load a sample, chop it into slices, then play it from MIDI with a split
   keyboard:
     - CONTROL zone (below the split, default C4): each key triggers one slice
       at its natural pitch — sequence these to rearrange the sample. The key
       also latches that slice as the "active" one.
     - PITCH  zone (at/above the split): plays the active slice re-pitched by
       playback rate (root note = original speed), so you pitch-shift the chop.
   Exposes the same interface as PRIZM so it drops into the sequencer's internal
   target machinery and the loop MIDI pump: out, noteOn/noteOff/allOff,
   playScheduled, renderPattern, setLoopRoute, setVolume, isOpen, handlesKey. */
(function () {
  'use strict';

  var SPLIT = 60;        // C4: notes below = control/trigger, at/above = pitch
  var CTRL_BASE = 12;    // C0 maps to slice 0 in the control zone
  var EDGE = 0.003;      // slice edge fade (s) against clicks
  var KB_LOW = 12, KB_HIGH = 84;   // on-screen keyboard span: C0..C6
  var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  function isBlack(m) { return [1, 3, 6, 8, 10].indexOf(m % 12) >= 0; }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /* Granular pitch shift of one slice into `outL/outR` (length = source length,
     so pitch changes but duration stays — tempo-locked). Two overlapping
     triangle-windowed grain streams read the source at pitchRate while the output
     position advances 1:1 — same technique as the loop-transpose worklet. */
  function granularShift(srcL, srcR, s0, s1, pitchRate, sr, outL, outR) {
    var n = s1 - s0;
    var G = Math.min(2 * Math.round(sr * 0.04), n);   // ~80 ms grain window
    if (G < 8) {                                       // slice too short: straight copy
      for (var c = 0; c < n; c++) { outL[c] = srcL[s0 + c]; outR[c] = srcR[s0 + c]; }
      return;
    }
    var half = G * 0.5;
    for (var i = 0; i < n; i++) {
      var aL = 0, aR = 0;
      for (var s = 0; s < 2; s++) {
        var ph = (i + s * half) % G;
        var rp = (i - ph) + ph * pitchRate;
        if (rp < 0) rp = 0; else if (rp > n - 1) rp = n - 1;
        var w = 1 - Math.abs(2 * ph / G - 1);
        var fl = Math.floor(rp), i0 = s0 + fl, i1 = i0 + 1;
        if (i1 > s1 - 1) i1 = s1 - 1;
        var fp = rp - fl;
        aL += (srcL[i0] * (1 - fp) + srcL[i1] * fp) * w;
        aR += (srcR[i0] * (1 - fp) + srcR[i1] * fp) * w;
      }
      outL[i] = aL; outR[i] = aR;
    }
  }

  function Choppah(engine) {
    var ctx = engine.ctx;
    this.engine = engine;
    this.buffer = null;         // decoded AudioBuffer (context-independent)
    this.sampleName = '';
    this.slices = [];           // [{ start, end }] in frames
    this.activeSlice = 0;       // latched by the last control note
    this.root = SPLIT;          // pitch-zone note that plays at rate 1.0
    this.tempoLock = false;     // pitch-shift without changing slice length
    this.gain = 1;
    this.out = ctx.createGain();
    this.out.gain.value = 0.9;
    this.out.connect(engine.masterGain);
    this.loopDelay = null;
    this.midiIn = true;
    this.voices = new Map();     // midiNote -> { src, env }
    this.schedSel = [];          // sorted [{ t, slice }] for scheduled pitch resolution
    this.panel = null;
    this.uiRoot = null;
    this.selCanvas = null;
    this.keysEl = null;
  }

  /* ---------------- slicing ---------------- */
  Choppah.prototype.hasSample = function () { return !!(this.buffer && this.slices.length); };

  Choppah.prototype.sliceEqual = function (n) {
    if (!this.buffer) return;
    n = Math.max(1, Math.min(64, Math.round(n)));
    var len = this.buffer.length, out = [];
    for (var i = 0; i < n; i++) {
      out.push({ start: Math.round(i * len / n), end: Math.round((i + 1) * len / n) });
    }
    this.slices = out;
    this.activeSlice = 0;
    this.drawSel();
    this.buildKeyboard();
  };

  /* Energy-based transient detection: slice at points where short-window RMS
     jumps well above its local trailing average. */
  Choppah.prototype.sliceTransients = function (sensitivity) {
    if (!this.buffer) return;
    var sr = this.buffer.sampleRate;
    var L = this.buffer.getChannelData(0);
    var R = this.buffer.numberOfChannels > 1 ? this.buffer.getChannelData(1) : L;
    var n = L.length;
    var win = Math.max(64, Math.round(sr * 0.01));      // 10 ms energy window
    var hop = Math.max(32, Math.round(win / 2));
    var env = [];
    for (var i = 0; i < n; i += hop) {
      var s = 0, e = Math.min(n, i + win);
      for (var j = i; j < e; j++) { var m = (L[j] + R[j]) * 0.5; s += m * m; }
      env.push(Math.sqrt(s / Math.max(1, e - i)));
    }
    var thr = (sensitivity == null ? 1.6 : sensitivity);  // ratio over trailing avg
    var minGap = Math.round(sr * 0.05 / hop);             // >=50 ms apart
    var bounds = [0], avg = env[0] || 1e-6, last = -minGap;
    for (i = 1; i < env.length; i++) {
      if (env[i] > avg * thr && env[i] > 0.02 && i - last >= minGap) {
        bounds.push(i * hop); last = i;
      }
      avg = avg * 0.85 + env[i] * 0.15;
    }
    var out = [];
    for (i = 0; i < bounds.length; i++) {
      out.push({ start: bounds[i], end: i + 1 < bounds.length ? bounds[i + 1] : n });
    }
    this.slices = out;
    this.activeSlice = 0;
    this.drawSel();
    this.buildKeyboard();
  };

  /* ---------------- loading ---------------- */
  Choppah.prototype.loadArrayBuffer = function (arrBuf, name) {
    var self = this;
    return this.engine.ctx.decodeAudioData(arrBuf).then(function (buf) {
      self.buffer = buf;
      self.sampleName = name || 'sample';
      self.sliceEqual(8);
      return buf;
    });
  };

  /* Load raw loop audio (Float32 L/R) straight in as the sample, e.g. from a
     recorded loop channel — no decode needed. */
  Choppah.prototype.loadBuffers = function (L, R, sr, name) {
    var buf = this.engine.ctx.createBuffer(2, L.length, sr || this.engine.ctx.sampleRate);
    buf.getChannelData(0).set(L);
    buf.getChannelData(1).set(R && R.length === L.length ? R : L);
    this.buffer = buf;
    this.sampleName = name || 'loop';
    this.sliceEqual(8);
    if (this.uiRoot) {
      var nm = this.uiRoot.querySelector('.chop-name');
      if (nm) nm.textContent = this.sampleName + ' · ' + buf.duration.toFixed(2) + 's';
    }
    this.drawSel();
    this.buildKeyboard();
    return buf;
  };

  /* ---------------- interface parity ---------------- */
  Choppah.prototype.isOpen = function () {
    return !!(this.panel && !this.panel.classList.contains('hidden'));
  };
  Choppah.prototype.handlesKey = function () { return false; };
  Choppah.prototype.setVolume = function (v) {
    this.out.gain.setTargetAtTime(v, this.engine.ctx.currentTime, 0.01);
  };

  /* Route the engine into the loop input bus (latency-compensated), like PRIZM. */
  Choppah.prototype.setLoopRoute = function (on) {
    var eng = this.engine;
    if (on && !this.loopDelay) {
      this.loopDelay = eng.ctx.createDelay(1);
      this.loopDelay.delayTime.value = eng.compFrames / eng.ctx.sampleRate;
      this._routeSrc = this.routeTap || this.out;
      this._routeSrc.connect(this.loopDelay);
      this.loopDelay.connect(eng.inputNode);
    } else if (!on && this.loopDelay) {
      this._routeSrc.disconnect(this.loopDelay);
      this.loopDelay.disconnect();
      this.loopDelay = null;
    }
  };

  /* Resolve a MIDI note to { slice, rate }. Control notes pick + play a slice at
     natural pitch; pitch notes play `active` re-pitched. */
  Choppah.prototype.resolve = function (midiNote, active) {
    if (midiNote < SPLIT) {
      var idx = clamp(midiNote - CTRL_BASE, 0, this.slices.length - 1);
      return { slice: idx, rate: 1, control: true };
    }
    return { slice: active, rate: Math.pow(2, (midiNote - this.root) / 12), control: false };
  };

  /* Pitch-shift a slice into a fresh AudioBuffer on `ctx`, keeping its length
     (tempo-locked). Uses the audiojs pitch-shift phase vocoder when available and
     the slice is long enough; falls back to the inline granular shifter otherwise
     (short slices can't be phase-vocoded). */
  Choppah.prototype.shiftedSliceBuffer = function (ctx, sl, pitchRate) {
    var buf = this.buffer, sr = buf.sampleRate;
    var srcL = buf.getChannelData(0);
    var srcR = buf.numberOfChannels > 1 ? buf.getChannelData(1) : srcL;
    var n = sl.end - sl.start;
    var outBuf = ctx.createBuffer(2, n, sr);
    var PS = (typeof window !== 'undefined') && window.PitchShift;
    if (PS && n >= PS.minLen) {
      var segL = srcL.subarray(sl.start, sl.end);
      var segR = srcR === srcL ? segL : srcR.subarray(sl.start, sl.end);
      var res = PS.shiftRatio(segL, segR, pitchRate, sr);
      outBuf.getChannelData(0).set(res.L);
      outBuf.getChannelData(1).set(res.R);
    } else {
      granularShift(srcL, srcR, sl.start, sl.end, pitchRate, sr, outBuf.getChannelData(0), outBuf.getChannelData(1));
    }
    return outBuf;
  };

  /* Build one slice voice into `dest` on `ctx`; returns { src, env, endT }. */
  Choppah.prototype.spawn = function (ctx, dest, sliceIdx, rate, whenT, gateOffT, vel) {
    var sl = this.slices[sliceIdx];
    if (!sl || !this.buffer) return null;
    var sr = this.buffer.sampleRate;
    var src = ctx.createBufferSource();
    var offset, playLen, outDur;
    if (this.tempoLock && Math.abs(rate - 1) > 1e-4) {
      // tempo-locked: play the pitch-shifted slice at rate 1 for its natural length
      src.buffer = this.shiftedSliceBuffer(ctx, sl, rate);
      src.playbackRate.value = 1;
      offset = 0;
      playLen = src.buffer.length / sr;
      outDur = playLen;
    } else {
      // classic sampler: re-pitch by playback rate (length scales with pitch)
      src.buffer = this.buffer;
      src.playbackRate.value = rate;
      offset = sl.start / sr;
      playLen = (sl.end - sl.start) / sr;
      outDur = playLen / rate;
    }
    var env = ctx.createGain();
    src.connect(env); env.connect(dest);
    var peak = 0.2 + 0.8 * (vel == null ? 0.8 : vel);
    // gate: play the whole slice unless a note-off cuts it short
    var endT = whenT + outDur;
    if (gateOffT != null && gateOffT < endT) endT = Math.max(whenT + 0.01, gateOffT);
    var rel = Math.min(0.02, Math.max(0.004, outDur * 0.1));
    env.gain.setValueAtTime(0, whenT);
    env.gain.linearRampToValueAtTime(peak, whenT + EDGE);
    env.gain.setValueAtTime(peak, Math.max(whenT + EDGE, endT - rel));
    env.gain.linearRampToValueAtTime(0, endT);
    try { src.start(whenT, offset, playLen); } catch (e) { return null; }
    try { src.stop(endT + 0.03); } catch (e) {}
    return { src: src, env: env, endT: endT };
  };

  /* ---------------- live playing ---------------- */
  Choppah.prototype.noteOn = function (midiNote, vel) {
    if (!this.hasSample()) return;
    var ctx = this.engine.ctx, t = ctx.currentTime + 0.005;
    var r = this.resolve(midiNote, this.activeSlice);
    if (r.control) { this.activeSlice = r.slice; this.drawSel(); this.refreshKeyState(); }
    if (this.voices.has(midiNote)) this.killVoice(midiNote);
    var v = this.spawn(ctx, this.out, r.slice, r.rate, t, null, vel);
    if (v) {
      this.voices.set(midiNote, v);
      var self = this;
      v.src.onended = function () {           // free + unpaint when the slice finishes
        if (self.voices.get(midiNote) === v) self.voices.delete(midiNote);
        self.paintKey(midiNote, false);
      };
    }
    this.paintKey(midiNote, true);
  };

  Choppah.prototype.noteOff = function (midiNote) {
    // control-zone triggers are one-shots — they ring out the whole slice
    if (midiNote < SPLIT) return;
    var v = this.voices.get(midiNote);
    if (!v) return;
    this.voices.delete(midiNote);
    var ctx = this.engine.ctx, t = ctx.currentTime;
    try {
      v.env.gain.cancelScheduledValues(t);
      v.env.gain.setValueAtTime(v.env.gain.value, t);
      v.env.gain.linearRampToValueAtTime(0, t + 0.02);
      v.src.stop(t + 0.05);
    } catch (e) {}
    this.paintKey(midiNote, false);
  };

  Choppah.prototype.killVoice = function (midiNote) {
    var v = this.voices.get(midiNote);
    if (!v) return;
    this.voices.delete(midiNote);
    try { v.src.stop(); } catch (e) {}
    this.paintKey(midiNote, false);
  };

  Choppah.prototype.allOff = function () {
    var self = this;
    Array.from(this.voices.keys()).forEach(function (k) { self.killVoice(k); });
  };

  /* Fire-and-forget scheduled note for sequenced/looped playback. Control notes
     latch their slice on a time-sorted timeline so later pitch notes resolve to
     the right slice regardless of scheduling order. */
  Choppah.prototype.playScheduled = function (midiNote, vel, onT, offT) {
    if (!this.hasSample()) return;
    var ctx = this.engine.ctx;
    if (midiNote < SPLIT) {
      var idx = clamp(midiNote - CTRL_BASE, 0, this.slices.length - 1);
      this.pushSel(onT, idx);
      this.activeSlice = idx;
      this.spawn(ctx, this.out, idx, 1, onT, offT, vel);
    } else {
      this.spawn(ctx, this.out, this.selAt(onT), Math.pow(2, (midiNote - this.root) / 12), onT, offT, vel);
    }
  };

  Choppah.prototype.pushSel = function (t, slice) {
    var s = this.schedSel, i = s.length;
    while (i > 0 && s[i - 1].t > t) i--;
    s.splice(i, 0, { t: t, slice: slice });
    var cut = this.engine.ctx.currentTime - 1;             // prune stale entries
    while (s.length && s[0].t < cut) s.shift();
  };
  Choppah.prototype.selAt = function (t) {
    var s = this.schedSel, sel = this.activeSlice;
    for (var i = 0; i < s.length; i++) { if (s[i].t <= t + 1e-4) sel = s[i].slice; else break; }
    return sel;
  };

  /* Render a pattern offline: notes = [{ pitch, vel(0..1), onT, offT }] seconds
     from loop start; lenSec = loop length. Control/pitch resolved in time order;
     slice tails past the end fold onto the loop start. Resolves { L, R }. */
  Choppah.prototype.renderPattern = function (notes, lenSec) {
    if (!this.hasSample()) {
      var z = new Float32Array(Math.max(1, Math.round(lenSec * this.engine.ctx.sampleRate)));
      return Promise.resolve({ L: z, R: new Float32Array(z.length) });
    }
    var sr = this.engine.ctx.sampleRate;
    var lenFrames = Math.round(lenSec * sr);
    var self = this;
    var ordered = notes.slice().sort(function (a, b) { return a.onT - b.onT; });
    // resolve each note to { slice, rate } walking control latches in time order
    var active = 0, plan = [], maxEnd = lenSec;
    ordered.forEach(function (n) {
      var r = self.resolve(n.pitch, active);
      if (r.control) active = r.slice;
      var sl = self.slices[r.slice];
      if (!sl) return;
      var natural = (sl.end - sl.start) / sr;
      // tempo-lock keeps natural length; classic sampler scales length by 1/rate
      var outDur = (self.tempoLock && Math.abs(r.rate - 1) > 1e-4) ? natural : natural / r.rate;
      var endT = n.offT != null && n.offT < n.onT + outDur ? Math.max(n.onT + 0.01, n.offT) : n.onT + outDur;
      if (endT > maxEnd) maxEnd = endT;
      plan.push({ slice: r.slice, rate: r.rate, onT: n.onT, offT: n.offT, vel: n.vel });
    });
    var oc = new OfflineAudioContext(2, Math.ceil(maxEnd * sr) + 64, sr);
    var out = oc.createGain();
    out.gain.value = this.out.gain.value;
    out.connect(oc.destination);
    plan.forEach(function (p) {
      self.spawn(oc, out, p.slice, p.rate, p.onT, p.offT, p.vel);
    });
    return oc.startRendering().then(function (buf) {
      var sL = buf.getChannelData(0), sR = buf.numberOfChannels > 1 ? buf.getChannelData(1) : sL;
      var L = new Float32Array(lenFrames), R = new Float32Array(lenFrames);
      L.set(sL.subarray(0, lenFrames));
      R.set(sR.subarray(0, lenFrames));
      for (var i = lenFrames; i < sL.length; i++) {
        var w = i % lenFrames;
        L[w] += sL[i]; R[w] += sR[i];
      }
      return { L: L, R: R };
    });
  };

  /* ---------------- UI ---------------- */
  Choppah.prototype.buildUI = function (panelSection, uiRoot) {
    this.panel = panelSection;
    this.uiRoot = uiRoot;
    var self = this;
    uiRoot.innerHTML =
      '<div class="chop-row">' +
        '<button class="chop-load">LOAD SAMPLE</button>' +
        '<input type="file" class="chop-file" accept="audio/*" style="display:none">' +
        '<span class="chop-name">no sample</span>' +
        '<label class="seq-l">Slices <select class="chop-count">' +
          '<option value="1">1 (whole)</option><option>2</option><option>4</option><option selected>8</option>' +
          '<option>16</option><option>24</option><option>32</option></select></label>' +
        '<button class="chop-detect" title="Slice at detected transients">DETECT</button>' +
        '<label class="seq-l">Root <select class="chop-root"></select></label>' +
        '<label class="chk chop-lock" title="Pitch-shift the slice without changing its length (granular time-stretch)"><input type="checkbox" class="chop-lock-in"> tempo-lock pitch</label>' +
      '</div>' +
      '<canvas class="chop-canvas" height="150"></canvas>' +
      '<div class="chop-kbd">' +
        '<div class="chop-kbd-top">' +
          '<span class="chop-zone-ctrl">CONTROL — trigger slices</span>' +
          '<span class="chop-zone-pitch">C4+ PITCH — re-pitch active slice</span>' +
        '</div>' +
        '<div class="chop-keys"></div>' +
      '</div>' +
      '<div class="chop-hint">below C4 = trigger slices (rearrange, one-shot) · C4 and up = re-pitch the last-triggered slice · tempo-lock keeps slice length · click a slice to audition</div>';

    var rootSel = uiRoot.querySelector('.chop-root');
    var names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    for (var m = 48; m <= 72; m++) {
      var o = document.createElement('option');
      o.value = m; o.textContent = names[m % 12] + (Math.floor(m / 12) - 1);
      if (m === SPLIT) o.selected = true;
      rootSel.appendChild(o);
    }
    rootSel.addEventListener('change', function () { self.root = parseInt(this.value, 10); });
    uiRoot.querySelector('.chop-lock-in').addEventListener('change', function () { self.tempoLock = this.checked; });

    var file = uiRoot.querySelector('.chop-file');
    uiRoot.querySelector('.chop-load').addEventListener('click', function () { file.click(); });
    file.addEventListener('change', function () {
      var f = this.files && this.files[0];
      if (!f) return;
      var name = f.name;
      f.arrayBuffer().then(function (ab) { return self.loadArrayBuffer(ab, name); }).then(function () {
        uiRoot.querySelector('.chop-name').textContent =
          self.sampleName + ' · ' + self.buffer.duration.toFixed(2) + 's';
        self.drawSel();
      }).catch(function (err) {
        uiRoot.querySelector('.chop-name').textContent = 'load failed: ' + (err.message || err);
      });
      this.value = '';
    });
    uiRoot.querySelector('.chop-count').addEventListener('change', function () {
      self.sliceEqual(parseInt(this.value, 10));
    });
    uiRoot.querySelector('.chop-detect').addEventListener('click', function () {
      self.sliceTransients();
    });

    this.selCanvas = uiRoot.querySelector('.chop-canvas');
    var cv = this.selCanvas;
    cv.addEventListener('mousedown', function (e) {
      if (!self.hasSample()) return;
      var rect = cv.getBoundingClientRect();
      var frac = (e.clientX - rect.left) / rect.width;
      var idx = clamp(Math.floor(frac * self.slices.length), 0, self.slices.length - 1);
      self.activeSlice = idx;
      var ctx = self.engine.ctx, t = ctx.currentTime + 0.005;
      self.spawn(ctx, self.out, idx, 1, t, null, 0.9);
      self.drawSel();
      self.refreshKeyState();
    });

    // split keyboard: click/drag to play; control keys trigger slices, pitch keys re-pitch
    this.keysEl = uiRoot.querySelector('.chop-keys');
    this.buildKeyboard();
    var pointerNote = null;
    function press(note) {
      if (pointerNote === note) return;
      if (pointerNote !== null) self.noteOff(pointerNote);
      self.noteOn(note, 0.85);
      pointerNote = note;
    }
    this.keysEl.addEventListener('pointerdown', function (e) {
      var k = e.target.closest('.chop-key');
      if (!k || k.classList.contains('off')) return;
      e.preventDefault();
      press(+k.dataset.note);
    });
    this.keysEl.addEventListener('pointerover', function (e) {
      if (pointerNote === null) return;
      var k = e.target.closest('.chop-key');
      if (!k || k.classList.contains('off')) return;
      press(+k.dataset.note);
    });
    window.addEventListener('pointerup', function () {
      if (pointerNote !== null) { self.noteOff(pointerNote); pointerNote = null; }
    });

    setTimeout(function () { self.drawSel(); }, 0);
  };

  Choppah.prototype.drawSel = function () {
    var cv = this.selCanvas;
    if (!cv) return;
    if (!cv.width) cv.width = cv.clientWidth || 900;
    var g = cv.getContext('2d'), W = cv.width, H = cv.height, mid = H / 2;
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#14161a'; g.fillRect(0, 0, W, H);
    if (!this.buffer) {
      g.fillStyle = '#5b6270'; g.font = '12px sans-serif';
      g.fillText('load a sample to chop', 10, mid);
      return;
    }
    var L = this.buffer.getChannelData(0);
    var R = this.buffer.numberOfChannels > 1 ? this.buffer.getChannelData(1) : L;
    var n = L.length;
    g.strokeStyle = '#2f3947'; g.beginPath();
    for (var px = 0; px < W; px++) {
      var a0 = Math.floor(px / W * n), a1 = Math.floor((px + 1) / W * n);
      var lo = 1, hi = -1;
      for (var i = a0; i < a1; i++) {
        var v0 = Math.min(L[i], R[i]), v1 = Math.max(L[i], R[i]);
        if (v0 < lo) lo = v0; if (v1 > hi) hi = v1;
      }
      if (lo > hi) { lo = 0; hi = 0; }
      g.moveTo(px + 0.5, mid - hi * (mid - 6));
      g.lineTo(px + 0.5, mid - lo * (mid - 6) + 0.5);
    }
    g.stroke();
    for (var s = 0; s < this.slices.length; s++) {
      var x0 = this.slices[s].start / n * W;
      var active = s === this.activeSlice;
      g.fillStyle = active ? 'rgba(255,162,41,0.16)' : 'rgba(77,163,255,0.05)';
      var x1 = (s + 1 < this.slices.length ? this.slices[s + 1].start / n * W : W);
      g.fillRect(x0, 0, x1 - x0, H);
      g.strokeStyle = active ? '#ffa229' : 'rgba(216,220,230,0.3)';
      g.beginPath(); g.moveTo(x0 + 0.5, 0); g.lineTo(x0 + 0.5, H); g.stroke();
      g.fillStyle = active ? '#ffa229' : '#8b93a5';
      g.font = '9px sans-serif';
      g.fillText(String(s + 1), x0 + 3, 10);
    }
  };

  /* Split keyboard: control keys (below C4) are labelled with the slice they
     trigger (C0 up = slice 1, 2, 3 …); pitch keys (C4+) show octave C labels.
     Control keys past the slice count are dimmed and unplayable. */
  Choppah.prototype.buildKeyboard = function () {
    var el = this.keysEl;
    if (!el) return;
    el.innerHTML = '';
    var self = this, whites = [], m;
    for (m = KB_LOW; m <= KB_HIGH; m++) if (!isBlack(m)) whites.push(m);
    var wCount = whites.length, ww = 100 / wCount;
    function ctrlLabel(note) {
      var idx = note - CTRL_BASE;
      return idx < self.slices.length ? String(idx + 1) : null;   // null = no slice
    }
    whites.forEach(function (note) {
      var k = document.createElement('div');
      var ctrl = note < SPLIT;
      k.className = 'chop-key ' + (ctrl ? 'ctrl' : 'pitch');
      k.dataset.note = note;
      var lab = '';
      if (ctrl) { var c = ctrlLabel(note); if (c === null) k.className += ' off'; else lab = c; }
      else if (note % 12 === 0) lab = NOTE_NAMES[note % 12] + (Math.floor(note / 12) - 1);
      if (lab) k.innerHTML = '<span class="kc">' + lab + '</span>';
      el.appendChild(k);
    });
    var wi = 0;
    for (m = KB_LOW; m <= KB_HIGH; m++) {
      if (isBlack(m)) {
        var b = document.createElement('div');
        var ctrl2 = m < SPLIT;
        b.className = 'chop-key black ' + (ctrl2 ? 'ctrl' : 'pitch');
        b.dataset.note = m;
        if (ctrl2) { var cl = ctrlLabel(m); if (cl === null) b.className += ' off'; else b.innerHTML = '<span class="kc">' + cl + '</span>'; }
        b.style.width = (ww * 0.62) + '%';
        b.style.left = (wi * ww - ww * 0.31) + '%';
        el.appendChild(b);
      } else wi++;
    }
    this.refreshKeyState();
  };

  Choppah.prototype.paintKey = function (note, on) {
    if (!this.keysEl) return;
    var el = this.keysEl.querySelector('[data-note="' + note + '"]');
    if (el) el.classList.toggle('held', on);
  };

  /* Mark the control key of the currently-active slice. */
  Choppah.prototype.refreshKeyState = function () {
    if (!this.keysEl) return;
    var act = this.keysEl.querySelectorAll('.chop-key.active');
    for (var i = 0; i < act.length; i++) act[i].classList.remove('active');
    var el = this.keysEl.querySelector('[data-note="' + (CTRL_BASE + this.activeSlice) + '"]');
    if (el) el.classList.add('active');
  };

  window.Choppah = Choppah;
})();
