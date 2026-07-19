/* 808-style drum machine with dynamic rows: synthesized voices (no samples needed),
   imported sample rows, spawnable duplicates, and per-row step counts — rows with
   different lengths cycle against each other (polymeter/polyrhythm), all driven by
   one global 16th-note grid phase-locked to the transport. */
(function () {
  'use strict';

  var SYNTHS = {
    bd: { label: 'KICK', level: 1.0 },
    sd: { label: 'SNARE', level: 0.8 },
    ch: { label: 'CL HAT', level: 0.55 },
    oh: { label: 'OP HAT', level: 0.55 },
    cp: { label: 'CLAP', level: 0.75 }
  };

  function DrumMachine(engine) {
    this.engine = engine;
    this.enabled = false;
    this.rows = [];          // { kind:'synth'|'sample', synth, label, buffer, steps:[bool], level, cells, el, _last }
    this.grid = null;
    this.schedFrom = null;
    this.openHatGain = null; // closed hat chokes the open hat, 808 style
    this.out = engine.ctx.createGain();
    this.out.gain.value = 0.9;
    this.out.connect(engine.masterGain);
    this.noiseBuf = this.makeNoise();
    var self = this;
    ['bd', 'sd', 'ch', 'oh', 'cp'].forEach(function (id) { self.addSynthRow(id); });
  }

  DrumMachine.prototype.makeNoise = function () {
    var ctx = this.engine.ctx;
    var buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  };

  DrumMachine.prototype.setVolume = function (v) {
    this.out.gain.setTargetAtTime(v, this.engine.ctx.currentTime, 0.01);
  };

  /* ---- rows ---- */
  DrumMachine.prototype.addSynthRow = function (synthId) {
    var def = SYNTHS[synthId];
    if (!def) return null;
    var row = {
      kind: 'synth', synth: synthId, label: def.label, buffer: null,
      steps: new Array(16).fill(false), level: def.level,
      cells: null, el: null, _last: -1
    };
    this.rows.push(row);
    if (this.grid) this.buildRow(row);
    return row;
  };

  DrumMachine.prototype.addSampleRow = function (label, audioBuffer) {
    var row = {
      kind: 'sample', synth: null, label: label.toUpperCase().slice(0, 8), buffer: audioBuffer,
      steps: new Array(16).fill(false), level: 0.9,
      cells: null, el: null, _last: -1
    };
    this.rows.push(row);
    if (this.grid) this.buildRow(row);
    return row;
  };

  DrumMachine.prototype.removeRow = function (row) {
    var i = this.rows.indexOf(row);
    if (i < 0) return;
    this.rows.splice(i, 1);
    if (row.el) row.el.remove();
  };

  DrumMachine.prototype.setRowSteps = function (row, n) {
    n = Math.max(2, Math.min(32, Math.round(n)));
    var next = new Array(n).fill(false);
    for (var i = 0; i < Math.min(n, row.steps.length); i++) next[i] = row.steps[i];
    row.steps = next;
    row._last = -1;
    if (row.el) {
      var el = row.el;
      this.buildRow(row, el);   // rebuild in place
    }
  };

  DrumMachine.prototype.clearPattern = function () {
    this.rows.forEach(function (row) {
      row.steps.fill(false);
      if (row.cells) row.cells.forEach(function (c) { c.classList.remove('on'); });
    });
  };

  DrumMachine.prototype.hasPattern = function () {
    return this.rows.some(function (row) {
      return row.steps.some(Boolean);
    });
  };

  /* ---- voices ---- */
  DrumMachine.prototype.noiseSource = function (when, dur) {
    var ctx = this.engine.ctx;
    var src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    src.start(when);
    src.stop(when + dur);
    return src;
  };

  DrumMachine.prototype.playSynth = function (id, when, vel) {
    var ctx = this.engine.ctx;
    var out = this.out;
    var g = ctx.createGain();
    g.connect(out);

    if (id === 'bd') {
      var o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(120, when);
      o.frequency.exponentialRampToValueAtTime(45, when + 0.12);
      g.gain.setValueAtTime(vel, when);
      g.gain.exponentialRampToValueAtTime(0.001, when + 0.5);
      o.connect(g);
      o.start(when); o.stop(when + 0.55);

    } else if (id === 'sd') {
      var t1 = ctx.createOscillator();
      t1.type = 'triangle';
      t1.frequency.value = 185;
      var tg = ctx.createGain();
      tg.gain.setValueAtTime(vel * 0.5, when);
      tg.gain.exponentialRampToValueAtTime(0.001, when + 0.12);
      t1.connect(tg); tg.connect(out);
      t1.start(when); t1.stop(when + 0.15);
      var n = this.noiseSource(when, 0.25);
      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.8;
      g.gain.setValueAtTime(vel, when);
      g.gain.exponentialRampToValueAtTime(0.001, when + 0.2);
      n.connect(bp); bp.connect(g);

    } else if (id === 'ch' || id === 'oh') {
      var dur = id === 'ch' ? 0.055 : 0.4;
      if (id === 'ch' && this.openHatGain) {
        this.openHatGain.gain.setTargetAtTime(0.0001, when, 0.008);
        this.openHatGain = null;
      }
      var hn = this.noiseSource(when, dur + 0.05);
      var hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 7500;
      g.gain.setValueAtTime(vel * 0.8, when);
      g.gain.exponentialRampToValueAtTime(0.001, when + dur);
      hn.connect(hp); hp.connect(g);
      if (id === 'oh') this.openHatGain = g;

    } else if (id === 'cp') {
      var cn = this.noiseSource(when, 0.35);
      var cb = ctx.createBiquadFilter();
      cb.type = 'bandpass'; cb.frequency.value = 1200; cb.Q.value = 1.6;
      g.gain.setValueAtTime(0.0001, when);
      for (var i = 0; i < 3; i++) {
        g.gain.setValueAtTime(vel, when + i * 0.011);
        g.gain.exponentialRampToValueAtTime(vel * 0.25, when + i * 0.011 + 0.009);
      }
      g.gain.setValueAtTime(vel * 0.7, when + 0.033);
      g.gain.exponentialRampToValueAtTime(0.001, when + 0.3);
      cn.connect(cb); cb.connect(g);
    }
  };

  DrumMachine.prototype.playSample = function (row, when, vel) {
    var ctx = this.engine.ctx;
    var src = ctx.createBufferSource();
    src.buffer = row.buffer;
    var g = ctx.createGain();
    g.gain.value = vel;
    src.connect(g);
    g.connect(this.out);
    src.start(when);
  };

  DrumMachine.prototype.trigger = function (row, when) {
    if (row.kind === 'sample') this.playSample(row, when, row.level);
    else this.playSynth(row.synth, when, row.level);
  };

  /* ---- sequencer: one global 16th grid, per-row modulo (polymeter) ---- */
  DrumMachine.prototype.pump = function () {
    var t = this.engine.transport;
    if (!this.enabled || !t.running) { this.schedFrom = null; return; }
    var sr = t.sr;
    var nowF = t.nowFrame();
    var horizon = nowF + 0.15 * sr;
    var stepF = t.beatFrames() / 4;
    var from = (this.schedFrom === null || this.schedFrom < nowF) ? nowF : this.schedFrom;
    var k = Math.floor((from - t.origin) / stepF) + 1;
    for (var fr = t.origin + k * stepF; fr <= horizon; fr += stepF, k++) {
      var when = fr / sr;
      for (var r = 0; r < this.rows.length; r++) {
        var row = this.rows[r];
        var n = row.steps.length;
        if (row.steps[((k % n) + n) % n]) this.trigger(row, when);
      }
    }
    this.schedFrom = horizon;
  };

  /* ---- UI ---- */
  DrumMachine.prototype.mountUI = function (grid) {
    this.grid = grid;
    var self = this;
    this.rows.forEach(function (row) { self.buildRow(row); });
  };

  /* Build (or rebuild in place) one row's DOM. */
  DrumMachine.prototype.buildRow = function (row, existingEl) {
    var self = this;
    var rowEl = document.createElement('div');
    rowEl.className = 'drum-row';

    var rm = document.createElement('button');
    rm.className = 'drum-remove';
    rm.textContent = '✕';
    rm.title = 'Remove this drum row';
    rm.addEventListener('click', function () { self.removeRow(row); });
    rowEl.appendChild(rm);

    var label = document.createElement('button');
    label.className = 'drum-label';
    label.textContent = row.label;
    label.title = 'Preview ' + row.label;
    label.addEventListener('click', function () {
      self.trigger(row, self.engine.ctx.currentTime + 0.02);
    });
    rowEl.appendChild(label);

    var stepsIn = document.createElement('input');
    stepsIn.type = 'number';
    stepsIn.className = 'drum-steps';
    stepsIn.min = 2; stepsIn.max = 32; stepsIn.value = row.steps.length;
    stepsIn.title = 'Steps in this row — a length other than 16 cycles against the other rows (polyrhythm)';
    stepsIn.addEventListener('change', function () {
      self.setRowSteps(row, parseFloat(this.value) || 16);
    });
    rowEl.appendChild(stepsIn);

    row.cells = [];
    for (var s = 0; s < row.steps.length; s++) {
      (function (col) {
        var cell = document.createElement('button');
        cell.className = 'step' + (col % 4 === 0 ? ' beat1' : '') + (row.steps[col] ? ' on' : '');
        cell.addEventListener('click', function () {
          row.steps[col] = !row.steps[col];
          cell.classList.toggle('on', row.steps[col]);
        });
        rowEl.appendChild(cell);
        row.cells.push(cell);
      })(s);
    }

    var lvl = document.createElement('input');
    lvl.type = 'range';
    lvl.min = 0; lvl.max = 1.2; lvl.step = 0.01;
    lvl.value = row.level;
    lvl.className = 'drum-level';
    lvl.title = row.label + ' level';
    lvl.addEventListener('input', function () {
      row.level = parseFloat(this.value);
    });
    rowEl.appendChild(lvl);

    if (existingEl) existingEl.replaceWith(rowEl);
    else this.grid.appendChild(rowEl);
    row.el = rowEl;
    row._last = -1;
  };

  /* Per-row playhead: rows of different lengths show their own cycle position. */
  DrumMachine.prototype.updatePlayhead = function () {
    var t = this.engine.transport;
    var running = this.enabled && t.running;
    var k = -1;
    if (running) {
      var stepF = t.beatFrames() / 4;
      k = Math.floor((t.nowFrame() - t.origin) / stepF);
    }
    this.rows.forEach(function (row) {
      if (!row.cells) return;
      var idx = -1;
      if (k >= 0) {
        var n = row.steps.length;
        idx = ((k % n) + n) % n;
      }
      if (idx === row._last) return;
      if (row._last >= 0 && row.cells[row._last]) row.cells[row._last].classList.remove('now');
      if (idx >= 0 && row.cells[idx]) row.cells[idx].classList.add('now');
      row._last = idx;
    });
  };

  window.DrumMachine = DrumMachine;
})();
