/* Effects + FxRack: a shared effect-chain component with per-parameter LFO
   automation, used by loop channels and the instrument buses (808/303/PRIZM).

   Effect contract: def.build(ctx, engine) -> { input, output, set(id, v),
   tick(transport)?, dispose() }. Params are range sliders ({min,max,def,log,
   unit,auto}) or selects ({type:'select', options:[[value,label],...]}).
   Automation runs on a single shared ticker, phase-locked to the transport. */
(function () {
  'use strict';

  var RATE_BEATS = {
    '1/16': 0.25, '1/8': 0.5, '1/8.': 0.75, '1/4': 1,
    '1/2': 2, '1/1': 4, '2/1': 8, '4/1': 16
  };
  var SYNC_OPTS = [['off', 'free'], ['1/16', '1/16'], ['1/8', '1/8'], ['1/8.', '1/8.'],
    ['1/4', '1/4'], ['1/2', '1/2'], ['1/1', '1 bar']];

  function makeReverbIR(ctx, seconds) {
    var sr = ctx.sampleRate;
    var len = Math.max(1, Math.floor(sr * seconds));
    var ir = ctx.createBuffer(2, len, sr);
    for (var ch = 0; ch < 2; ch++) {
      var d = ir.getChannelData(ch);
      for (var i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
      }
    }
    return ir;
  }

  function distortionCurve(amount) {
    var k = amount, n = 2048, curve = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var x = (i * 2) / n - 1;
      curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    return curve;
  }

  function beatsToSec(div, bpm) { return RATE_BEATS[div] * 60 / bpm; }
  function autoBars(len) {
    var beats = RATE_BEATS[len] || 4;
    return Math.max(1, Math.round(beats / 4));
  }

  /* ---------------- effect definitions ---------------- */
  window.FX_DEFS = {
    filter: {
      name: 'Filter',
      params: [
        { id: 'type', label: 'Type', type: 'select', def: 'lp', options: [['lp', 'Low-pass'], ['hp', 'High-pass'], ['bp', 'Band-pass']] },
        { id: 'freq', label: 'Cutoff', min: 40, max: 18000, def: 2400, log: true, unit: 'Hz' },
        { id: 'q', label: 'Reso', min: 0.1, max: 14, def: 0.8, unit: '' }
      ],
      build: function (ctx) {
        var f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        return {
          input: f, output: f,
          set: function (id, v) {
            if (id === 'type') f.type = v === 'hp' ? 'highpass' : v === 'bp' ? 'bandpass' : 'lowpass';
            else if (id === 'freq') f.frequency.setTargetAtTime(v, ctx.currentTime, 0.01);
            else f.Q.setTargetAtTime(v, ctx.currentTime, 0.01);
          },
          dispose: function () { f.disconnect(); }
        };
      }
    },

    delay: {
      name: 'Delay',
      params: [
        { id: 'sync', label: 'Sync', type: 'select', def: 'off', options: SYNC_OPTS },
        { id: 'time', label: 'Time', min: 30, max: 1500, def: 350, unit: 'ms' },
        { id: 'fb', label: 'Feedbk', min: 0, max: 0.92, def: 0.35, unit: '' },
        { id: 'mix', label: 'Mix', min: 0, max: 1, def: 0.3, unit: '' }
      ],
      build: function (ctx, engine) {
        var input = ctx.createGain(), output = ctx.createGain();
        var dly = ctx.createDelay(4.0), fb = ctx.createGain(), wet = ctx.createGain();
        input.connect(output);
        input.connect(dly);
        dly.connect(wet); wet.connect(output);
        dly.connect(fb); fb.connect(dly);
        var st = { sync: 'off', time: 350, applied: 0 };
        function applyTime(bpm) {
          var sec = st.sync === 'off' ? st.time / 1000 : Math.min(3.9, beatsToSec(st.sync, bpm));
          if (Math.abs(sec - st.applied) > 0.001) {
            st.applied = sec;
            dly.delayTime.setTargetAtTime(sec, ctx.currentTime, 0.05);
          }
        }
        applyTime(engine.transport ? engine.transport.bpm : 120);
        return {
          input: input, output: output,
          set: function (id, v) {
            if (id === 'time') { st.time = v; applyTime(engine.transport.bpm); }
            else if (id === 'sync') { st.sync = v; applyTime(engine.transport.bpm); }
            else if (id === 'fb') fb.gain.setTargetAtTime(v, ctx.currentTime, 0.01);
            else wet.gain.setTargetAtTime(v, ctx.currentTime, 0.01);
          },
          tick: function (t) { if (st.sync !== 'off') applyTime(t.bpm); },
          dispose: function () { input.disconnect(); dly.disconnect(); fb.disconnect(); wet.disconnect(); }
        };
      }
    },

    reverb: {
      name: 'Reverb',
      params: [
        { id: 'sync', label: 'Sync', type: 'select', def: 'off', options: [['off', 'free'], ['1/2', '1/2'], ['1/1', '1 bar'], ['2/1', '2 bars']] },
        { id: 'decay', label: 'Decay', min: 0.3, max: 8, def: 2.2, unit: 's', auto: false },
        { id: 'mix', label: 'Mix', min: 0, max: 1, def: 0.35, unit: '' }
      ],
      build: function (ctx, engine) {
        var input = ctx.createGain(), output = ctx.createGain();
        var conv = ctx.createConvolver(), wet = ctx.createGain();
        conv.buffer = makeReverbIR(ctx, 2.2);
        input.connect(output);
        input.connect(conv); conv.connect(wet); wet.connect(output);
        var st = { sync: 'off', decay: 2.2, applied: 2.2, lastRegen: 0 };
        var regenTimer = null;
        function regen(sec) {
          sec = Math.max(0.3, Math.min(10, sec));
          if (Math.abs(sec - st.applied) / st.applied < 0.05) return;
          var now = Date.now();
          if (now - st.lastRegen < 400) return;
          st.applied = sec;
          st.lastRegen = now;
          conv.buffer = makeReverbIR(ctx, sec);
        }
        return {
          input: input, output: output,
          set: function (id, v) {
            if (id === 'mix') { wet.gain.setTargetAtTime(v, ctx.currentTime, 0.01); return; }
            if (id === 'sync') { st.sync = v; if (v !== 'off') regen(beatsToSec(v, engine.transport.bpm)); return; }
            st.decay = v;
            clearTimeout(regenTimer);
            regenTimer = setTimeout(function () { if (st.sync === 'off') regen(st.decay); }, 250);
          },
          tick: function (t) { if (st.sync !== 'off') regen(beatsToSec(st.sync, t.bpm)); },
          dispose: function () { clearTimeout(regenTimer); input.disconnect(); conv.disconnect(); wet.disconnect(); }
        };
      }
    },

    dist: {
      name: 'Distortion',
      params: [
        { id: 'drive', label: 'Drive', min: 1, max: 120, def: 20, unit: '', auto: false },
        { id: 'mix', label: 'Mix', min: 0, max: 1, def: 1, unit: '' }
      ],
      build: function (ctx) {
        var input = ctx.createGain(), output = ctx.createGain();
        var shaper = ctx.createWaveShaper(), wet = ctx.createGain(), dry = ctx.createGain();
        shaper.curve = distortionCurve(20);
        shaper.oversample = '4x';
        input.connect(dry); dry.connect(output);
        input.connect(shaper); shaper.connect(wet); wet.connect(output);
        dry.gain.value = 0; wet.gain.value = 1;
        return {
          input: input, output: output,
          set: function (id, v) {
            if (id === 'drive') shaper.curve = distortionCurve(v);
            else {
              wet.gain.setTargetAtTime(v, ctx.currentTime, 0.01);
              dry.gain.setTargetAtTime(1 - v, ctx.currentTime, 0.01);
            }
          },
          dispose: function () { input.disconnect(); shaper.disconnect(); wet.disconnect(); dry.disconnect(); }
        };
      }
    },

    flanger: {
      name: 'Flanger',
      params: [
        { id: 'rate', label: 'Rate', min: 0.05, max: 2, def: 0.25, unit: 'Hz' },
        { id: 'depth', label: 'Depth', min: 0, max: 3, def: 1.5, unit: 'ms' },
        { id: 'fb', label: 'Feedbk', min: 0, max: 0.85, def: 0.4, unit: '' },
        { id: 'mix', label: 'Mix', min: 0, max: 1, def: 0.5, unit: '' }
      ],
      build: function (ctx) {
        var input = ctx.createGain(), output = ctx.createGain();
        var dly = ctx.createDelay(0.05), wet = ctx.createGain(), fb = ctx.createGain();
        var osc = ctx.createOscillator(), lfoGain = ctx.createGain();
        dly.delayTime.value = 0.004;
        osc.frequency.value = 0.25;
        lfoGain.gain.value = 0.0015;
        osc.connect(lfoGain); lfoGain.connect(dly.delayTime);
        osc.start();
        input.connect(output);
        input.connect(dly); dly.connect(wet); wet.connect(output);
        dly.connect(fb); fb.connect(dly);
        fb.gain.value = 0.4;
        return {
          input: input, output: output,
          set: function (id, v) {
            if (id === 'rate') osc.frequency.setTargetAtTime(v, ctx.currentTime, 0.05);
            else if (id === 'depth') lfoGain.gain.setTargetAtTime(v / 2000, ctx.currentTime, 0.05);
            else if (id === 'fb') fb.gain.setTargetAtTime(v, ctx.currentTime, 0.01);
            else wet.gain.setTargetAtTime(v, ctx.currentTime, 0.01);
          },
          dispose: function () {
            try { osc.stop(); } catch (e) {}
            input.disconnect(); dly.disconnect(); wet.disconnect(); fb.disconnect(); osc.disconnect(); lfoGain.disconnect();
          }
        };
      }
    },

    chorus: {
      name: 'Chorus',
      params: [
        { id: 'rate', label: 'Rate', min: 0.05, max: 5, def: 0.8, unit: 'Hz' },
        { id: 'depth', label: 'Depth', min: 0, max: 12, def: 3.5, unit: 'ms' },
        { id: 'mix', label: 'Mix', min: 0, max: 1, def: 0.5, unit: '' }
      ],
      build: function (ctx) {
        var input = ctx.createGain(), output = ctx.createGain();
        var dly = ctx.createDelay(0.1), wet = ctx.createGain();
        var osc = ctx.createOscillator(), lfoGain = ctx.createGain();
        dly.delayTime.value = 0.02;
        osc.frequency.value = 0.8;
        lfoGain.gain.value = 0.0035;
        osc.connect(lfoGain); lfoGain.connect(dly.delayTime);
        osc.start();
        input.connect(output);
        input.connect(dly); dly.connect(wet); wet.connect(output);
        return {
          input: input, output: output,
          set: function (id, v) {
            if (id === 'rate') osc.frequency.setTargetAtTime(v, ctx.currentTime, 0.05);
            else if (id === 'depth') lfoGain.gain.setTargetAtTime(v / 1000, ctx.currentTime, 0.05);
            else wet.gain.setTargetAtTime(v, ctx.currentTime, 0.01);
          },
          dispose: function () {
            try { osc.stop(); } catch (e) {}
            input.disconnect(); dly.disconnect(); wet.disconnect(); osc.disconnect(); lfoGain.disconnect();
          }
        };
      }
    }
  };

  /* ---------------- automation (drawable loops) ---------------- */
  var LEN_OPTS = [['1/4', '1/4'], ['1/2', '1/2'], ['1/1', '1 bar'],
    ['2/1', '2 bars'], ['4/1', '4 bars']];
  var AUTO_N = 128;            // curve resolution (points across the loop)

  /* value <-> normalized 0..1 across the param range (log-aware) */
  function normOf(p, v) {
    if (p.log) return (Math.log(v) - Math.log(p.min)) / (Math.log(p.max) - Math.log(p.min));
    return (v - p.min) / (p.max - p.min);
  }
  function valOf(p, norm) {
    norm = Math.max(0, Math.min(1, norm));
    if (p.log) return Math.exp(Math.log(p.min) + norm * (Math.log(p.max) - Math.log(p.min)));
    return p.min + norm * (p.max - p.min);
  }

  function fmtVal(p, v) {
    return (v >= 100 ? Math.round(v) : Math.round(v * 100) / 100) + (p.unit || '');
  }

  /* Render an automation lane: the drawn curve, filled, with a moving playhead. */
  function drawLane(a, ph) {
    var c = a.canvas, g = a.cctx;
    var W = c.width, H = c.height;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(181,140,255,0.10)';
    g.fillRect(0, 0, W, H);
    // grid: quarters of the loop
    g.strokeStyle = 'rgba(216,220,230,0.10)';
    for (var q = 1; q < 4; q++) {
      var gx = q / 4 * W;
      g.beginPath(); g.moveTo(gx, 0); g.lineTo(gx, H); g.stroke();
    }
    // curve
    g.beginPath();
    for (var i = 0; i < AUTO_N; i++) {
      var x = i / (AUTO_N - 1) * W;
      var y = (1 - a.pts[i]) * H;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.lineTo(W, (1 - a.pts[AUTO_N - 1]) * H);
    g.lineTo(W, H); g.lineTo(0, H); g.closePath();
    g.fillStyle = 'rgba(181,140,255,0.28)';
    g.fill();
    g.strokeStyle = '#b58cff';
    g.lineWidth = 1.4;
    g.beginPath();
    for (i = 0; i < AUTO_N; i++) {
      var x2 = i / (AUTO_N - 1) * W, y2 = (1 - a.pts[i]) * H;
      if (i === 0) g.moveTo(x2, y2); else g.lineTo(x2, y2);
    }
    g.stroke();
    // playhead
    if (ph >= 0) {
      var px = ph * W;
      g.strokeStyle = '#ffa229';
      g.beginPath(); g.moveTo(px, 0); g.lineTo(px, H); g.stroke();
      var idx = Math.floor(ph * AUTO_N) % AUTO_N;
      g.fillStyle = '#ffa229';
      g.beginPath(); g.arc(px, (1 - a.pts[idx]) * H, 2.5, 0, 2 * Math.PI); g.fill();
    }
  }

  /* ---------------- FxRack ---------------- */
  var racks = [];
  var ticker = null;
  var TICK_MS = 16;             // ~60 Hz control rate + lane playhead refresh
  var nextRackId = 1;

  /* Continuous musical phase in beats. Bar-locked while the transport runs (so
     sweeps land on bar lines), free-running from the same value when it stops —
     no jump at start/stop, which would otherwise glitch a live sweep. */
  var phaseBeats = 0, lastWallMs = null;
  function currentBeats(t) {
    var nowMs = performance.now();
    if (t.running) {
      phaseBeats = (t.nowFrame() - t.origin) / t.beatFrames();
      lastWallMs = nowMs;
    } else {
      if (lastWallMs === null) lastWallMs = nowMs;
      phaseBeats += (nowMs - lastWallMs) / 1000 * t.bpm / 60;
      lastWallMs = nowMs;
    }
    return phaseBeats;
  }

  var dispTick = 0;
  function tickAll() {
    dispTick++;
    var showNow = (dispTick % 4) === 0;   // refresh readouts ~15 Hz, not every frame
    var t = racks.length ? racks[0].engine.transport : null;
    if (!t) return;
    var beats = currentBeats(t);
    for (var r = 0; r < racks.length; r++) {
      var rack = racks[r];
      for (var f = 0; f < rack.fx.length; f++) {
        var entry = rack.fx[f];
        if (entry.inst.tick) entry.inst.tick(t);
        for (var pi = 0; pi < entry.def.params.length; pi++) {
          var p = entry.def.params[pi];
          if (p.type === 'select') continue;
          var a = entry.autos[p.id];
          if (!a) continue;
          var cyc = RATE_BEATS[a.len] || 4;
          var ph = ((beats / cyc) % 1 + 1) % 1;

          if (a.rec) {
            var rel = (beats - a.recStartBeat) / cyc;
            var recNorm = normOf(p, entry.values[p.id]);
            var ridx = Math.round(ph * (AUTO_N - 1));
            if (a.recLastIdx >= 0 && ridx !== a.recLastIdx) {
              var lo = Math.min(ridx, a.recLastIdx), hi = Math.max(ridx, a.recLastIdx);
              for (var rk = lo; rk <= hi; rk++) {
                var rf = (rk - a.recLastIdx) / (ridx - a.recLastIdx);
                a.pts[rk] = a.recLastNorm + (recNorm - a.recLastNorm) * rf;
              }
            } else {
              a.pts[ridx] = recNorm;
            }
            a.recLastIdx = ridx;
            a.recLastNorm = recNorm;
            if (rel >= 1) {
              a.rec = false;
              if (a.recBtn) a.recBtn.classList.remove('on');
            }
            if (showNow) {
              if (a.cctx) drawLane(a, ph);
              if (entry.outEls && entry.outEls[p.id]) entry.outEls[p.id].textContent = fmtVal(p, entry.values[p.id]);
            }
            continue;
          }

          if (!a.on || a.songForce === false) {
            if (showNow && a.cctx) drawLane(a, ph);
            continue;
          }

          // sample the drawn curve (linear interpolation between points)
          var fidx = ph * AUTO_N;
          var i0 = Math.floor(fidx) % AUTO_N, i1 = (i0 + 1) % AUTO_N, fr = fidx - Math.floor(fidx);
          var norm = a.pts[i0] * (1 - fr) + a.pts[i1] * fr;
          var v = valOf(p, norm);
          entry.inst.set(p.id, v);
          if (showNow) {
            if (entry.outEls && entry.outEls[p.id]) entry.outEls[p.id].textContent = fmtVal(p, v);
            if (a.cctx) drawLane(a, ph);
          }
        }
      }
    }
  }

  function FxRack(engine) {
    this.engine = engine;
    this.id = nextRackId++;
    this._nextFxUid = 1;
    this.input = engine.ctx.createGain();
    this.output = engine.ctx.createGain();
    this.input.connect(this.output);
    this.fx = [];        // { key, def, inst, values, autos, card, outEls }
    this.listEl = null;
    racks.push(this);
    if (!ticker) ticker = setInterval(tickAll, TICK_MS);
  }

  FxRack.prototype.addFx = function (key) {
    var def = window.FX_DEFS[key];
    if (!def) return null;
    var inst = def.build(this.engine.ctx, this.engine);
    var values = {}, autos = {};
    def.params.forEach(function (p) {
      values[p.id] = p.def;
      inst.set(p.id, p.def);
      if (p.type !== 'select' && p.auto !== false) {
        var pts = new Float32Array(AUTO_N);
        pts.fill(normOf(p, p.def));   // starts flat at the slider's value
        autos[p.id] = {
          on: false, len: '1/1', pts: pts, canvas: null, cctx: null,
          songForce: null, rec: false, recStartBeat: 0, recLastIdx: -1, recLastNorm: 0,
          recBtn: null
        };
      }
    });
    var entry = {
      key: key, uid: this._nextFxUid++, def: def, inst: inst,
      values: values, autos: autos, card: null, outEls: {}
    };
    this.fx.push(entry);
    this.rebuild();
    if (this.listEl) this.buildCard(entry);
    return entry;
  };

  FxRack.prototype.removeFx = function (entry) {
    var i = this.fx.indexOf(entry);
    if (i < 0) return;
    this.fx.splice(i, 1);
    this.rebuild();
    entry.inst.dispose();
    if (entry.card) entry.card.remove();
  };

  FxRack.prototype.rebuild = function () {
    this.input.disconnect();
    this.fx.forEach(function (e) { e.inst.output.disconnect(); });
    var prev = this.input;
    for (var i = 0; i < this.fx.length; i++) {
      prev.connect(this.fx[i].inst.input);
      prev = this.fx[i].inst.output;
    }
    prev.connect(this.output);
  };

  FxRack.prototype.dispose = function () {
    this.fx.forEach(function (e) { e.inst.dispose(); });
    this.fx = [];
    this.input.disconnect();
    this.output.disconnect();
    var i = racks.indexOf(this);
    if (i >= 0) racks.splice(i, 1);
  };

  FxRack.prototype._findAuto = function (laneId) {
    for (var fi = 0; fi < this.fx.length; fi++) {
      var e = this.fx[fi];
      for (var pi = 0; pi < e.def.params.length; pi++) {
        var p = e.def.params[pi];
        if (p.type === 'select') continue;
        var id = this.id + ':' + e.uid + ':' + p.id;
        if (id === laneId) return { entry: e, param: p, auto: e.autos[p.id] };
      }
    }
    return null;
  };

  FxRack.prototype.songAutomationTracks = function (prefix) {
    var out = [];
    for (var fi = 0; fi < this.fx.length; fi++) {
      var e = this.fx[fi];
      for (var pi = 0; pi < e.def.params.length; pi++) {
        var p = e.def.params[pi];
        if (p.type === 'select') continue;
        var a = e.autos[p.id];
        if (!a || !a.on) continue;
        var laneId = this.id + ':' + e.uid + ':' + p.id;
        out.push({
          id: laneId,
          label: prefix + ' · ' + e.def.name + ' · ' + p.label,
          loopBars: autoBars(a.len),
          apply: this.songSetAutomationActive.bind(this, laneId),
          reset: this.songReleaseAutomation.bind(this, laneId)
        });
      }
    }
    return out;
  };

  FxRack.prototype.songSetAutomationActive = function (laneId, on) {
    var hit = this._findAuto(laneId);
    if (!hit || !hit.auto) return;
    var a = hit.auto;
    a.songForce = on ? true : false;
    if (!on) {
      a.rec = false;
      if (a.recBtn) a.recBtn.classList.remove('on');
      hit.entry.inst.set(hit.param.id, hit.entry.values[hit.param.id]);
      if (hit.entry.outEls && hit.entry.outEls[hit.param.id]) {
        hit.entry.outEls[hit.param.id].textContent = fmtVal(hit.param, hit.entry.values[hit.param.id]);
      }
    }
  };

  FxRack.prototype.songReleaseAutomation = function (laneId) {
    var hit = this._findAuto(laneId);
    if (!hit || !hit.auto) return;
    hit.auto.songForce = null;
    hit.auto.rec = false;
    if (hit.auto.recBtn) hit.auto.recBtn.classList.remove('on');
  };

  /* ---------------- rack UI ---------------- */
  FxRack.prototype.mountUI = function (root) {
    var self = this;
    var add = document.createElement('div');
    add.className = 'fx-add';
    var sel = document.createElement('select');
    Object.keys(window.FX_DEFS).forEach(function (key) {
      var opt = document.createElement('option');
      opt.value = key;
      opt.textContent = window.FX_DEFS[key].name;
      sel.appendChild(opt);
    });
    var btn = document.createElement('button');
    btn.textContent = '+';
    btn.title = 'Add effect';
    btn.addEventListener('click', function () { self.addFx(sel.value); });
    add.appendChild(sel); add.appendChild(btn);
    root.appendChild(add);
    this.listEl = document.createElement('div');
    this.listEl.className = 'fx-list';
    root.appendChild(this.listEl);
    this.fx.forEach(function (e) { self.buildCard(e); });
  };

  FxRack.prototype.buildCard = function (entry) {
    var self = this;
    var card = document.createElement('div');
    card.className = 'fx-card';
    var head = document.createElement('div');
    head.className = 'fx-head';
    head.innerHTML = '<span class="fx-name">' + entry.def.name + '</span>';
    var rm = document.createElement('button');
    rm.className = 'fx-remove';
    rm.textContent = '✕';
    rm.addEventListener('click', function () { self.removeFx(entry); });
    head.appendChild(rm);
    card.appendChild(head);

    entry.def.params.forEach(function (p) {
      if (p.type === 'select') {
        var srow = document.createElement('div');
        srow.className = 'fx-param';
        var slbl = document.createElement('span');
        slbl.textContent = p.label;
        var ssel = document.createElement('select');
        ssel.className = 'fx-sel';
        p.options.forEach(function (o) {
          var opt = document.createElement('option');
          opt.value = o[0]; opt.textContent = o[1];
          ssel.appendChild(opt);
        });
        ssel.value = p.def;
        ssel.addEventListener('change', function () {
          entry.values[p.id] = this.value;
          entry.inst.set(p.id, this.value);
        });
        srow.appendChild(slbl); srow.appendChild(ssel);
        srow.appendChild(document.createElement('span'));
        srow.appendChild(document.createElement('span'));
        card.appendChild(srow);
        return;
      }

      var row = document.createElement('div');
      row.className = 'fx-param';
      var lbl = document.createElement('span');
      lbl.textContent = p.label;
      var input = document.createElement('input');
      input.type = 'range';
      if (p.log) {
        input.min = Math.log(p.min); input.max = Math.log(p.max);
        input.step = (Math.log(p.max) - Math.log(p.min)) / 200;
        input.value = Math.log(p.def);
      } else {
        input.min = p.min; input.max = p.max;
        input.step = (p.max - p.min) / 200;
        input.value = p.def;
      }
      var val = document.createElement('span');
      val.className = 'val';
      val.textContent = fmtVal(p, p.def);
      entry.outEls[p.id] = val;
      input.addEventListener('input', function () {
        var v = parseFloat(this.value);
        if (p.log) v = Math.exp(v);
        entry.values[p.id] = v;
        entry.inst.set(p.id, v);
        val.textContent = fmtVal(p, v);
      });
      row.appendChild(lbl); row.appendChild(input); row.appendChild(val);

      var a = entry.autos[p.id];
      if (a) {
        var ab = document.createElement('button');
        ab.className = 'fx-auto-btn';
        ab.textContent = 'A';
        ab.title = 'Draw an automation loop for this parameter';
        row.appendChild(ab);
        card.appendChild(row);

        var arow = document.createElement('div');
        arow.className = 'fx-auto hidden';

        var bar = document.createElement('div');
        bar.className = 'fx-auto-bar';
        var lsel = document.createElement('select');
        lsel.title = 'Loop length';
        LEN_OPTS.forEach(function (o) {
          var op = document.createElement('option');
          op.value = o[0]; op.textContent = o[1];
          lsel.appendChild(op);
        });
        lsel.value = a.len;
        lsel.addEventListener('change', function () { a.len = this.value; });
        var flat = document.createElement('button');
        flat.textContent = 'flat';
        flat.title = 'Reset the curve to the current slider value';
        flat.addEventListener('click', function () {
          a.pts.fill(normOf(p, entry.values[p.id]));
          if (a.cctx) drawLane(a, -1);
        });
        var rec = document.createElement('button');
        rec.textContent = 'rec';
        rec.title = 'Record one automation cycle from slider movement';
        rec.addEventListener('click', function () {
          a.on = true;
          ab.classList.add('on');
          arow.classList.remove('hidden');
          val.classList.add('auto-live');
          if (!a.cctx) {
            canvas.width = canvas.clientWidth || 200;
            a.cctx = canvas.getContext('2d');
          }
          a.rec = !a.rec;
          if (a.rec) {
            var t = self.engine.transport;
            var beats = currentBeats(t);
            a.recStartBeat = beats;
            a.recLastIdx = -1;
            a.recLastNorm = normOf(p, entry.values[p.id]);
            rec.classList.add('on');
          } else {
            rec.classList.remove('on');
          }
          drawLane(a, -1);
        });
        a.recBtn = rec;
        bar.appendChild(lsel); bar.appendChild(flat);
        bar.appendChild(rec);
        arow.appendChild(bar);

        var canvas = document.createElement('canvas');
        canvas.className = 'fx-auto-lane';
        canvas.height = 46;
        arow.appendChild(canvas);
        a.canvas = canvas;

        // draw the curve by dragging across the lane
        var drawing = false, lastIdx = -1, lastNorm = 0;
        function paintAt(e) {
          var rect = canvas.getBoundingClientRect();
          var x = Math.min(Math.max(e.clientX - rect.left, 0), rect.width - 0.001);
          var y = Math.min(Math.max(e.clientY - rect.top, 0), rect.height);
          var idx = Math.round(x / rect.width * (AUTO_N - 1));
          var norm = 1 - y / rect.height;
          if (lastIdx >= 0 && idx !== lastIdx) {
            var lo = Math.min(idx, lastIdx), hi = Math.max(idx, lastIdx);
            for (var k = lo; k <= hi; k++) {
              var f2 = (k - lastIdx) / (idx - lastIdx);
              a.pts[k] = lastNorm + (norm - lastNorm) * f2;
            }
          } else {
            a.pts[idx] = norm;
          }
          lastIdx = idx; lastNorm = norm;
          drawLane(a, -1);
        }
        canvas.addEventListener('pointerdown', function (e) {
          drawing = true; lastIdx = -1; canvas.setPointerCapture(e.pointerId); paintAt(e);
        });
        canvas.addEventListener('pointermove', function (e) { if (drawing) paintAt(e); });
        canvas.addEventListener('pointerup', function () { drawing = false; lastIdx = -1; });
        canvas.addEventListener('pointercancel', function () { drawing = false; lastIdx = -1; });

        ab.addEventListener('click', function () {
          a.on = !a.on;
          if (!a.on) {
            a.rec = false;
            if (a.recBtn) a.recBtn.classList.remove('on');
            a.songForce = null;
          }
          ab.classList.toggle('on', a.on);
          arow.classList.toggle('hidden', !a.on);
          val.classList.toggle('auto-live', a.on);
          if (a.on) {
            canvas.width = canvas.clientWidth || 200;
            a.cctx = canvas.getContext('2d');
            drawLane(a, -1);
          } else {
            entry.inst.set(p.id, entry.values[p.id]);
            val.textContent = fmtVal(p, entry.values[p.id]);
          }
        });
        card.appendChild(arow);
      } else {
        row.appendChild(document.createElement('span'));
        card.appendChild(row);
      }
    });

    entry.card = card;
    this.listEl.appendChild(card);
  };

  window.FxRack = FxRack;
})();
