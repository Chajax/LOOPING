/* PRIZM-2 — dual refraction synthesizer (integrated engine).
   Each oscillator is a white beam split into N "rays" (partials):
     ray k frequency  = base · (k+1)^n     (n = index of refraction)
     ray k detune     = dispersion · k cents
     ray k amplitude  = (1/(k+1))^(1-tilt), normalized
   Two refractors (A/B) → lowpass "Aperture" → compressor → out.
   Playable via on-screen keys, computer keys (while the panel is open),
   and incoming MIDI notes; optionally routed into the loop input bus. */
(function () {
  'use strict';

  var MAX_RAYS = 8, MAX_VOICES = 8;
  var WAVES = [['sine', 'SIN'], ['triangle', 'TRI'], ['sawtooth', 'SAW'], ['square', 'SQR']];
  var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  var KEYMAP = {
    a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9,
    u: 10, j: 11, k: 12, o: 13, l: 14, p: 15, ';': 16, "'": 17
  };
  var N_KEYS = 18;

  var cutoffHz = function (v) { return 40 * Math.pow(16000 / 40, v / 100); };
  var timeVal = function (v, max) { return 0.002 + Math.pow(v / 100, 2) * max; };
  var midiHz = function (m) { return 440 * Math.pow(2, (m - 69) / 12); };
  var isBlack = function (m) { return [1, 3, 6, 8, 10].indexOf(m % 12) >= 0; };

  function rayFreq(base, k, n) { return base * Math.pow(k + 1, n); }
  function rayAmps(rays, tilt) {
    var exp = 1 - tilt, w = [], sum = 0, k;
    for (k = 0; k < rays; k++) { var a = Math.pow(1 / (k + 1), exp); w.push(a); sum += a; }
    return w.map(function (a) { return a / sum; });
  }
  function oscBase(o, noteFreq) {
    return noteFreq * Math.pow(2, o.oct) * Math.pow(2, o.semi / 12);
  }

  function Prizm(engine) {
    var ctx = engine.ctx;
    this.engine = engine;
    this.params = {
      oscs: [
        { wave: 'sawtooth', oct: 0, semi: 0, rays: 5, disp: 6, refr: 1.00, tilt: 0, level: 0.80 },
        { wave: 'sine', oct: -1, semi: 0, rays: 3, disp: 14, refr: 1.41, tilt: -0.2, level: 0.55 }
      ],
      cutoff: 74, res: 12, atk: 8, dec: 35, sus: 60, rel: 34
    };
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14; this.comp.knee.value = 20; this.comp.ratio.value = 6;
    this.out = ctx.createGain();
    this.out.gain.value = 0.72;
    this.filter.connect(this.comp);
    this.comp.connect(this.out);
    this.out.connect(engine.masterGain);
    this.loopDelay = null;      // → looper routing (comp-delay so recordings land on grid)
    this.midiIn = true;
    this.voices = new Map();
    this.releasing = [];
    this.octBase = 48;          // C3
    this.panel = null;
    this.keysEl = null;
    this.heldPC = [];
    this.applyFilter();
    var self = this;
    this.reaper = setInterval(function () {
      for (var i = self.releasing.length - 1; i >= 0; i--) {
        var v = self.releasing[i];
        if (v.env.gain.value < 0.0005) { self.stopVoice(v); self.releasing.splice(i, 1); }
      }
    }, 400);
  }

  Prizm.prototype.isOpen = function () {
    return !!(this.panel && !this.panel.classList.contains('hidden'));
  };
  Prizm.prototype.handlesKey = function (key) {
    return key in KEYMAP || key === 'z' || key === 'x';
  };
  Prizm.prototype.setVolume = function (v) {
    this.out.gain.setTargetAtTime(v, this.engine.ctx.currentTime, 0.01);
  };

  /* Route the synth into the loop input bus so loop channels record it.
     Delayed by the latency compensation, which the input path subtracts again —
     a directly injected signal would otherwise land comp early on the grid. */
  Prizm.prototype.setLoopRoute = function (on) {
    var eng = this.engine;
    if (on && !this.loopDelay) {
      this.loopDelay = eng.ctx.createDelay(1);
      this.loopDelay.delayTime.value = eng.compFrames / eng.ctx.sampleRate;
      this._routeSrc = this.routeTap || this.out;   // post-FX when a rack is attached
      this._routeSrc.connect(this.loopDelay);
      this.loopDelay.connect(eng.inputNode);
    } else if (!on && this.loopDelay) {
      this._routeSrc.disconnect(this.loopDelay);
      this.loopDelay.disconnect();
      this.loopDelay = null;
    }
  };

  /* ---------------- voices ---------------- */
  Prizm.prototype.noteOn = function (midiNote, vel) {
    var ctx = this.engine.ctx;
    if (this.voices.has(midiNote)) return;
    if (this.voices.size >= MAX_VOICES) {
      this.killVoice(this.voices.keys().next().value);
    }
    var t = ctx.currentTime;
    var freq = midiHz(midiNote);
    var env = ctx.createGain();
    env.gain.value = 0;
    env.connect(this.filter);
    var voice = { freq: freq, env: env, banks: [] };
    var self = this;

    this.params.oscs.forEach(function (o) {
      var mix = ctx.createGain();
      mix.gain.value = o.level * 0.5;
      mix.connect(env);
      var base = oscBase(o, freq);
      var amps = rayAmps(o.rays, o.tilt);
      var bank = { mix: mix, rays: [] };
      for (var k = 0; k < o.rays; k++) {
        var f = rayFreq(base, k, o.refr);
        var g = ctx.createGain();
        g.gain.value = f < 18000 ? amps[k] : 0;
        g.connect(mix);
        var osc = ctx.createOscillator();
        osc.type = o.wave;
        osc.frequency.value = Math.min(f, 20000);
        osc.detune.value = o.disp * k;
        osc.connect(g);
        osc.start(t);
        bank.rays.push({ osc: osc, g: g, k: k });
      }
      voice.banks.push(bank);
    });

    var p = this.params;
    var a = timeVal(p.atk, 3), d = timeVal(p.dec, 3), s = p.sus / 100;
    var peak = 0.35 + 0.65 * (vel === undefined ? 0.8 : vel);
    env.gain.cancelScheduledValues(t);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(peak, t + a);
    env.gain.setTargetAtTime(s * peak, t + a, Math.max(d / 3, 0.005));

    this.voices.set(midiNote, voice);
    this.paintKey(midiNote, true);
  };

  Prizm.prototype.noteOff = function (midiNote) {
    var v = this.voices.get(midiNote);
    if (!v) return;
    var ctx = this.engine.ctx;
    var t = ctx.currentTime, r = timeVal(this.params.rel, 5);
    v.env.gain.cancelScheduledValues(t);
    v.env.gain.setValueAtTime(v.env.gain.value, t);
    v.env.gain.setTargetAtTime(0, t, Math.max(r / 4, 0.008));
    this.voices.delete(midiNote);
    this.releasing.push(v);
    this.paintKey(midiNote, false);
  };

  Prizm.prototype.killVoice = function (midiNote) {
    var v = this.voices.get(midiNote);
    if (!v) return;
    this.voices.delete(midiNote);
    this.paintKey(midiNote, false);
    var t = this.engine.ctx.currentTime;
    v.env.gain.cancelScheduledValues(t);
    v.env.gain.setTargetAtTime(0, t, 0.01);
    this.releasing.push(v);
  };

  Prizm.prototype.allOff = function () {
    var self = this;
    Array.from(this.voices.keys()).forEach(function (id) { self.noteOff(id); });
    this.heldPC = [];
  };

  Prizm.prototype.stopVoice = function (v) {
    v.banks.forEach(function (b) {
      b.rays.forEach(function (r) {
        try { r.osc.stop(); } catch (e) {}
        r.osc.disconnect(); r.g.disconnect();
      });
      b.mix.disconnect();
    });
    v.env.disconnect();
  };

  /* live-update running voices when prism parameters move */
  Prizm.prototype.retune = function () {
    var ctx = this.engine.ctx;
    var p = this.params;
    var all = Array.from(this.voices.values()).concat(this.releasing);
    all.forEach(function (v) {
      v.banks.forEach(function (bank, i) {
        var o = p.oscs[i];
        var base = oscBase(o, v.freq);
        var amps = rayAmps(bank.rays.length, o.tilt);
        bank.mix.gain.setTargetAtTime(o.level * 0.5, ctx.currentTime, 0.02);
        bank.rays.forEach(function (r) {
          var f = rayFreq(base, r.k, o.refr);
          r.osc.type = o.wave;
          r.osc.frequency.setTargetAtTime(Math.min(f, 20000), ctx.currentTime, 0.02);
          r.osc.detune.setTargetAtTime(o.disp * r.k, ctx.currentTime, 0.02);
          r.g.gain.setTargetAtTime(f < 18000 ? (amps[r.k] || 0) : 0, ctx.currentTime, 0.02);
        });
      });
    });
  };

  Prizm.prototype.applyFilter = function () {
    var ctx = this.engine.ctx;
    this.filter.frequency.setTargetAtTime(cutoffHz(this.params.cutoff), ctx.currentTime, 0.02);
    this.filter.Q.setTargetAtTime(0.2 + this.params.res / 100 * 17, ctx.currentTime, 0.02);
  };

  /* ---------------- UI ---------------- */
  function ctlRow(label, min, max, step, value, fmt, onInput) {
    var row = document.createElement('div');
    row.className = 'pz-ctl';
    var lbl = document.createElement('label');
    lbl.textContent = label;
    var inp = document.createElement('input');
    inp.type = 'range';
    inp.min = min; inp.max = max; inp.step = step; inp.value = value;
    var out = document.createElement('output');
    var show = function (v) { out.textContent = fmt(v); };
    show(+value);
    inp.addEventListener('input', function () {
      var v = +this.value;
      onInput(v);
      show(v);
    });
    row.appendChild(lbl); row.appendChild(inp); row.appendChild(out);
    return row;
  }

  Prizm.prototype.buildOscPanel = function (idx, name) {
    var self = this;
    var o = this.params.oscs[idx];
    var panel = document.createElement('div');
    panel.className = 'pz-osc pz-osc-' + (idx === 0 ? 'a' : 'b');
    var h = document.createElement('div');
    h.className = 'pz-osc-title';
    h.textContent = 'PRIZM ' + name + ' · refractor';
    panel.appendChild(h);

    var waves = document.createElement('div');
    waves.className = 'pz-waves';
    WAVES.forEach(function (w) {
      var b = document.createElement('button');
      b.textContent = w[1];
      b.classList.toggle('on', o.wave === w[0]);
      b.addEventListener('click', function () {
        o.wave = w[0];
        waves.querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x === b); });
        self.retune();
      });
      waves.appendChild(b);
    });
    panel.appendChild(waves);

    var pm = function (v) { return (v > 0 ? '+' : '') + v; };
    panel.appendChild(ctlRow('Octave', -2, 2, 1, o.oct, pm, function (v) { o.oct = v; self.retune(); }));
    panel.appendChild(ctlRow('Semi', -12, 12, 1, o.semi, function (v) { return pm(v) + 'st'; }, function (v) { o.semi = v; self.retune(); }));
    panel.appendChild(ctlRow('Rays', 1, MAX_RAYS, 1, o.rays, String, function (v) { o.rays = v; }));
    panel.appendChild(ctlRow('Dispersion', 0, 50, 0.5, o.disp, function (v) { return v.toFixed(1) + '¢'; }, function (v) { o.disp = v; self.retune(); }));
    panel.appendChild(ctlRow('Index n', 50, 200, 1, o.refr * 100, function (v) { return 'n ' + (v / 100).toFixed(2); }, function (v) { o.refr = v / 100; self.retune(); }));
    panel.appendChild(ctlRow('Tilt', -100, 100, 1, o.tilt * 100, pm, function (v) { o.tilt = v / 100; self.retune(); }));
    panel.appendChild(ctlRow('Level', 0, 100, 1, o.level * 100, String, function (v) { o.level = v / 100; self.retune(); }));
    return panel;
  };

  Prizm.prototype.buildUI = function (panelSection, uiRoot) {
    var self = this;
    this.panel = panelSection;
    var p = this.params;

    var grid = document.createElement('div');
    grid.className = 'pz-grid';
    grid.appendChild(this.buildOscPanel(0, 'A'));
    grid.appendChild(this.buildOscPanel(1, 'B'));

    var glob = document.createElement('div');
    glob.className = 'pz-osc pz-global';
    var gh = document.createElement('div');
    gh.className = 'pz-osc-title';
    gh.textContent = 'APERTURE · EXPOSURE';
    glob.appendChild(gh);
    var msFmt = function (max) { return function (v) { return Math.round(timeVal(v, max) * 1000) + 'ms'; }; };
    glob.appendChild(ctlRow('Cutoff', 0, 100, 1, p.cutoff, function (v) {
      var f = cutoffHz(v);
      return f >= 1000 ? (f / 1000).toFixed(1) + 'k' : Math.round(f) + 'Hz';
    }, function (v) { p.cutoff = v; self.applyFilter(); }));
    glob.appendChild(ctlRow('Reso', 0, 100, 1, p.res, function (v) { return (0.2 + v / 100 * 17).toFixed(1); }, function (v) { p.res = v; self.applyFilter(); }));
    glob.appendChild(ctlRow('Attack', 0, 100, 1, p.atk, msFmt(3), function (v) { p.atk = v; }));
    glob.appendChild(ctlRow('Decay', 0, 100, 1, p.dec, msFmt(3), function (v) { p.dec = v; }));
    glob.appendChild(ctlRow('Sustain', 0, 100, 1, p.sus, function (v) { return v + '%'; }, function (v) { p.sus = v; }));
    glob.appendChild(ctlRow('Release', 0, 100, 1, p.rel, msFmt(5), function (v) { p.rel = v; }));
    grid.appendChild(glob);
    uiRoot.appendChild(grid);

    // keyboard
    var kw = document.createElement('div');
    kw.className = 'pz-kbd';
    var top = document.createElement('div');
    top.className = 'pz-kbd-top';
    var octDown = document.createElement('button'); octDown.textContent = 'Z −oct';
    var octLabel = document.createElement('span');
    var octUp = document.createElement('button'); octUp.textContent = 'X +oct';
    top.appendChild(octDown); top.appendChild(octLabel); top.appendChild(octUp);
    kw.appendChild(top);
    this.keysEl = document.createElement('div');
    this.keysEl.className = 'pz-keys';
    kw.appendChild(this.keysEl);
    uiRoot.appendChild(kw);
    this.octLabel = octLabel;

    octDown.addEventListener('click', function () { self.octBase = Math.max(24, self.octBase - 12); self.buildKeys(); });
    octUp.addEventListener('click', function () { self.octBase = Math.min(84, self.octBase + 12); self.buildKeys(); });
    this.buildKeys();

    // pointer playing
    var pointerDown = false;
    this.keysEl.addEventListener('pointerdown', function (e) {
      var k = e.target.closest('.pz-key');
      if (!k) return;
      pointerDown = true;
      self.noteOn(+k.dataset.note, 0.8);
    });
    window.addEventListener('pointerup', function () {
      if (!pointerDown) return;
      pointerDown = false;
      Array.from(self.voices.keys()).forEach(function (id) {
        if (self.heldPC.indexOf(id) < 0) self.noteOff(id);
      });
    });
    this.keysEl.addEventListener('pointerover', function (e) {
      if (!pointerDown) return;
      var k = e.target.closest('.pz-key');
      if (!k) return;
      Array.from(self.voices.keys()).forEach(function (id) {
        if (self.heldPC.indexOf(id) < 0) self.noteOff(id);
      });
      self.noteOn(+k.dataset.note, 0.8);
    });

    // computer keys (only while the panel is open, and never from form fields)
    document.addEventListener('keydown', function (e) {
      if (e.repeat || !self.isOpen() || e.metaKey || e.ctrlKey || e.altKey) return;
      var tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      var key = e.key.toLowerCase();
      if (key === 'z') { self.octBase = Math.max(24, self.octBase - 12); self.buildKeys(); return; }
      if (key === 'x') { self.octBase = Math.min(84, self.octBase + 12); self.buildKeys(); return; }
      if (key in KEYMAP) {
        var m = self.octBase + KEYMAP[key];
        if (self.heldPC.indexOf(m) < 0) self.heldPC.push(m);
        self.noteOn(m, 0.8);
      }
    });
    document.addEventListener('keyup', function (e) {
      var key = e.key.toLowerCase();
      if (key in KEYMAP) {
        var m = self.octBase + KEYMAP[key];
        var ix = self.heldPC.indexOf(m);
        if (ix > -1) self.heldPC.splice(ix, 1);
        self.noteOff(m);
      }
    });
  };

  Prizm.prototype.buildKeys = function () {
    var self = this;
    this.keysEl.innerHTML = '';
    var whites = [];
    for (var i = 0; i < N_KEYS; i++) if (!isBlack(this.octBase + i)) whites.push(i);
    var wCount = whites.length;
    var keyLetter = function (i2) {
      for (var k in KEYMAP) if (KEYMAP[k] === i2) return k;
      return '';
    };
    whites.forEach(function (i2) {
      var el = document.createElement('div');
      el.className = 'pz-key';
      el.dataset.note = self.octBase + i2;
      el.innerHTML = '<span class="kc">' + keyLetter(i2).toUpperCase() + '</span>';
      self.keysEl.appendChild(el);
    });
    var wi = 0;
    for (i = 0; i < N_KEYS; i++) {
      var m = this.octBase + i;
      if (isBlack(m)) {
        var el2 = document.createElement('div');
        el2.className = 'pz-key black';
        el2.dataset.note = m;
        el2.innerHTML = '<span class="kc">' + keyLetter(i).toUpperCase() + '</span>';
        el2.style.left = 'calc(' + (wi / wCount) * 100 + '% - 3.1%)';
        this.keysEl.appendChild(el2);
      } else wi++;
    }
    this.octLabel.textContent = NOTE_NAMES[this.octBase % 12] + (Math.floor(this.octBase / 12) - 1);
  };

  Prizm.prototype.paintKey = function (midiNote, on) {
    if (!this.keysEl) return;
    var el = this.keysEl.querySelector('[data-note="' + midiNote + '"]');
    if (el) el.classList.toggle('held', on);
  };

  Prizm._math = { rayFreq: rayFreq, rayAmps: rayAmps, oscBase: oscBase, cutoffHz: cutoffHz };
  window.Prizm = Prizm;
})();
