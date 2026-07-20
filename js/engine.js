/* Audio engine: AudioWorklet looper, transport (musical grid), loop channels.
   Exposes window.Engine (singleton-style class instances created by app.js). */
(function () {
  'use strict';

  /* ---------------- worklet processor (runs on the audio thread) ----------------
     Loaded from a Blob URL so the whole app works from file:// too.
     Timing model:
       - "output clock"  = currentFrame (musical grid; playback position).
       - "input clock"   = currentFrame - comp (compensates round-trip latency so
         overdubs land where you heard them, not comp frames late).
     Actions are scheduled at absolute frames; block processing splits at action
     boundaries, so loop lengths are sample-accurate. */
  var WORKLET_SOURCE = [
    'class LooperProcessor extends AudioWorkletProcessor {',
    '  constructor(options) {',
    '    super();',
    '    var o = (options && options.processorOptions) || {};',
    '    this.comp = o.comp || 0;',
    '    this.state = "empty";',
    '    this.pending = null;',
    '    this.anchor = 0;',
    '    this.stopPos = 0;   // frozen playhead position while stopped (pause/resume)',
    '    this.oneShot = false;   // play once and stop instead of looping',
    '    this.len = 0;',
    '    this.bufL = null; this.bufR = null;',
    '    this.undoL = null; this.undoR = null;',
    '    this.recL = null; this.recR = null; this.recLen = 0;',
    '    this.recWinStart = Infinity; this.recWinEnd = Infinity;',
    '    this.writeMode = "set";',
    '    this.perfectTrim = false;',
    '    this.perfectAt = Infinity;  // input-clock frame after which the perfect pass may run',
    '    this.pitchRate = 1;          // 2^(semitones/12); granular playback when != 1',
    '    this.grain = 2 * Math.round(sampleRate * 0.04);',
    '    this.xfL = null; this.xfR = null;   // post-close tail for the seam crossfade',
    '    this.xfLen = 0; this.xfGot = 0; this.xfStart = Infinity;',
    '    this.maxFrames = sampleRate * 300;',
    '    this.blockCount = 0;',
    '    var self = this;',
    '    this.port.onmessage = function (e) { self.onMsg(e.data); };',
    '  }',
    '  onMsg(m) {',
    '    if (m.cmd === "schedule") {',
    '      this.pending = { action: m.action, frame: m.frame, free: !!m.free, len: m.len || 0,',
    '        perfect: !!m.perfect, perfectTrim: !!m.perfectTrim, anchor: m.anchor || 0 };',
    '    } else if (m.cmd === "clear") {',
    '      this.state = "empty"; this.pending = null; this.stopPos = 0;',
    '      this.bufL = this.bufR = this.undoL = this.undoR = null;',
    '      this.recL = this.recR = null; this.recLen = 0; this.len = 0;',
    '      this.recWinStart = this.recWinEnd = Infinity;',
    '      this.perfectAt = Infinity; this.resetXf();',
    '      this.sendState();',
    '    } else if (m.cmd === "snapshot") {',
    '      var bufL = this.bufL ? new Float32Array(this.bufL) : null;',
    '      var bufR = this.bufR ? new Float32Array(this.bufR) : null;',
    '      this.port.postMessage({',
    '        ev: "snapshot", reqId: m.reqId, state: this.state, len: this.len, anchor: this.anchor,',
    '        bufL: bufL ? bufL.buffer : null, bufR: bufR ? bufR.buffer : null',
    '      }, bufL && bufR ? [bufL.buffer, bufR.buffer] : []);',
    '    } else if (m.cmd === "load") {',
    '      this.bufL = new Float32Array(m.bufL);',
    '      this.bufR = new Float32Array(m.bufR);',
    '      this.len = this.bufL.length;',
    '      this.anchor = 0;',
    '      this.undoL = this.undoR = null;',
    '      this.recL = this.recR = null; this.recLen = 0;',
    '      this.recWinStart = this.recWinEnd = Infinity;',
    '      this.perfectAt = Infinity; this.resetXf();',
    '      this.pending = null;',
    '      this.state = "stopped"; this.stopPos = 0;',
    '      this.sendState();',
    '    } else if (m.cmd === "rotate") {',
    '      // shift loop content earlier by m.frames (mod length), then re-fade the seam;',
    '      // used to align MIDI-bounce recordings whose audio arrived late',
    '      if (this.bufL && this.len > 1) {',
    '        var sh = ((Math.round(m.frames) % this.len) + this.len) % this.len;',
    '        if (sh > 0) {',
    '          var rl = new Float32Array(this.len), rr = new Float32Array(this.len);',
    '          rl.set(this.bufL.subarray(sh)); rl.set(this.bufL.subarray(0, sh), this.len - sh);',
    '          rr.set(this.bufR.subarray(sh)); rr.set(this.bufR.subarray(0, sh), this.len - sh);',
    '          this.bufL = rl; this.bufR = rr;',
    '        }',
    '        this.seamFade();',
    '        this.undoL = this.undoR = null;',
    '        this.perfectAt = Infinity; this.resetXf();',
    '        this.sendState();',
    '      }',
    '    } else if (m.cmd === "replace") {',
    '      if (this.bufL && this.state !== "recording" && this.state !== "overdubbing") {',
    '        this.bufL = new Float32Array(m.bufL);',
    '        this.bufR = new Float32Array(m.bufR);',
    '        this.len = this.bufL.length;',
    '        this.anchor += (m.anchorDelta || 0);',
    '        this.undoL = this.undoR = null;',
    '        this.perfectAt = Infinity; this.resetXf();',
    '        this.sendState();',
    '      }',
    '    } else if (m.cmd === "undo") {',
    '      if (this.undoL && this.bufL && this.state !== "overdubbing") {',
    '        this.bufL.set(this.undoL); this.bufR.set(this.undoR);',
    '        this.undoL = this.undoR = null;',
    '        this.port.postMessage({ ev: "undone" });',
    '      }',
    '    } else if (m.cmd === "comp") {',
    '      this.comp = m.value;',
    '    } else if (m.cmd === "oneshot") {',
    '      this.oneShot = !!m.value;',
    '    } else if (m.cmd === "transpose") {',
    '      this.pitchRate = Math.pow(2, (m.value || 0) / 12);',
    '    }',
    '  }',
    '  pushRec(a, b) {',
    '    if (!this.recL) {',
    '      this.recL = new Float32Array(sampleRate * 8);',
    '      this.recR = new Float32Array(sampleRate * 8);',
    '      this.recLen = 0;',
    '    }',
    '    if (this.recLen >= this.recL.length) {',
    '      var nl = new Float32Array(this.recL.length * 2); nl.set(this.recL); this.recL = nl;',
    '      var nr = new Float32Array(this.recR.length * 2); nr.set(this.recR); this.recR = nr;',
    '    }',
    '    this.recL[this.recLen] = a; this.recR[this.recLen] = b; this.recLen++;',
    '  }',
    '  resetXf() { this.xfL = this.xfR = null; this.xfLen = 0; this.xfGot = 0; this.xfStart = Infinity; }',
    '  setupTail(startInputFrame) {',
    '    // capture ~15 ms of input past the loop end for a seamless wrap crossfade',
    '    this.xfLen = Math.min(Math.round(sampleRate * 0.015), Math.floor(this.len / 4));',
    '    if (this.xfLen < 4) { this.resetXf(); return; }',
    '    this.xfL = new Float32Array(this.xfLen);',
    '    this.xfR = new Float32Array(this.xfLen);',
    '    this.xfGot = 0; this.xfStart = startInputFrame;',
    '  }',
    '  apply(a, frame, opt) {',
    '    var free = opt.free, lenOverride = opt.len;',
    '    if (a === "record" && this.state === "empty") {',
    '      this.state = "recording";',
    '      this.anchor = frame;',
    '      this.recWinStart = frame; this.recWinEnd = Infinity;',
    '      this.writeMode = "set";',
    '      this.recL = null; this.recLen = 0;',
    '      this.resetXf();',
    '    } else if (a === "close" && this.state === "recording") {',
    '      var rl = frame - this.anchor;',
    '      if (lenOverride && lenOverride < rl) rl = lenOverride;  // retroactive close: trim trailing silence',
    '      if (rl < sampleRate * 0.15) return;',
    '      this.len = rl;',
    '      this.recWinEnd = this.anchor + rl;',
    '      this.bufL = new Float32Array(this.len);',
    '      this.bufR = new Float32Array(this.len);',
    '      var n = Math.min(this.recLen, this.len);',
    '      if (this.recL) {',
    '        this.bufL.set(this.recL.subarray(0, n));',
    '        this.bufR.set(this.recR.subarray(0, n));',
    '      }',
    '      this.recL = this.recR = null;',
    '      this.state = "playing";',
    '      if (opt.perfect) {',
    '        this.perfectTrim = opt.perfectTrim;',
    '        this.setupTail(this.recWinEnd);',
    '        this.perfectAt = this.recWinEnd + this.xfLen;',
    '      }',
    '    } else if (a === "overdub" && this.bufL) {',
    '      if (this.state === "overdubbing") return;',
    '      this.undoL = new Float32Array(this.bufL);',
    '      this.undoR = new Float32Array(this.bufR);',
    '      this.writeMode = "add";',
    '      this.recWinStart = frame; this.recWinEnd = Infinity;',
    '      // overdub from stopped resumes the frozen playhead too (top for free)',
    '      if (this.state === "stopped") this.anchor = free ? frame : frame - this.stopPos;',
    '      this.state = "overdubbing";',
    '    } else if (a === "play") {',
    '      if (this.state === "overdubbing") {',
    '        this.recWinEnd = frame; this.state = "playing";',
    '        if (opt.perfect) { this.perfectTrim = false; this.setupTail(frame); this.perfectAt = frame + this.xfLen; }',
    '      } else if (this.state === "stopped" && this.bufL) {',
    '        // pause semantics: resume from the frozen playhead (it did not advance',
    '        // while stopped); explicit anchors (import/render/song) take precedence',
    '        if (opt.anchor) this.anchor = opt.anchor;',
    '        else this.anchor = frame - this.stopPos;',
    '        this.state = "playing";',
    '      }',
    '    } else if (a === "retrigger") {',
    '      // song one-shot: (re)start from the top at this frame regardless of state',
    '      if (this.bufL) { this.anchor = opt.anchor || frame; this.stopPos = 0; this.state = "playing"; }',
    '    } else if (a === "stop") {',
    '      if (this.state === "recording") {',
    '        this.state = "empty"; this.recL = this.recR = null; this.recLen = 0;',
    '        this.recWinStart = this.recWinEnd = Infinity;',
    '      } else if (this.state === "overdubbing") {',
    '        this.stopPos = this.len > 0 ? ((frame - this.anchor) % this.len + this.len) % this.len : 0;',
    '        this.recWinEnd = frame; this.state = "stopped";',
    '        if (opt.perfect) { this.perfectTrim = false; this.setupTail(frame); this.perfectAt = frame + this.xfLen; }',
    '      } else if (this.state === "playing") {',
    '        // freeze the playhead where it stopped; play resumes from here',
    '        this.stopPos = this.len > 0 ? ((frame - this.anchor) % this.len + this.len) % this.len : 0;',
    '        this.state = "stopped";',
    '      }',
    '    }',
    '    this.sendState();',
    '  }',
    '  sendState(perfected) {',
    '    this.port.postMessage({ ev: "state", state: this.state, len: this.len, anchor: this.anchor,',
    '      perfecting: this.perfectAt !== Infinity, perfected: !!perfected });',
    '  }',
    '  doPerfect() {',
    '    if (!this.bufL || this.len < 1) { this.perfectTrim = false; return; }',
    '    if (this.perfectTrim) {',
    '      var peak = 0, i;',
    '      for (i = 0; i < this.len; i++) {',
    '        var m = Math.max(Math.abs(this.bufL[i]), Math.abs(this.bufR[i]));',
    '        if (m > peak) peak = m;',
    '      }',
    '      var thr = Math.max(0.003, peak * 0.02);',
    '      var idx = 0;',
    '      while (idx < this.len && Math.abs(this.bufL[idx]) < thr && Math.abs(this.bufR[idx]) < thr) idx++;',
    '      var start = Math.max(0, idx - Math.round(sampleRate * 0.005));',
    '      if (idx < this.len && start > 0 && this.len - start >= sampleRate * 0.15) {',
    '        this.bufL = this.bufL.slice(start);',
    '        this.bufR = this.bufR.slice(start);',
    '        this.anchor += start;',
    '        this.len -= start;',
    '        if (this.undoL) { this.undoL = null; this.undoR = null; }',
    '      }',
    '      this.perfectTrim = false;',
    '    }',
    '    if (this.xfL && this.xfGot > 4) {',
    '      // seamless wrap: blend the loop start with the captured post-end tail so',
    '      // buf[0] continues naturally from buf[len-1] (no fade-to-zero dip)',
    '      var F = Math.min(this.xfGot, Math.floor(this.len / 4));',
    '      for (var k = 0; k < F; k++) {',
    '        var w = 0.5 - 0.5 * Math.cos(Math.PI * k / F);',   // 0->1
    '        this.bufL[k] = this.bufL[k] * w + this.xfL[k] * (1 - w);',
    '        this.bufR[k] = this.bufR[k] * w + this.xfR[k] * (1 - w);',
    '      }',
    '      this.resetXf();',
    '    } else {',
    '      this.resetXf();',
    '      this.seamFade();',
    '    }',
    '  }',
    '  seamFade() {',
    '    if (!this.bufL || this.len < 2) return;',
    '    var F = Math.min(Math.round(sampleRate * 0.006), Math.floor(this.len / 8));',
    '    for (var k = 0; k < F; k++) {',
    '      var w = 0.5 - 0.5 * Math.cos(Math.PI * k / F);',
    '      this.bufL[k] *= w; this.bufR[k] *= w;',
    '      this.bufL[this.len - 1 - k] *= w; this.bufR[this.len - 1 - k] *= w;',
    '    }',
    '  }',
    '  run(inL, inR, outL, outR, from, to, blockStart) {',
    '    var st = this.state;',
    '    var playing = (st === "playing" || st === "overdubbing") && this.bufL && this.len > 0;',
    '    for (var j = from; j < to; j++) {',
    '      var frame = blockStart + j;',
    '      var inFrame = frame - this.comp;',
    '      var a = inL ? inL[j] : 0;',
    '      var b = inR ? inR[j] : a;',
    '      if (playing) {',
    '        var pos = frame - this.anchor;',
    '        if (pos >= 0 && !(this.oneShot && pos >= this.len)) {',
    '          pos = pos % this.len;',
    '          if (this.pitchRate === 1) {',
    '            outL[j] = this.bufL[pos]; outR[j] = this.bufR[pos];',
    '          } else {',
    '            // granular pitch shift: two overlapping triangle-windowed grain',
    '            // streams read the buffer at pitchRate while pos advances 1:1,',
    '            // so pitch changes but tempo/length stay locked to the grid',
    '            var G = this.grain < this.len ? this.grain : this.len;',
    '            var half = G * 0.5, aL = 0, aR = 0;',
    '            for (var s2 = 0; s2 < 2; s2++) {',
    '              var ph = (pos + s2 * half) % G;',
    '              var rp = (pos - ph) + ph * this.pitchRate;',
    '              var w = 1 - Math.abs(2 * ph / G - 1);',
    '              rp = rp % this.len; if (rp < 0) rp += this.len;',
    '              var i0 = Math.floor(rp), i1 = i0 + 1; if (i1 >= this.len) i1 = 0;',
    '              var fp = rp - i0;',
    '              aL += (this.bufL[i0] * (1 - fp) + this.bufL[i1] * fp) * w;',
    '              aR += (this.bufR[i0] * (1 - fp) + this.bufR[i1] * fp) * w;',
    '            }',
    '            outL[j] = aL; outR[j] = aR;',
    '          }',
    '        }',
    '      }',
    '      if (inFrame >= this.recWinStart && inFrame < this.recWinEnd) {',
    '        if (!this.bufL) {',
    '          if (this.recLen < this.maxFrames) this.pushRec(a, b);',
    '        } else {',
    '          var wp = inFrame - this.anchor;',
    '          if (wp >= 0) {',
    '            wp = wp % this.len;',
    '            if (this.writeMode === "set") { this.bufL[wp] = a; this.bufR[wp] = b; }',
    '            else { this.bufL[wp] += a; this.bufR[wp] += b; }',
    '          }',
    '        }',
    '      }',
    '      if (this.xfL && inFrame >= this.xfStart) {',
    '        var xi = inFrame - this.xfStart;',
    '        if (xi < this.xfLen) { this.xfL[xi] = a; this.xfR[xi] = b; if (xi + 1 > this.xfGot) this.xfGot = xi + 1; }',
    '      }',
    '    }',
    '  }',
    '  process(inputs, outputs) {',
    '    var input = inputs[0];',
    '    var inL = input && input[0] ? input[0] : null;',
    '    var inR = input && input[1] ? input[1] : inL;',
    '    var out = outputs[0];',
    '    var outL = out[0], outR = out[1] || out[0];',
    '    var N = outL.length;',
    '    var blockStart = currentFrame;',
    '    // run the deferred perfect pass once the latency-compensated tail has arrived',
    '    if (this.perfectAt !== Infinity && blockStart - this.comp >= this.perfectAt) {',
    '      this.perfectAt = Infinity;',
    '      this.doPerfect();',
    '      this.sendState(true);',
    '    }',
    '    var i = 0;',
    '    while (i < N) {',
    '      var end = N;',
    '      if (this.pending) {',
    '        var f = this.pending.frame;',
    '        if (f <= blockStart + i) {',
    '          var p = this.pending; this.pending = null;',
    '          this.apply(p.action, blockStart + i, p);',
    '          continue;',
    '        } else if (f < blockStart + N) {',
    '          end = f - blockStart;',
    '        }',
    '      }',
    '      this.run(inL, inR, outL, outR, i, end, blockStart);',
    '      i = end;',
    '    }',
    '    // one-shot: after a full pass has played, stop (reset to the top for replay)',
    '    if (this.oneShot && this.state === "playing" && this.len > 0 &&',
    '        currentFrame + N - this.anchor >= this.len) {',
    '      this.state = "stopped"; this.stopPos = 0;',
    '      this.sendState();',
    '    }',
    '    this.blockCount++;',
    '    if (this.blockCount % 10 === 0) {',
    '      var msg = { ev: "pos", state: this.state, pos: 0, sec: 0, loopSec: this.len / sampleRate };',
    '      if (this.len > 0) {',
    '        var pp = (currentFrame - this.anchor) % this.len; if (pp < 0) pp += this.len;',
    '        msg.pos = pp / this.len;',
    '      }',
    '      if (this.state === "recording") msg.sec = this.recLen / sampleRate;',
    '      this.port.postMessage(msg);',
    '    }',
    '    return true;',
    '  }',
    '}',
    'registerProcessor("looper-processor", LooperProcessor);',
    '',
    '// Latency calibration: emit a click, detect its loopback return; delay = round trip.',
    'class CalibProcessor extends AudioWorkletProcessor {',
    '  constructor() {',
    '    super();',
    '    this.state = "idle";',
    '    this.pulseLen = Math.max(1, Math.round(sampleRate * 0.0015));',
    '    this.preroll = Math.round(sampleRate * 0.18);',
    '    this.window = Math.round(sampleRate * 0.4);',
    '    this.guard = Math.round(sampleRate * 0.001);',
    '    this.threshold = 0.06;',
    '    this.maxTrials = 6;',
    '    this.results = [];',
    '    this.trial = 0;',
    '    var self = this;',
    '    this.port.onmessage = function (e) {',
    '      if (e.data.cmd === "start") {',
    '        self.threshold = e.data.threshold || 0.06;',
    '        self.maxTrials = e.data.trials || 6;',
    '        self.results = []; self.trial = 0; self.arm();',
    '      } else if (e.data.cmd === "stop") { self.state = "idle"; }',
    '    };',
    '  }',
    '  arm() {',
    '    this.emitFrame = currentFrame + this.preroll;',
    '    this.emitEnd = this.emitFrame + this.pulseLen;',
    '    this.detectStart = this.emitEnd + this.guard;',
    '    this.detectEnd = this.emitFrame + this.window;',
    '    this.detected = false; this.detectedDelay = 0;',
    '    this.state = "running";',
    '  }',
    '  process(inputs, outputs) {',
    '    var out = outputs[0]; var o0 = out[0]; var o1 = out[1] || out[0];',
    '    var inp = inputs[0]; var in0 = inp && inp[0] ? inp[0] : null;',
    '    var N = o0.length, z;',
    '    if (this.state === "running" && (this.detected || currentFrame >= this.detectEnd)) {',
    '      if (this.detected) this.results.push(this.detectedDelay);',
    '      this.trial++;',
    '      if (this.trial >= this.maxTrials) { this.finish(); }',
    '      else { this.arm(); }',
    '    }',
    '    if (this.state !== "running") { for (z = 0; z < N; z++) { o0[z] = 0; o1[z] = 0; } return true; }',
    '    for (var j = 0; j < N; j++) {',
    '      var f = currentFrame + j;',
    '      var s = (f >= this.emitFrame && f < this.emitEnd) ? 0.5 : 0;',
    '      o0[j] = s; o1[j] = s;',
    '      if (!this.detected && in0 && f >= this.detectStart && f < this.detectEnd) {',
    '        if (Math.abs(in0[j]) > this.threshold) { this.detected = true; this.detectedDelay = f - this.emitFrame; }',
    '      }',
    '    }',
    '    return true;',
    '  }',
    '  finish() {',
    '    this.state = "idle";',
    '    if (!this.results.length) { this.port.postMessage({ ev: "fail" }); return; }',
    '    var r = this.results.slice().sort(function (a, b) { return a - b; });',
    '    this.port.postMessage({ ev: "done", frames: r[Math.floor(r.length / 2)], all: this.results });',
    '  }',
    '}',
    'registerProcessor("calib-processor", CalibProcessor);'
  ].join('\n');

  /* ---------------- transport: musical grid + tempo ---------------- */
  function Transport(ctx) {
    this.ctx = ctx;
    this.sr = ctx.sampleRate;
    this.bpm = 120;
    this.running = false;
    this.origin = 0;          // audio frame of bar 1 beat 1
    this.tempoLocked = false; // true once loops depend on the grid
    this.onchange = null;
  }
  Transport.prototype.beatFrames = function () { return this.sr * 60 / this.bpm; };
  Transport.prototype.barFrames = function () { return this.beatFrames() * 4; };
  Transport.prototype.nowFrame = function () { return this.ctx.currentTime * this.sr; };
  Transport.prototype.startAt = function (frame) {
    this.origin = frame;
    this.running = true;
    if (this.onchange) this.onchange();
  };
  Transport.prototype.stop = function () {
    this.running = false;
    this.tempoLocked = false;
    if (this.onchange) this.onchange();
  };
  /* Next grid boundary strictly after "now + safety". Returns 0 for "as soon as possible". */
  Transport.prototype.nextBoundary = function (kind) {
    if (kind === 'off' || !this.running) return 0;
    var unit = kind === 'beat' ? this.beatFrames() : this.barFrames();
    var now = this.nowFrame() + 0.006 * this.sr;
    var k = Math.ceil((now - this.origin) / unit);
    return Math.round(this.origin + k * unit);
  };
  /* Current position for UI: { beatInBar, isDownbeat } */
  Transport.prototype.beatPhase = function () {
    if (!this.running) return null;
    var b = (this.nowFrame() - this.origin) / this.beatFrames();
    if (b < 0) return null;
    return { beat: Math.floor(b) % 4, phase: b - Math.floor(b) };
  };

  /* ---------------- loop channel ---------------- */
  var nextChannelId = 1;
  var nextSnapshotRequestId = 1;
  function LoopChannel(engine) {
    var self = this;
    this.engine = engine;
    this.id = nextChannelId++;
    this.state = 'empty';
    this.pendingAction = null;  // for UI "queued" indicator
    this.loopSec = 0;
    this.pos = 0;
    this.recSec = 0;
    this.hasUndo = false;
    this.quantOverride = 'global'; // per-loop quantize: 'global' | 'bar' | 'beat' | 'off'
    this.armed = false;         // start recording on first incoming MIDI note
    this.midiRec = false;       // capture incoming MIDI alongside the audio
    this.autoEnd = false;       // close the loop after MIDI goes silent while recording
    this.sawNote = false;       // a note-on arrived since recording started
    this.lastMidiAbs = 0;       // absolute frame of last MIDI activity while recording
    this.lastNoteOnAbs = 0;     // absolute frame of last note-on while recording
    this.midiEvents = [];       // { off: frames-from-loop-start, data: [st,d1,d2] }
    this.midiMute = false;      // suppress looped MIDI output (e.g. after a sequencer bounce)
    this.midiTarget = 'ext';    // 'ext' = external MIDI port, 'int' = internal PRIZM synth
    this.transpose = 0;         // semitones; audio is re-pitched (audiojs), MIDI notes shift with it
    this.origBuf = null;        // pristine (transpose 0) audio, cached to re-pitch from
    this._transposeToken = 0;   // guards out-of-order async re-pitch renders
    this.oneShot = false;       // play once and stop instead of looping (live + song)
    this.seqPattern = null;     // sequencer pattern for this channel { bars, chan, notes }
    this.pendingMidi = [];      // { f: absolute frame, data } captured while rec/overdub
    this.midiUndo = null;       // snapshot for one-level overdub undo
    this.anchorFrame = 0;
    this.lenFrames = 0;
    this.awaitPerfect = false;  // tempo-lock deferred until the perfect pass reports
    this.loadedNeedsAnchor = false; // imported loop: align to the bar grid on first play
    this.schedFrom = null;      // MIDI playback: absolute frame scheduled up to
    this.onUpdate = null;       // UI hook: full state refresh
    this.onPos = null;          // UI hook: position only

    var ctx = engine.ctx;
    this.node = new AudioWorkletNode(ctx, 'looper-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { comp: engine.compFrames }
    });
    this.gain = ctx.createGain();
    this.songGain = ctx.createGain();   // arrangement gate (1 = audible, scheduled by the song player)
    this.rack = new window.FxRack(engine);
    engine.inputNode.connect(this.node);
    this.node.connect(this.rack.input);
    this.rack.output.connect(this.gain);
    this.gain.connect(this.songGain);
    this.songGain.connect(engine.masterGain);

    this.node.port.onmessage = function (e) {
      var m = e.data;
      if (m.ev === 'state') {
        var prev = self.state;
        self.state = m.state;
        self.pendingAction = null;
        self.loopSec = m.len / engine.ctx.sampleRate;
        self.anchorFrame = m.anchor;
        self.lenFrames = m.len;
        // a new take or overdub replaces the audio → drop the transpose base
        if (m.state === 'recording' || (prev !== 'overdubbing' && m.state === 'overdubbing')) {
          self._clearTransposeBase();
        }
        if (prev === 'recording' && m.state === 'playing') {
          if (m.perfecting) {
            // perfect pass may still trim the start — wait for the corrected
            // length/anchor before locking tempo and placing MIDI events
            self.awaitPerfect = true;
          } else {
            self.finalizePendingMidi();
            engine.onLoopClosed(self, m.len, m.anchor);
          }
        }
        if (m.perfected && self.awaitPerfect) {
          self.awaitPerfect = false;
          self.finalizePendingMidi();
          engine.onLoopClosed(self, m.len, m.anchor);
        }
        if (prev !== 'overdubbing' && m.state === 'overdubbing') {
          self.midiUndo = self.midiEvents.slice();
          self.hasUndo = true;
        }
        if (prev === 'overdubbing' && m.state !== 'overdubbing') {
          self.finalizePendingMidi();
        }
        if (m.state === 'empty') {
          self.hasUndo = false;
          self.awaitPerfect = false;
          self.midiEvents = []; self.pendingMidi = []; self.midiUndo = null;
        }
        if (self.onUpdate) self.onUpdate();
      } else if (m.ev === 'pos') {
        self.pos = m.pos;
        self.recSec = m.sec;
        self.loopSec = m.loopSec || self.loopSec;
        if (self.onPos) self.onPos();
      } else if (m.ev === 'undone') {
        self.hasUndo = false;
        if (self.midiUndo) { self.midiEvents = self.midiUndo; self.midiUndo = null; }
        if (self.onUpdate) self.onUpdate();
      }
    };
  }

  LoopChannel.prototype.requestSnapshot = function () {
    var self = this;
    var reqId = nextSnapshotRequestId++;
    return new Promise(function (resolve) {
      var handler = function (e) {
        var m = e.data;
        if (!m || m.ev !== 'snapshot' || m.reqId !== reqId) return;
        self.node.port.removeEventListener('message', handler);
        resolve(m);
      };
      self.node.port.addEventListener('message', handler);
      if (self.node.port.start) self.node.port.start();
      self.node.port.postMessage({ cmd: 'snapshot', reqId: reqId });
    });
  };

  LoopChannel.prototype.schedule = function (action) {
    var eng = this.engine;
    var frame = eng.frameForAction(this, action);
    var q = eng.effQuantize(this);
    var free = q === 'off';
    if (action === 'record') {
      this.sawNote = false;
      this.lastMidiAbs = 0;
      this.lastNoteOnAbs = 0;
    }
    // kept even for immediate actions (until the worklet confirms) so MIDI capture
    // doesn't drop events arriving in the scheduling gap — e.g. the arm-trigger note
    this.pendingAction = action;
    var msg = { cmd: 'schedule', action: action, frame: frame, free: free };
    if (eng.perfectLoops) {
      if (action === 'close') {
        msg.perfect = true;
        // length may only change when it isn't grid-locked
        msg.perfectTrim = q === 'off' ||
          (eng.firstLoopSetsTempo && !eng.transport.tempoLocked);
      } else if ((action === 'play' || action === 'stop') && this.state === 'overdubbing') {
        msg.perfect = true;   // re-fade the seam after an overdub layer
      }
    }
    if (action === 'play' && this.loadedNeedsAnchor) {
      // first play of an imported loop: anchor it to the current bar grid
      var t2 = eng.transport;
      if (t2.running || frame > 0) {
        var bf = t2.barFrames();
        var base = frame > 0 ? frame :
          t2.origin + Math.floor((t2.nowFrame() - t2.origin) / bf) * bf;
        msg.anchor = Math.round(base);
      }
      this.loadedNeedsAnchor = false;
    }
    this.node.port.postMessage(msg);
    if (this.onUpdate) this.onUpdate();
  };

  /* The one big button: empty→record, recording→close, playing→overdub, overdubbing→play, stopped→play */
  LoopChannel.prototype.mainAction = function () {
    switch (this.pendingAction || this.state) {
      case 'empty': this.schedule('record'); break;
      case 'record':
      case 'recording': this.schedule('close'); break;
      case 'playing': this.schedule('overdub'); break;
      case 'overdub':
      case 'overdubbing': this.schedule('play'); break;
      case 'stopped': this.schedule('play'); break;
    }
  };
  LoopChannel.prototype.stop = function () {
    if (this.state === 'empty' && !this.pendingAction) return;
    this.schedule('stop');
  };
  LoopChannel.prototype.clear = function () {
    this.node.port.postMessage({ cmd: 'clear' });
    this.pendingAction = null;
    this.armed = false;
    this.midiEvents = []; this.pendingMidi = []; this.midiUndo = null;
    this._clearTransposeBase();
  };

  /* Close the loop at an exact length. If that point is still in the future the close
     is scheduled normally; if it already passed (auto-end after MIDI silence), the
     worklet closes retroactively and trims the trailing silence. */
  LoopChannel.prototype.closeWithLength = function (lenFrames, opts) {
    if (this.state !== 'recording') return;
    var eng = this.engine;
    var t = eng.transport;
    lenFrames = Math.round(lenFrames);
    var q = eng.effQuantize(this);
    var closeFrame = Math.round(this.anchorFrame + lenFrames);
    var msg = { cmd: 'schedule', action: 'close', free: q === 'off' };
    if (closeFrame > t.nowFrame() + 0.01 * t.sr) {
      msg.frame = closeFrame;
    } else {
      msg.frame = 0;
      msg.len = lenFrames;
    }
    if (eng.perfectLoops && !(opts && opts.noPerfect)) {
      msg.perfect = true;
      msg.perfectTrim = !(opts && opts.noTrim) && (q === 'off' ||
        (eng.firstLoopSetsTempo && !eng.transport.tempoLocked));
    }
    this.pendingAction = 'close';
    this.node.port.postMessage(msg);
    if (this.onUpdate) this.onUpdate();
  };

  /* Write an edited buffer into the live loop (waveform editor APPLY).
     anchorDelta = frames removed from / rotated past the loop start, so the
     remaining material keeps its position on the musical grid. */
  LoopChannel.prototype.applyEdit = function (L, R, anchorDelta, midiEvents) {
    if (this.state !== 'playing' && this.state !== 'stopped') return false;
    if (midiEvents) this.midiEvents = midiEvents;
    this.midiUndo = null;
    this.hasUndo = false;
    this.node.port.postMessage(
      { cmd: 'replace', bufL: L.buffer, bufR: R.buffer, anchorDelta: anchorDelta || 0 },
      [L.buffer, R.buffer]
    );
    this._clearTransposeBase();   // edited audio is the new un-pitched base
    return true;
  };

  /* Store an incoming MIDI event (absolute frame) while this channel is capturing.
     pendingAction === 'record' counts too, so the arm-trigger note itself is kept. */
  LoopChannel.prototype.captureMidi = function (data, absFrame) {
    if (!this.midiRec) return;
    var capturing = this.state === 'recording' || this.state === 'overdubbing' ||
      this.pendingAction === 'record' || this.pendingAction === 'overdub';
    if (!capturing) return;
    this.pendingMidi.push({ f: absFrame, data: data });
  };

  /* Convert captured absolute-frame events to loop offsets once anchor/len are known. */
  LoopChannel.prototype.finalizePendingMidi = function () {
    var anchor = this.anchorFrame, len = this.lenFrames;
    var slack = this.engine.ctx.sampleRate * 0.05;
    for (var i = 0; i < this.pendingMidi.length; i++) {
      var ev = this.pendingMidi[i];
      var off = ev.f - anchor;
      if (off < -slack) continue;      // stray event from well before the loop started
      if (off < 0) off = 0;            // arm-trigger note lands on the downbeat
      if (len > 0) off = off % len;
      this.midiEvents.push({ off: off, data: ev.data });
    }
    this.midiEvents.sort(function (a, b) { return a.off - b.off; });
    this.pendingMidi = [];
  };

  /* MIDI channels used by captured events (for all-notes-off flushing). */
  LoopChannel.prototype.usedMidiChannels = function () {
    var set = {};
    this.midiEvents.forEach(function (e) { set[e.data[0] & 0x0F] = true; });
    return Object.keys(set).map(Number);
  };
  LoopChannel.prototype.undo = function () {
    this.node.port.postMessage({ cmd: 'undo' });
    this._clearTransposeBase();
  };
  LoopChannel.prototype.setVolume = function (v) {
    this.gain.gain.setTargetAtTime(v, this.engine.ctx.currentTime, 0.01);
  };
  LoopChannel.prototype.setComp = function (frames) {
    this.node.port.postMessage({ cmd: 'comp', value: frames });
  };
  /* Transpose the loop. MIDI notes shift immediately (this.transpose). The audio is
     re-pitched with the audiojs pitch-shift phase vocoder (tempo-locked), pre-rendered
     from a cached pristine copy and swapped into the worklet. Falls back to the
     worklet's granular shifter if the pitch-shift lib isn't present. */
  LoopChannel.prototype.setTranspose = function (semitones) {
    var st = Math.max(-24, Math.min(24, Math.round(semitones) || 0));
    var prev = this.transpose;
    this.transpose = st;
    var PS = (typeof window !== 'undefined') && window.PitchShift;
    if (!PS) { this.node.port.postMessage({ cmd: 'transpose', value: st }); return st; }
    if (st !== prev) this._renderTranspose(st, prev);
    return st;
  };

  /* Drop the cached pristine buffer and reset transpose to 0 — used whenever the
     loop's content is replaced by something other than a re-pitch (new take,
     overdub, edit, undo), so the current worklet buffer becomes the new base. */
  LoopChannel.prototype._clearTransposeBase = function () {
    this.origBuf = null;
    this._transposeToken++;
    this.transpose = 0;
  };

  LoopChannel.prototype._renderTranspose = function (st, prev) {
    var self = this, PS = window.PitchShift;
    if (this.state !== 'playing' && this.state !== 'stopped') return;
    var token = ++this._transposeToken;
    var have = (this.origBuf && prev !== 0) ? Promise.resolve(this.origBuf)
      : this.requestSnapshot().then(function (snap) {
          if (!snap.len || !snap.bufL) return null;
          self.origBuf = { L: new Float32Array(snap.bufL), R: new Float32Array(snap.bufR) };
          return self.origBuf;
        });
    have.then(function (orig) {
      if (token !== self._transposeToken || !orig) return;   // superseded or no audio
      var L, R;
      if (st === 0) {
        L = new Float32Array(orig.L); R = new Float32Array(orig.R);
        self.origBuf = null;
      } else {
        var res = PS.shift(orig.L, orig.R, st, self.engine.ctx.sampleRate);
        L = res.L; R = res.R;
      }
      self.node.port.postMessage({ cmd: 'replace', bufL: L.buffer, bufR: R.buffer, anchorDelta: 0 },
        [L.buffer, R.buffer]);
    });
  };
  LoopChannel.prototype.setOneShot = function (on) {
    this.oneShot = !!on;
    this.node.port.postMessage({ cmd: 'oneshot', value: this.oneShot });
  };
  /* Song one-shot: (re)start the loop from the top at an explicit frame, regardless
     of its current state (used at each contiguous block start in the arrangement). */
  LoopChannel.prototype.songOneShotAt = function (frame) {
    this.pendingAction = 'play';
    this.node.port.postMessage({ cmd: 'schedule', action: 'retrigger', frame: frame, anchor: frame });
    if (this.onUpdate) this.onUpdate();
  };

  LoopChannel.prototype.destroy = function () {
    this.node.port.postMessage({ cmd: 'clear' });
    try { this.engine.inputNode.disconnect(this.node); } catch (e) {}
    this.node.disconnect();
    this.rack.dispose();
    this.gain.disconnect();
    this.songGain.disconnect();
  };

  /* ---------------- engine ---------------- */
  function Engine() {
    this.ctx = null;
    this.transport = null;
    this.channels = [];
    this.quantize = 'bar';
    this.firstLoopSetsTempo = true;
    this.perfectLoops = true; // auto-trim leading silence + de-click loop seams
    this.autoEndSec = 2;      // MIDI-silence timeout for channels with AUTO enabled
    this.compFrames = 0;
    this.inputNode = null;    // all channel worklets read from here
    this.monitorGain = null;
    this.masterGain = null;
    this.mediaStream = null;
    this.sourceNode = null;
    this.onTempoLocked = null;   // (bpm) -> void
    this.onTransportStart = null; // (originFrame) -> void
  }

  Engine.prototype.init = async function () {
    if (typeof AudioContext === 'undefined') {
      throw new Error('Web Audio is not supported in this browser.');
    }
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    if (!this.ctx.audioWorklet) {
      throw new Error('AudioWorklet unavailable — this usually means the page was opened over plain http. Use https.');
    }
    await this.ctx.resume();
    var blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' });
    var url = URL.createObjectURL(blob);
    await this.ctx.audioWorklet.addModule(url);

    this.transport = new Transport(this.ctx);
    this.inputNode = this.ctx.createGain();
    this.masterGain = this.ctx.createGain();
    this.monitorGain = this.ctx.createGain();
    this.monitorGain.gain.value = 0;
    this.inputNode.connect(this.monitorGain);
    this.monitorGain.connect(this.masterGain);
    this.masterGain.connect(this.ctx.destination);

    // default latency compensation guess: output latency + ~10 ms input
    var outLat = this.ctx.outputLatency || this.ctx.baseLatency || 0;
    this.compFrames = Math.round((outLat + 0.010) * this.ctx.sampleRate);
  };

  Engine.prototype.openInput = async function (deviceId) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Microphone API unavailable (https required).');
    }
    var preferredAudio = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: { ideal: 2 }   // use both interface inputs as a stereo pair
    };
    var tries = [];
    if (deviceId) {
      tries.push({ audio: Object.assign({ deviceId: { exact: deviceId } }, preferredAudio) });
      tries.push({ audio: { deviceId: { exact: deviceId } } });
      tries.push({ audio: { deviceId: { ideal: deviceId } } });
    }
    tries.push({ audio: preferredAudio });
    tries.push({ audio: true });   // broad fallback for browsers (notably iPadOS/WebKit)

    var stream = null;
    var lastErr = null;
    for (var i = 0; i < tries.length; i++) {
      try {
        stream = await navigator.mediaDevices.getUserMedia(tries[i]);
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!stream) throw lastErr || new Error('Could not open microphone input.');
    if (this.sourceNode) { this.sourceNode.disconnect(); }
    if (this.mediaStream) { this.mediaStream.getTracks().forEach(function (t) { t.stop(); }); }
    this.mediaStream = stream;
    this.sourceNode = this.ctx.createMediaStreamSource(stream);
    this.sourceNode.connect(this.inputNode);
    var track = stream.getAudioTracks()[0];
    var settings = track && track.getSettings ? track.getSettings() : {};
    this.inputChannels = settings.channelCount || this.sourceNode.channelCount || 1;
    return stream;
  };

  Engine.prototype.setMonitor = function (on) {
    this.monitorGain.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.01);
  };
  Engine.prototype.setMasterVolume = function (v) {
    this.masterGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
  };
  /* Measure round-trip latency by looping a click back through the input. Needs a
     loopback (interface output patched to its input, or mic near the speaker).
     Calls onResult({ ms, frames }) or ({ fail:true }). */
  Engine.prototype.calibrateLatency = function (opts, onResult) {
    var ctx = this.ctx, self = this;
    var node;
    try {
      node = new AudioWorkletNode(ctx, 'calib-processor', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2]
      });
    } catch (e) { onResult({ fail: true, error: 'worklet: ' + e.message }); return; }
    var prevMonitor = this.monitorGain.gain.value;
    this.monitorGain.gain.setValueAtTime(0, ctx.currentTime);   // avoid a feedback path
    this.inputNode.connect(node);
    node.connect(ctx.destination);
    var done = false;
    var cleanup = function () {
      if (done) return; done = true;
      try { self.inputNode.disconnect(node); } catch (e) {}
      try { node.disconnect(); } catch (e) {}
      self.monitorGain.gain.setValueAtTime(prevMonitor, ctx.currentTime);
    };
    node.port.onmessage = function (e) {
      var m = e.data;
      if (m.ev === 'done') {
        cleanup();
        var frames = m.frames;
        var ms = frames / ctx.sampleRate * 1000;
        onResult({ frames: frames, ms: ms, all: m.all });
      } else if (m.ev === 'fail') {
        cleanup();
        onResult({ fail: true });
      }
    };
    setTimeout(function () { if (!done) { cleanup(); onResult({ fail: true, error: 'timeout' }); } }, 6000);
    node.port.postMessage({ cmd: 'start', trials: (opts && opts.trials) || 6, threshold: (opts && opts.threshold) || 0.06 });
  };

  Engine.prototype.setComp = function (ms) {
    this.compFrames = Math.round(ms / 1000 * this.ctx.sampleRate);
    this.channels.forEach(function (c) { c.setComp(this.compFrames); }, this);
  };

  Engine.prototype.addChannel = function () {
    var ch = new LoopChannel(this);
    this.channels.push(ch);
    return ch;
  };
  Engine.prototype.removeChannel = function (ch) {
    var i = this.channels.indexOf(ch);
    if (i < 0) return;
    this.channels.splice(i, 1);
    ch.destroy();
  };
  Engine.prototype.stopAll = function () {
    this.channels.forEach(function (c) { c.stop(); });
  };
  /* Resume every stopped loop at one common frame (a shared downbeat). Each loop
     resumes from its frozen playhead, so loops that were stopped together come
     back still aligned with each other; freshly loaded loops start from the top. */
  Engine.prototype.playAllAt = function (frame) {
    this.channels.forEach(function (c) {
      if (c.state !== 'stopped') return;
      var msg = { cmd: 'schedule', action: 'play', frame: frame, free: false };
      if (c.loadedNeedsAnchor) {
        msg.anchor = frame;
        c.loadedNeedsAnchor = false;
      }
      c.pendingAction = 'play';
      c.node.port.postMessage(msg);
      if (c.onUpdate) c.onUpdate();
    });
  };
  /* Play one channel for the song arranger: anchor explicitly so the loop's top
     lands on the pass start — arrangement blocks always show the loop from its
     beginning, regardless of where its playhead froze. */
  LoopChannel.prototype.songPlayAt = function (frame) {
    if (this.state !== 'stopped') return;
    this.loadedNeedsAnchor = false;
    this.pendingAction = 'play';
    this.node.port.postMessage({ cmd: 'schedule', action: 'play', frame: frame, free: false, anchor: frame });
    if (this.onUpdate) this.onUpdate();
  };
  Engine.prototype.resetAll = function () {
    this.channels.forEach(function (c) { c.clear(); });
    this.transport.stop();
  };

  /* Effective quantize for a channel: its own override, else the global setting. */
  Engine.prototype.effQuantize = function (channel) {
    if (channel && channel.quantOverride && channel.quantOverride !== 'global') {
      return channel.quantOverride;
    }
    return this.quantize;
  };

  /* Decide the absolute frame at which an action should fire (0 = asap). */
  Engine.prototype.frameForAction = function (channel, action) {
    var t = this.transport;
    var q = this.effQuantize(channel);
    if (action === 'record') {
      // first loop in "sets tempo" mode records free
      if (this.firstLoopSetsTempo && !t.tempoLocked) return 0;
      if (!t.running) {
        var f = Math.round(t.nowFrame() + 0.01 * t.sr);
        t.startAt(f);
        t.tempoLocked = true;
        if (this.onTransportStart) this.onTransportStart(f);
        return f;
      }
      return t.nextBoundary(q);
    }
    if (action === 'close' && this.firstLoopSetsTempo && !t.tempoLocked) return 0;
    if (action === 'play' && !t.running) {
      // playing an imported loop can be what starts the clock
      var f2 = Math.round(t.nowFrame() + 0.01 * t.sr);
      t.startAt(f2);
      t.tempoLocked = true;
      if (this.onTransportStart) this.onTransportStart(f2);
      return f2;
    }
    return t.nextBoundary(q);
  };

  /* Called when a channel's loop closes (recording -> playing). */
  Engine.prototype.onLoopClosed = function (channel, lenFrames, anchorFrame) {
    var t = this.transport;
    if (this.firstLoopSetsTempo && !t.tempoLocked) {
      var sec = lenFrames / t.sr;
      var best = null;
      [1, 2, 4, 8, 16].forEach(function (bars) {
        var bpm = bars * 4 * 60 / sec;
        var score = Math.abs(Math.log(bpm / 115));
        if (bpm < 50 || bpm > 220) score += 10;
        if (!best || score < best.score) best = { bpm: bpm, score: score };
      });
      t.bpm = Math.round(best.bpm * 10) / 10;
      t.startAt(anchorFrame);
      t.tempoLocked = true;
      if (this.onTempoLocked) this.onTempoLocked(t.bpm, anchorFrame);
    }
  };

  /* Map a performance.now() timestamp to an audio frame (for capturing MIDI input). */
  Engine.prototype.perfToFrame = function (perf) {
    var ctx = this.ctx;
    var ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
    if (ts && ts.contextTime !== undefined && ts.performanceTime !== undefined) {
      return (ts.contextTime + (perf - ts.performanceTime) / 1000) * ctx.sampleRate;
    }
    return (ctx.currentTime + (perf - performance.now()) / 1000) * ctx.sampleRate;
  };

  /* Map an audio frame to a performance.now() timestamp (for Web MIDI scheduling). */
  Engine.prototype.frameToPerf = function (frame) {
    var ctx = this.ctx;
    var ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
    if (ts && ts.contextTime !== undefined && ts.performanceTime !== undefined) {
      return ts.performanceTime + (frame / ctx.sampleRate - ts.contextTime) * 1000;
    }
    return performance.now() + (frame / ctx.sampleRate - ctx.currentTime) * 1000;
  };

  window.LooperEngine = Engine;
})();
