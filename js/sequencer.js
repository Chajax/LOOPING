/* MIDI sequencer: piano-roll pattern editor per loop channel. Patterns play out of
   the selected MIDI port; ⏺ REC LOOP runs the pattern once while the channel records
   the synth's audio, closing at exactly the pattern length. The pattern is stored as
   the loop's MIDI events (output muted by default — the audio already has the part). */
(function () {
  'use strict';

  var PITCH_MIN = 36, PITCH_MAX = 84;                 // C2..C6
  var ROWS = PITCH_MAX - PITCH_MIN + 1;
  var BLACK = { 1: 1, 3: 1, 6: 1, 8: 1, 10: 1 };

  var ui = null;
  var ed = null;        // open editor session { engine, midi, ch, chLabel, pattern, status }
  var noteDrag = null;  // { note, mode:'move'|'resize', startStep, startPitch, origStep, origPitch, origLen, moved, created }
  var internalSynth = null;   // PRIZM, for the "→ internal synth" target

  /* Measured MIDI→synth→audio-input round trip for bounce recordings (ms).
     Self-calibrates: each bounce measures the residual misalignment of the first
     note's audio and folds it in, so takes get tighter over time. */
  var bounceCompMs = 0;
  try { bounceCompMs = parseFloat(localStorage.getItem('looping-bounce-comp')) || 0; } catch (e) {}
  function saveBounceComp() {
    try { localStorage.setItem('looping-bounce-comp', String(Math.round(bounceCompMs * 10) / 10)); } catch (e) {}
  }

  /* pattern.chan: 0–15 = single MIDI channel, -1 = OMNI (broadcast on all 16) */
  function patternChans(pattern) {
    if (pattern.chan >= 0) return [pattern.chan];
    var all = [];
    for (var c = 0; c < 16; c++) all.push(c);
    return all;
  }
  var sess = null;      // active playback { mode:'preview'|'rec', startF, lenF, endF, schedFrom, closeSent }
  var pumpTimer = null;
  var rafOn = false;
  // step recording: play notes on a MIDI keyboard to enter them at the cursor
  var stepRec = { on: false, cursor: 0, held: [], entered: false };

  /* ---------------- pattern helpers ---------------- */
  function stepFrames(engine) { return engine.transport.barFrames() / 16; }

  function patternEvents(engine, pattern) {
    // -> [{ off(frames), data }] sorted, note-offs clamped inside the loop
    var sf = stepFrames(engine);
    var lenF = Math.round(pattern.bars * engine.transport.barFrames());
    var evs = [];
    var chans = patternChans(pattern);
    pattern.notes.forEach(function (n) {
      var on = Math.round(n.step * sf);
      var off = Math.min(lenF - 10, Math.round((n.step + n.len) * sf) - 10);
      if (on >= lenF) return;
      chans.forEach(function (c) {
        evs.push({ off: on, data: [0x90 | c, n.pitch, n.vel] });
        evs.push({ off: Math.max(on + 10, off), data: [0x80 | c, n.pitch, 0] });
      });
    });
    evs.sort(function (a, b) { return a.off - b.off; });
    return evs;
  }

  /* Best-effort conversion of a loop's captured MIDI events into pattern notes. */
  function eventsToNotes(engine, events) {
    var sf = stepFrames(engine);
    var open = {}, notes = [];
    events.forEach(function (e) {
      var hi = e.data[0] & 0xF0, pitch = e.data[1];
      var key = (e.data[0] & 0x0F) + ':' + pitch;
      if (hi === 0x90 && e.data[2] > 0) {
        open[key] = { off: e.off, vel: e.data[2] };
      } else if ((hi === 0x80 || hi === 0x90) && open[key]) {
        var step = Math.round(open[key].off / sf);
        var dup = notes.some(function (n) { return n.step === step && n.pitch === pitch; });
        if (!dup) {   // OMNI patterns carry the same note on all 16 channels — keep one
          notes.push({
            step: step,
            pitch: pitch,
            len: Math.max(1, Math.round((e.off - open[key].off) / sf)),
            vel: open[key].vel
          });
        }
        delete open[key];
      }
    });
    return notes;
  }

  function noteAt(pattern, step, pitch) {
    for (var i = 0; i < pattern.notes.length; i++) {
      var n = pattern.notes[i];
      if (n.pitch === pitch && step >= n.step && step < n.step + n.len) return n;
    }
    return null;
  }

  /* ---------------- UI ---------------- */
  function buildUI() {
    var overlay = document.createElement('div');
    overlay.id = 'seq-overlay';
    overlay.className = 'hidden';
    overlay.innerHTML =
      '<div class="editor-box seq-box">' +
        '<div class="editor-head">' +
          '<span class="editor-title seq-title">SEQ</span>' +
          '<span class="editor-info seq-info"></span>' +
          '<button class="ed-close seq-close" title="Close (pattern is kept on the channel)">✕</button>' +
        '</div>' +
        '<div class="editor-row">' +
          '<label class="seq-l">Bars <select class="seq-bars"><option>1</option><option selected>2</option><option>4</option><option>8</option></select></label>' +
          '<label class="seq-l">Ch <select class="seq-chan"></select></label>' +
          '<label class="seq-l">Out <select class="seq-target" title="Where this loop\'s MIDI plays">' +
            '<option value="ext">MIDI port</option><option value="int">PRIZM synth</option>' +
          '</select></label>' +
          '<label class="seq-l">Note <select class="seq-notelen">' +
            '<option value="1">1/16</option><option value="2" selected>1/8</option>' +
            '<option value="4">1/4</option><option value="8">1/2</option><option value="16">1 bar</option>' +
          '</select></label>' +
          '<label class="seq-l">Vel <input type="range" class="seq-vel" min="1" max="127" step="1" value="100"><span class="seq-vel-val">100</span></label>' +
          '<label class="chk seq-loopout" title="Keep sending the MIDI pattern every loop cycle after recording (the synth will double the recorded audio)">' +
            '<input type="checkbox"> loop MIDI out after rec</label>' +
          '<span class="seq-step-group">' +
            '<button class="seq-step" title="Step record: play notes on your MIDI keyboard to enter them at the cursor, one step at a time">STEP REC</button>' +
            '<button class="seq-back" title="Step back and delete the note(s) there">⟵</button>' +
            '<button class="seq-rest" title="Insert a rest (advance the cursor without a note)">REST</button>' +
          '</span>' +
        '</div>' +
        '<canvas class="seq-canvas" height="392"></canvas>' +
        '<div class="editor-row editor-foot">' +
          '<span class="ed-sel seq-hint">click = add · drag = move · right edge = resize · click note = delete · wheel = velocity</span>' +
          '<button class="seq-clear">CLEAR</button>' +
          '<button class="seq-save" title="Write the pattern into the loop\'s MIDI events without recording audio">SAVE MIDI</button>' +
          '<button class="seq-preview" title="Loop the pattern to the MIDI port (no recording)">PREVIEW</button>' +
          '<button class="seq-stop">STOP</button>' +
          '<button class="ed-apply seq-rec" title="Play the pattern once and record the synth into this loop channel">⏺ REC LOOP</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    var chanSel = overlay.querySelector('.seq-chan');
    var omni = document.createElement('option');
    omni.value = '-1';
    omni.textContent = 'OMNI';
    chanSel.appendChild(omni);
    for (var c = 1; c <= 16; c++) {
      var opt = document.createElement('option');
      opt.value = c - 1;
      opt.textContent = c;
      chanSel.appendChild(opt);
    }

    var canvas = overlay.querySelector('.seq-canvas');
    ui = {
      overlay: overlay,
      canvas: canvas,
      g: canvas.getContext('2d'),
      title: overlay.querySelector('.seq-title'),
      info: overlay.querySelector('.seq-info'),
      bars: overlay.querySelector('.seq-bars'),
      chan: chanSel,
      target: overlay.querySelector('.seq-target'),
      noteLen: overlay.querySelector('.seq-notelen'),
      vel: overlay.querySelector('.seq-vel'),
      velVal: overlay.querySelector('.seq-vel-val'),
      loopOut: overlay.querySelector('.seq-loopout input'),
      stepBtn: overlay.querySelector('.seq-step'),
      backBtn: overlay.querySelector('.seq-back'),
      restBtn: overlay.querySelector('.seq-rest')
    };

    overlay.querySelector('.seq-close').addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function (e) {
      if (e.code === 'Escape' && !overlay.classList.contains('hidden')) close();
    });

    ui.vel.addEventListener('input', function () { ui.velVal.textContent = this.value; });
    ui.bars.addEventListener('change', function () {
      if (!ed) return;
      ed.pattern.bars = parseInt(this.value, 10);
      render();
    });
    ui.chan.addEventListener('change', function () {
      if (ed) ed.pattern.chan = parseInt(this.value, 10);
    });
    ui.target.addEventListener('change', function () {
      if (!ed) return;
      ed.ch.midiTarget = this.value;
      if (this.value === 'int' && !internalSynth) ed.status('Internal synth unavailable.');
      else ed.status(this.value === 'int' ? 'This loop\'s MIDI plays the internal PRIZM synth.' : 'This loop\'s MIDI plays the external MIDI port.');
    });

    overlay.querySelector('.seq-clear').addEventListener('click', function () {
      if (!ed) return;
      ed.pattern.notes = [];
      render();
    });
    overlay.querySelector('.seq-save').addEventListener('click', saveMidi);
    overlay.querySelector('.seq-preview').addEventListener('click', startPreview);
    overlay.querySelector('.seq-stop').addEventListener('click', stopPlayback);
    overlay.querySelector('.seq-rec').addEventListener('click', startBounce);
    ui.stepBtn.addEventListener('click', toggleStepRec);
    ui.backBtn.addEventListener('click', function () { if (stepRec.on) stepBack(); });
    ui.restBtn.addEventListener('click', function () { if (stepRec.on) stepAdvance(); });

    function canvasPos(e) {
      var rect = canvas.getBoundingClientRect();
      var steps = ed.pattern.bars * 16;
      var fx = (e.clientX - rect.left) / rect.width * steps;
      return {
        stepF: fx,
        step: Math.floor(fx),
        pitch: PITCH_MAX - Math.floor((e.clientY - rect.top) / rect.height * ROWS)
      };
    }

    function onResizeZone(hit, stepF) {
      // right edge zone: last 30% of the note (at least half a step)
      return stepF > hit.step + hit.len - Math.max(0.5, hit.len * 0.3);
    }

    canvas.addEventListener('mousedown', function (e) {
      if (!ed) return;
      var steps = ed.pattern.bars * 16;
      var p = canvasPos(e);
      if (p.step < 0 || p.step >= steps || p.pitch < PITCH_MIN || p.pitch > PITCH_MAX) return;
      var hit = noteAt(ed.pattern, p.step, p.pitch);
      if (hit) {
        noteDrag = {
          note: hit, mode: onResizeZone(hit, p.stepF) ? 'resize' : 'move',
          startStep: p.step, startPitch: p.pitch,
          origStep: hit.step, origPitch: hit.pitch, origLen: hit.len,
          moved: false, created: false
        };
      } else {
        var n = {
          step: p.step, pitch: p.pitch,
          len: Math.min(parseInt(ui.noteLen.value, 10), steps - p.step),
          vel: parseInt(ui.vel.value, 10)
        };
        ed.pattern.notes.push(n);
        previewNote(p.pitch);
        // keep dragging right to draw the note longer while placing
        noteDrag = {
          note: n, mode: 'resize',
          startStep: p.step, startPitch: p.pitch,
          origStep: n.step, origPitch: n.pitch, origLen: n.len,
          moved: false, created: true
        };
      }
      render();
    });

    window.addEventListener('mousemove', function (e) {
      if (!ed) return;
      var steps = ed.pattern.bars * 16;
      if (noteDrag) {
        var p = canvasPos(e);
        var n = noteDrag.note;
        if (noteDrag.mode === 'move') {
          var ns = Math.max(0, Math.min(steps - n.len, noteDrag.origStep + (p.step - noteDrag.startStep)));
          var np = Math.max(PITCH_MIN, Math.min(PITCH_MAX, noteDrag.origPitch + (p.pitch - noteDrag.startPitch)));
          if (ns !== n.step || np !== n.pitch) {
            n.step = ns; n.pitch = np;
            noteDrag.moved = true;
            render();
          }
        } else {
          var nl = Math.max(1, Math.min(steps - n.step, Math.round(p.stepF - n.step + 0.5)));
          if (nl !== n.len) {
            n.len = nl;
            noteDrag.moved = true;
            render();
          }
        }
        return;
      }
      // hover cursor feedback
      var rect = canvas.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return;
      var hp = canvasPos(e);
      var hover = (hp.pitch >= PITCH_MIN && hp.pitch <= PITCH_MAX) ? noteAt(ed.pattern, hp.step, hp.pitch) : null;
      canvas.style.cursor = hover ? (onResizeZone(hover, hp.stepF) ? 'ew-resize' : 'grab') : 'crosshair';
    });

    window.addEventListener('mouseup', function () {
      if (!ed || !noteDrag) return;
      var d = noteDrag;
      noteDrag = null;
      if (!d.moved && !d.created && d.mode === 'move') {
        // plain click on a note: remove it
        ed.pattern.notes.splice(ed.pattern.notes.indexOf(d.note), 1);
      } else if (d.moved && d.mode === 'move' && d.note.pitch !== d.origPitch) {
        previewNote(d.note.pitch);
      }
      render();
    });

    canvas.addEventListener('wheel', function (e) {
      if (!ed) return;
      var p = canvasPos(e);
      var hit = (p.pitch >= PITCH_MIN && p.pitch <= PITCH_MAX) ? noteAt(ed.pattern, p.step, p.pitch) : null;
      if (!hit) return;
      e.preventDefault();
      hit.vel = Math.max(1, Math.min(127, hit.vel + (e.deltaY < 0 ? 5 : -5)));
      ui.velVal.textContent = hit.vel;
      render();
    }, { passive: false });

    // resizable editor: keep the canvas backing store matched to its display size
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(function () {
        if (!ed) return;
        var w = canvas.clientWidth, h = canvas.clientHeight;
        if (w && h && (w !== canvas.width || h !== canvas.height)) {
          canvas.width = w; canvas.height = h;
          render();
        }
      });
      ro.observe(canvas);
    }
  }

  function previewNote(pitch) {
    if (sess) return;
    var vel = parseInt(ui.vel.value, 10);
    if (ed.ch.midiTarget === 'int' && internalSynth) {
      var t = ed.engine.ctx.currentTime + 0.01;
      internalSynth.playScheduled(pitch, vel / 127, t, t + 0.3);
      return;
    }
    var out = ed.midi.output;
    if (!out) return;
    patternChans(ed.pattern).forEach(function (c) {
      out.send([0x90 | c, pitch, vel]);
      out.send([0x80 | c, pitch, 0], performance.now() + 150);
    });
  }

  /* ---------------- rendering ---------------- */
  function render() {
    var c = ui.canvas, g = ui.g;
    var W = c.width, H = c.height;
    var steps = ed.pattern.bars * 16;
    var sw = W / steps, rh = H / ROWS;
    g.clearRect(0, 0, W, H);

    for (var r = 0; r < ROWS; r++) {
      var pitch = PITCH_MAX - r;
      g.fillStyle = BLACK[pitch % 12] ? '#181b20' : '#1f232b';
      g.fillRect(0, r * rh, W, rh);
      if (pitch % 12 === 0) {                      // C rows
        g.fillStyle = 'rgba(77,163,255,0.10)';
        g.fillRect(0, r * rh, W, rh);
        g.fillStyle = '#8b93a5';
        g.font = '9px sans-serif';
        g.fillText('C' + (pitch / 12 - 1), 2, r * rh + rh - 1);
      }
    }
    for (var s = 0; s <= steps; s++) {
      g.strokeStyle = s % 16 === 0 ? 'rgba(216,220,230,0.35)' :
        s % 4 === 0 ? 'rgba(216,220,230,0.15)' : 'rgba(216,220,230,0.06)';
      g.beginPath();
      g.moveTo(s * sw + 0.5, 0); g.lineTo(s * sw + 0.5, H);
      g.stroke();
    }
    ed.pattern.notes.forEach(function (n) {
      var r2 = PITCH_MAX - n.pitch;
      var x = n.step * sw + 1, y = r2 * rh + 1;
      var w = n.len * sw - 2, h = rh - 2;
      g.globalAlpha = 0.35 + (n.vel / 127) * 0.65;   // velocity = brightness
      g.fillStyle = '#4da3ff';
      g.fillRect(x, y, w, h);
      g.globalAlpha = 1;
      g.fillStyle = 'rgba(255,255,255,0.45)';        // resize handle
      g.fillRect(x + w - 3, y, 2, h);
    });

    // step-record cursor
    if (stepRec.on) {
      var len = Math.min(parseInt(ui.noteLen.value, 10) || 1, steps - (stepRec.cursor % steps));
      var cx = (stepRec.cursor % steps) * sw;
      g.fillStyle = 'rgba(61,220,132,0.16)';
      g.fillRect(cx, 0, sw * len, H);
      g.strokeStyle = '#3ddc84';
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(cx + 1, 0); g.lineTo(cx + 1, H); g.stroke();
      g.lineWidth = 1;
    }

    ui.info.textContent = ed.pattern.bars + ' bar' + (ed.pattern.bars > 1 ? 's' : '') +
      ' · ' + ed.engine.transport.bpm.toFixed(1) + ' BPM · ' +
      ed.pattern.notes.length + ' notes · MIDI ch ' +
      (ed.pattern.chan < 0 ? 'OMNI' : ed.pattern.chan + 1) +
      (stepRec.on ? ' · STEP ' + (Math.floor(stepRec.cursor / 4) + 1) + '.' + (stepRec.cursor % 4 + 1) : '');
  }

  function playheadLoop() {
    if (!ed) { rafOn = false; return; }
    if (sess) {
      render();
      var t = ed.engine.transport;
      var nowF = t.nowFrame();
      var rel = nowF - sess.startF;
      if (rel >= 0) {
        var pos = sess.mode === 'rec' ? rel : rel % sess.lenF;
        if (pos <= sess.lenF) {
          var x = pos / sess.lenF * ui.canvas.width;
          var g = ui.g;
          g.strokeStyle = '#ffa229';
          g.lineWidth = 2;
          g.beginPath(); g.moveTo(x, 0); g.lineTo(x, ui.canvas.height); g.stroke();
          g.lineWidth = 1;
        }
      }
    }
    requestAnimationFrame(playheadLoop);
  }

  /* ---------------- playback / bounce ---------------- */
  function ensureTransport() {
    var eng = ed.engine, t = eng.transport;
    if (!t.running) {
      var f = Math.round(t.nowFrame() + 0.05 * t.sr);
      t.startAt(f);
      t.tempoLocked = true;
      if (eng.onTransportStart) eng.onTransportStart(f);
      return f;
    }
    t.tempoLocked = true;
    return t.nextBoundary('bar');
  }

  function endStepRec() {
    if (stepRec.on) { stepRec.on = false; ui.stepBtn.classList.remove('active'); }
  }

  function targetReady() {
    if (ed.ch.midiTarget === 'int') {
      if (!internalSynth) { ed.status('Internal synth unavailable.'); return false; }
      return true;
    }
    if (!ed.midi.output) { ed.status('Select a MIDI clock out port first.'); return false; }
    return true;
  }

  function startPreview() {
    if (!ed || sess) return;
    if (!targetReady()) return;
    endStepRec();
    var startF = ensureTransport();
    var lenF = Math.round(ed.pattern.bars * ed.engine.transport.barFrames());
    sess = { mode: 'preview', startF: startF, lenF: lenF, endF: Infinity, schedFrom: null };
    ed.status('Previewing pattern (looping until STOP).');
  }

  function startBounce() {
    if (!ed || sess) return;
    if (!targetReady()) return;
    if (ed.ch.state !== 'empty' || ed.ch.pendingAction) {
      ed.status('Loop ' + ed.chLabel + ' is not empty — CLEAR it first to record the pattern.');
      return;
    }
    if (!ed.pattern.notes.length) { ed.status('The pattern is empty.'); return; }
    endStepRec();
    var startF = ensureTransport();
    var lenF = Math.round(ed.pattern.bars * ed.engine.transport.barFrames());
    sess = { mode: 'rec', startF: startF, lenF: lenF, endF: startF + lenF, schedFrom: null, closeSent: false };
    var ch = ed.ch;
    var internal = ch.midiTarget === 'int' && internalSynth;
    // internal target: route PRIZM into the loop input so its audio is recorded
    if (internal) {
      sess.wasRouted = !!internalSynth.loopDelay;
      internalSynth.setLoopRoute(true);
    }
    // External synth: widen the capture window by the measured MIDI/synth round trip
    // so its late-arriving audio lands right. Internal synth has no such latency (its
    // loop-route delay already matches comp), so don't add it — that would shift the
    // audio early and leave silence at the end of the loop.
    var extraComp = internal ? 0 : Math.round(bounceCompMs / 1000 * ed.engine.ctx.sampleRate);
    ch.setComp(ed.engine.compFrames + extraComp);
    ch.sawNote = false; ch.lastMidiAbs = 0; ch.lastNoteOnAbs = 0;
    ch.pendingAction = 'record';
    ch.node.port.postMessage({ cmd: 'schedule', action: 'record', frame: startF, free: false });
    if (ch.onUpdate) ch.onUpdate();
    ed.status('Recording pattern into loop ' + ed.chLabel + ' (' + ed.pattern.bars + ' bars)…');
  }

  function stopPlayback() {
    if (!sess) return;
    flushNotes();
    if (sess.mode === 'rec' && ed && ed.ch.state !== 'playing') {
      ed.ch.stop();   // abort the take
      ed.ch.setComp(ed.engine.compFrames);
      if (ed.ch.midiTarget === 'int' && internalSynth && !sess.wasRouted) internalSynth.setLoopRoute(false);
      ed.status('Recording aborted.');
    }
    sess = null;
    if (ed) render();
  }

  /* After a bounce: measure where the first note's audio actually landed vs. where
     the pattern says it should be, rotate the loop into alignment (length and grid
     untouched), fold the residual into the stored calibration, re-fade the seam. */
  async function finalizeBounce(eng, ch, statusFn) {
    var sr = eng.ctx.sampleRate;
    ch.setComp(eng.compFrames);   // back to live-playing compensation
    var rotate = 0;
    try {
      var snap = await ch.requestSnapshot();
      if (snap.len && snap.bufL) {
        var L = new Float32Array(snap.bufL), R = new Float32Array(snap.bufR);
        var firstOn = null;
        for (var i = 0; i < ch.midiEvents.length; i++) {
          var d = ch.midiEvents[i].data;
          if ((d[0] & 0xF0) === 0x90 && d[2] > 0) { firstOn = ch.midiEvents[i].off; break; }
        }
        if (firstOn !== null) {
          var peak = 0;
          for (i = 0; i < L.length; i++) {
            var m = Math.max(Math.abs(L[i]), Math.abs(R[i]));
            if (m > peak) peak = m;
          }
          if (peak >= 0.003) {
            var thr = Math.max(0.003, peak * 0.02);
            var on = 0;
            while (on < L.length && Math.abs(L[on]) < thr && Math.abs(R[on]) < thr) on++;
            var shift = on - firstOn;
            // internal synth has no MIDI/synth latency to learn — align this take but
            // don't fold its (attack-only) residual into the external calibration
            var internal = ch.midiTarget === 'int';
            if (shift > 32 && shift < 0.35 * sr) {
              rotate = shift;
              if (!internal) {
                bounceCompMs = Math.min(500, bounceCompMs + shift / sr * 1000);
                saveBounceComp();
                if (statusFn) statusFn('Bounce aligned: compensated ' + Math.round(shift / sr * 1000) +
                  ' ms MIDI/synth latency (remembered for next takes).');
              }
            } else if (shift < -32 && shift > -0.05 * sr) {
              rotate = shift;
              if (!internal) {
                bounceCompMs = Math.max(0, bounceCompMs + shift / sr * 1000);
                saveBounceComp();
              }
            }
          }
        }
      }
    } catch (e) { /* fall through: still fade the seam */ }
    ch.node.port.postMessage({ cmd: 'rotate', frames: rotate });
  }

  function flushNotes() {
    if (!ed) return;
    if (ed.ch.midiTarget === 'int') { if (internalSynth) internalSynth.allOff(); return; }
    if (!ed.midi.output) return;
    var out = ed.midi.output;
    patternChans(ed.pattern).forEach(function (c) {
      out.send([0xB0 | c, 123, 0]);
      out.send([0xB0 | c, 64, 0]);
    });
  }

  function saveMidi() {
    if (!ed) return;
    if (ed.ch.state === 'empty') { ed.status('No loop on this channel yet — use ⏺ REC LOOP.'); return; }
    var evs = patternEvents(ed.engine, ed.pattern);
    var lenF = ed.ch.lenFrames || 1;
    evs.forEach(function (e) { e.off = ((e.off % lenF) + lenF) % lenF; });
    evs.sort(function (a, b) { return a.off - b.off; });
    ed.ch.midiEvents = evs;
    ed.ch.midiMute = false;
    if (ed.ch.onUpdate) ed.ch.onUpdate();
    ed.status('Pattern saved as loop ' + ed.chLabel + ' MIDI (' + evs.length + ' events, output on).');
  }

  /* Look-ahead pump: schedules pattern events; drives the bounce state machine. */
  function pump() {
    if (!ed || !sess) return;
    var eng = ed.engine, t = eng.transport;
    var sr = t.sr;
    var nowF = t.nowFrame();

    if (sess.mode === 'rec') {
      var ch = ed.ch;
      if (!sess.closeSent && ch.state === 'recording') {
        // no perfect pass: alignment + seam fade happen in finalizeBounce
        ch.closeWithLength(sess.lenF, { noTrim: true, noPerfect: true });
        sess.closeSent = true;
      }
      if (ch.state === 'playing') {
        // bounce complete: pattern becomes the loop's MIDI, muted by default
        if (ch.midiTarget === 'int' && internalSynth && !sess.wasRouted) internalSynth.setLoopRoute(false);
        ch.midiEvents = patternEvents(eng, ed.pattern);
        ch.midiMute = !ui.loopOut.checked;
        ch.seqPattern = ed.pattern;
        if (ch.onUpdate) ch.onUpdate();
        ed.status('Loop ' + ed.chLabel + ' recorded from the pattern (' +
          (ch.midiMute ? 'MIDI output muted — audio has the part' : 'MIDI output looping') + ').');
        finalizeBounce(eng, ch, ed.status);
        sess = null;
        render();
        return;
      }
    }

    var horizon = nowF + 0.15 * sr;
    var from = sess.schedFrom === null ? nowF : sess.schedFrom;
    emitNotes(from, horizon);
    sess.schedFrom = horizon;
  }

  /* Send the pattern's notes for [from, horizon] to the current target. */
  function emitNotes(from, horizon) {
    var eng = ed.engine, sr = eng.transport.sr;
    if (ed.ch.midiTarget === 'int' && internalSynth) {
      var sf = stepFrames(eng);
      ed.pattern.notes.forEach(function (n) {
        var on = Math.round(n.step * sf);
        var dur = Math.max(1, Math.round(n.len * sf));
        if (sess.mode === 'rec') {
          var absOn = sess.startF + on;
          if (absOn > from && absOn <= horizon && absOn < sess.endF) {
            internalSynth.playScheduled(n.pitch, n.vel / 127, absOn / sr, (absOn + dur) / sr);
          }
        } else {
          var k = Math.floor((from - sess.startF - on) / sess.lenF) + 1;
          if (k < 0) k = 0;
          for (var f = sess.startF + on + k * sess.lenF; f <= horizon; f += sess.lenF) {
            if (f > from) internalSynth.playScheduled(n.pitch, n.vel / 127, f / sr, (f + dur) / sr);
          }
        }
      });
      return;
    }
    var out = ed.midi.output;
    if (!out) return;
    var evs = patternEvents(eng, ed.pattern);
    evs.forEach(function (ev) {
      if (sess.mode === 'rec') {
        var absF = sess.startF + ev.off;
        if (absF > from && absF <= horizon && absF < sess.endF) {
          out.send(ev.data, Math.max(performance.now(), eng.frameToPerf(absF)));
        }
      } else {
        var k2 = Math.floor((from - sess.startF - ev.off) / sess.lenF) + 1;
        if (k2 < 0) k2 = 0;
        for (var f2 = sess.startF + ev.off + k2 * sess.lenF; f2 <= horizon; f2 += sess.lenF) {
          if (f2 > from) out.send(ev.data, Math.max(performance.now(), eng.frameToPerf(f2)));
        }
      }
    });
  }

  /* ---------------- step recording ---------------- */
  function toggleStepRec() {
    if (!ed) return;
    if (sess) { ed.status('Stop playback before step recording.'); return; }
    stepRec.on = !stepRec.on;
    ui.stepBtn.classList.toggle('active', stepRec.on);
    if (stepRec.on) {
      stepRec.cursor = 0; stepRec.held = []; stepRec.entered = false;
      if (!ed.midi.output) ed.status('Step record on — play notes on your MIDI keyboard. (No MIDI out selected, so you won\'t hear them.)');
      else ed.status('Step record on — play notes to enter them; REST skips, ⟵ deletes & backs up.');
    } else {
      ed.status('Step record off.');
    }
    render();
  }

  function stepLen() {
    return parseInt(ui.noteLen.value, 10) || 1;
  }

  function stepAdvance() {
    var steps = ed.pattern.bars * 16;
    stepRec.cursor = (stepRec.cursor + stepLen()) % steps;
    stepRec.entered = false;
    render();
  }

  function stepBack() {
    var steps = ed.pattern.bars * 16;
    stepRec.cursor = ((stepRec.cursor - stepLen()) % steps + steps) % steps;
    var cur = stepRec.cursor;
    ed.pattern.notes = ed.pattern.notes.filter(function (n) { return n.step !== cur; });
    stepRec.entered = false;
    render();
  }

  /* Incoming MIDI while step-recording. Returns true if it consumed the event. */
  function stepNoteOn(pitch, vel) {
    var steps = ed.pattern.bars * 16;
    var cur = stepRec.cursor % steps;
    var len = Math.min(stepLen(), steps - cur);
    // replace any existing note of this pitch at the cursor (re-press = overwrite)
    ed.pattern.notes = ed.pattern.notes.filter(function (n) {
      return !(n.step === cur && n.pitch === pitch);
    });
    ed.pattern.notes.push({ step: cur, pitch: pitch, len: len, vel: Math.max(1, Math.min(127, vel)) });
    if (stepRec.held.indexOf(pitch) < 0) stepRec.held.push(pitch);
    stepRec.entered = true;
    previewNote(pitch);
    render();
  }

  function stepNoteOff(pitch) {
    var i = stepRec.held.indexOf(pitch);
    if (i >= 0) stepRec.held.splice(i, 1);
    // all keys of this chord released -> advance to the next step
    if (stepRec.held.length === 0 && stepRec.entered) stepAdvance();
  }

  function handleMidi(data) {
    if (!ed || !stepRec.on || sess) return false;
    var hi = data[0] & 0xF0;
    if (hi === 0x90 && data[2] > 0) { stepNoteOn(data[1], data[2]); return true; }
    if (hi === 0x80 || (hi === 0x90 && data[2] === 0)) { stepNoteOff(data[1]); return true; }
    return false;
  }

  /* ---------------- entry ---------------- */
  function open(engine, midiMgr, ch, chLabel, statusFn) {
    if (!ui) buildUI();
    if (sess) { statusFn('Sequencer is busy on another channel — STOP it first.'); return; }
    if (!ch.seqPattern) {
      ch.seqPattern = {
        bars: 2,
        chan: 0,
        notes: []
      };
      if (ch.midiEvents.length) {
        ch.seqPattern.notes = eventsToNotes(engine, ch.midiEvents);
        if (ch.lenFrames > 0) {
          ch.seqPattern.bars = Math.max(1, Math.round(ch.lenFrames / engine.transport.barFrames()));
        }
        var st = ch.midiEvents[0] && ch.midiEvents[0].data[0];
        if (st !== undefined) ch.seqPattern.chan = st & 0x0F;
      }
    }
    ed = { engine: engine, midi: midiMgr, ch: ch, chLabel: chLabel, pattern: ch.seqPattern, status: statusFn };
    stepRec.on = false; stepRec.cursor = 0; stepRec.held = []; stepRec.entered = false;
    ui.stepBtn.classList.remove('active');
    ui.title.textContent = 'SEQ LOOP ' + chLabel;
    ui.bars.value = String(ed.pattern.bars);
    if (!ui.bars.value) { ui.bars.value = '2'; ed.pattern.bars = 2; }
    ui.chan.value = String(ed.pattern.chan);
    ui.target.value = ch.midiTarget || 'ext';
    ui.overlay.classList.remove('hidden');
    ui.canvas.width = ui.canvas.clientWidth || 900;
    ui.canvas.height = ui.canvas.clientHeight || 392;
    render();
    if (!pumpTimer) pumpTimer = setInterval(pump, 25);
    if (!rafOn) { rafOn = true; requestAnimationFrame(playheadLoop); }
  }

  function close() {
    if (sess && sess.mode === 'preview') { flushNotes(); sess = null; }
    // an in-flight bounce keeps running headless; pump() finishes it
    if (ed && !sess) ed = null;
    else if (ed && sess) {
      // keep ed alive for the pump until the bounce lands, but hide the UI
      var pending = ed;
      var iv = setInterval(function () {
        if (!sess) { if (ed === pending) ed = null; clearInterval(iv); }
      }, 200);
    }
    ui.overlay.classList.add('hidden');
  }

  window.MidiSequencer = {
    open: open, handleMidi: handleMidi,
    setSynth: function (synth) { internalSynth = synth; }
  };
})();
