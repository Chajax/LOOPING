/* UI wiring: channel strips, transport display, MIDI learn, keyboard shortcuts. */
(function () {
  'use strict';

  var engine = null;   // constructed on power-on so a failed script load is reportable
  var midi = null;
  var drums = null;
  var bass = null;
  var prizm = null;
  var strips = [];           // parallel to engine.channels: { ch, root, els }
  var RING_C = 2 * Math.PI * 50;

  var $ = function (id) { return document.getElementById(id); };
  var status = function (msg) { $('status-text').textContent = msg; };
  /* On the power screen the status bar is hidden — errors must show there instead. */
  var powerMsg = function (msg) { $('power-msg').textContent = msg; };

  window.addEventListener('error', function (e) {
    if (!$('power-overlay').classList.contains('hidden')) {
      powerMsg('Script error: ' + (e.message || 'unknown') + (e.filename ? ' (' + e.filename.split('/').pop() + ')' : ''));
    }
  });

  /* ---------------- boot ---------------- */
  $('power-btn').addEventListener('click', async function () {
    $('power-btn').disabled = true;
    powerMsg('Starting audio engine…');
    try {
      if (!window.LooperEngine) throw new Error('engine.js failed to load — check the browser console.');
      if (!window.isSecureContext) {
        throw new Error('This page is not running in a secure context (https). Microphone, MIDI and the audio engine are unavailable — open the site via https://');
      }
      engine = new window.LooperEngine();
      await engine.init();
    } catch (e) {
      powerMsg('Audio init failed: ' + e.message);
      $('power-btn').disabled = false;
      return;
    }

    try {
      powerMsg('Requesting MIDI access — answer the browser prompt if one appears…');
      midi = new window.MidiManager(engine);
      // don't hang forever on a silenced/ignored permission prompt
      var midiOk = await Promise.race([
        midi.init(),
        new Promise(function (res) { setTimeout(function () { res(false); }, 8000); })
      ]);

      drums = new window.DrumMachine(engine);
      drums.mountUI($('drum-grid'));
      wireDrums();

      bass = new window.Bass303(engine);
      bass.mountUI($('bass-grid'));
      wireBass();

      prizm = new window.Prizm(engine);
      prizm.buildUI($('prizm-panel'), $('prizm-ui'));
      wirePrizm();
      wireSong();
      window.MidiSequencer.setSynth(prizm);   // "→ internal synth" target

      drums.fxRack = attachInstrumentFx(drums.out, 'drums-fx', 'drums-fx-btn');
      bass.fxRack = attachInstrumentFx(bass.out, 'bass-fx', 'bass-fx-btn');
      drums.bankUI = buildPatternBank('drum-bank', drums, 'Drum');
      bass.bankUI = buildPatternBank('bass-bank', bass, '303');
      prizm.fxRack = attachInstrumentFx(prizm.out, 'prizm-fx', 'prizm-fx-btn');
      prizm.routeTap = prizm.fxRack.output;   // → looper records the FX'd signal

      powerMsg('Requesting microphone access — answer the browser prompt…');
      try {
        await engine.openInput();
      } catch (e) {
        status('Microphone access denied — looping needs an audio input. ' + e.message);
      }
      powerMsg('');
    } catch (e) {
      powerMsg('Startup failed: ' + e.message);
      $('power-btn').disabled = false;
      return;
    }

    await populateInputs();
    populateMidiOutputs(midiOk);
    wireTopbar();
    wireMidi();
    wireKeyboard();

    $('comp-input').value = Math.round(engine.compFrames / engine.ctx.sampleRate * 1000);

    $('power-overlay').classList.add('hidden');
    ['topbar', 'channels', 'add-channel', 'statusbar'].forEach(function (id) {
      $(id).classList.remove('hidden');
    });

    addChannel();
    addChannel();
    var inMode = engine.inputChannels >= 2 ? 'stereo in' : 'mono in';
    status(midiOk ? 'Ready (' + inMode + '). Pick a MIDI clock output, hit a loop button.' :
      'Ready (' + inMode + '; Web MIDI unavailable — clock out and MIDI learn disabled).');
    requestAnimationFrame(beatLoop);
    setInterval(midiLoopPump, 25);
    setInterval(autoEndWatch, 100);
    setInterval(function () { drums.pump(); bass.pump(); }, 25);
  });

  /* ---------------- top bar ---------------- */
  async function populateInputs() {
    var sel = $('input-select');
    sel.innerHTML = '';
    try {
      var devices = await navigator.mediaDevices.enumerateDevices();
      devices.filter(function (d) { return d.kind === 'audioinput'; }).forEach(function (d, i) {
        var opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || ('Input ' + (i + 1));
        sel.appendChild(opt);
      });
    } catch (e) {}
  }

  function populateMidiOutputs(midiOk) {
    var sel = $('midiout-select');
    while (sel.options.length > 1) sel.remove(1);
    if (!midiOk) { sel.disabled = true; return; }
    midi.getOutputs().forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o.id;
      opt.textContent = o.name;
      sel.appendChild(opt);
    });
  }

  function wireTopbar() {
    $('input-select').addEventListener('change', async function () {
      try {
        await engine.openInput(this.value);
        status('Audio input switched (' + (engine.inputChannels >= 2 ? 'stereo' : 'mono') + ').');
      } catch (e) { status('Could not open input: ' + e.message); }
    });

    $('monitor-toggle').addEventListener('change', function () {
      engine.setMonitor(this.checked);
    });

    $('master-vol').addEventListener('input', function () {
      engine.setMasterVolume(parseFloat(this.value));
    });

    $('bpm-input').addEventListener('change', function () {
      var v = parseFloat(this.value);
      if (!isFinite(v) || v < 40 || v > 240) return;
      engine.transport.bpm = v;
    });

    $('quantize-select').addEventListener('change', function () {
      engine.quantize = this.value;
    });

    $('first-loop-tempo').addEventListener('change', function () {
      engine.firstLoopSetsTempo = this.checked;
    });

    $('perfect-loops').addEventListener('change', function () {
      engine.perfectLoops = this.checked;
    });

    $('comp-input').addEventListener('change', function () {
      var v = parseFloat(this.value);
      if (isFinite(v) && v >= 0) engine.setComp(v);
    });

    $('autoend-input').addEventListener('change', function () {
      var v = parseFloat(this.value);
      if (isFinite(v) && v >= 0.3) engine.autoEndSec = v;
    });

    $('calibrate-btn').addEventListener('click', function () {
      var btn = this;
      if (btn.disabled) return;
      btn.disabled = true;
      var prev = btn.textContent;
      btn.textContent = '…';
      status('Calibrating latency — playing test clicks. Patch output→input (loopback) or hold the mic to the speaker.');
      engine.calibrateLatency({}, function (res) {
        btn.disabled = false;
        btn.textContent = prev;
        if (res.fail) {
          status('Calibration failed — no click detected. Set up a loopback (output→input, or mic near speaker) and try again.' +
            (res.error ? ' (' + res.error + ')' : ''));
          return;
        }
        var ms = Math.max(0, Math.min(200, Math.round(res.ms)));
        engine.setComp(ms);
        $('comp-input').value = ms;
        var spread = res.all && res.all.length > 1 ?
          (Math.max.apply(null, res.all) - Math.min.apply(null, res.all)) / engine.ctx.sampleRate * 1000 : 0;
        status('Calibrated: round-trip latency ' + ms + ' ms (Comp set)' +
          (spread > 3 ? ' — readings varied ±' + Math.round(spread / 2) + ' ms, re-run for a tighter result.' : '.'));
      });
    });

    $('midiout-select').addEventListener('change', function () {
      midi.setOutput(this.value);
      status(this.value ? 'MIDI clock output: ' + this.options[this.selectedIndex].text : 'MIDI clock output off.');
      if (engine.transport.running && this.value) midi.startClock(engine.transport.origin);
    });

    $('playall-btn').addEventListener('click', wrapMappable(function () {
      playEverything();
    }));

    $('stopall-btn').addEventListener('click', wrapMappable(function () {
      stopEverything();
    }));

    $('export-btn').addEventListener('click', wrapMappable(function () {
      window.LoopExport.exportLoops(engine, strips, status).catch(function (e) {
        status('Export failed: ' + e.message);
      });
      status('Exporting loops...');
    }));

    $('import-btn').addEventListener('click', function () { $('import-file').click(); });
    $('import-file').addEventListener('change', async function () {
      if (!this.files.length) return;
      var picked = Array.from(this.files);
      this.value = '';
      status('Importing…');
      try {
        var res = await window.LoopImport.importFiles(engine, picked, function () {
          return addChannel().ch;
        }, status);
        if (res.bpmRestored) {
          $('bpm-input').value = engine.transport.bpm;
          status('Imported ' + res.tracks + ' loop(s), tempo restored to ' + engine.transport.bpm + ' BPM. Press play on a loop to start.');
        } else {
          status('Imported ' + res.tracks + ' loop(s)' +
            (res.bpm && res.bpm !== engine.transport.bpm ? ' (export was ' + res.bpm + ' BPM, current grid is locked)' : '') +
            '. Press play on a loop to start.');
        }
      } catch (e) {
        status('Import failed: ' + e.message);
      }
    });

    $('reset-btn').addEventListener('click', function () {
      if (window.SongArranger && window.SongArranger.isPlaying()) window.SongArranger.stop();
      engine.resetAll();
      midi.stopClock();
      if (drums) {
        drums.enabled = false;
        $('drums-toggle').classList.remove('active');
      }
      if (bass) {
        bass.enabled = false;
        bass.silence();
        $('bass-toggle').classList.remove('active');
      }
      if (prizm) prizm.allOff();
      $('bpm-input').disabled = false;
      status('Reset: loops cleared, tempo unlocked, clock stopped.');
      strips.forEach(function (s) { refreshStrip(s); });
    });

    $('midi-learn-btn').addEventListener('click', function () {
      document.body.classList.toggle('learn-mode');
      this.classList.toggle('active');
      if (!document.body.classList.contains('learn-mode')) {
        midi.disarm();
        clearArmed();
        status('MIDI learn off.');
      } else {
        status('MIDI learn: click a control, then press/turn something on your controller.');
      }
    });

    engine.onTransportStart = function (originFrame) {
      $('bpm-input').disabled = true;
      midi.startClock(originFrame);
    };
    engine.onTempoLocked = function (bpm, originFrame) {
      $('bpm-input').value = bpm;
      $('bpm-input').disabled = true;
      midi.startClock(originFrame);
      status('First loop closed — tempo locked to ' + bpm + ' BPM, MIDI clock started.');
    };
  }

  /* ---------------- drums ---------------- */
  function toggleDrums() {
    drums.enabled = !drums.enabled;
    $('drums-toggle').classList.toggle('active', drums.enabled);
    if (drums.enabled) {
      var t = engine.transport;
      if (!t.running) {
        // drums can be the thing that starts the clock (locks the current BPM)
        var f = Math.round(t.nowFrame() + 0.02 * t.sr);
        t.startAt(f);
        t.tempoLocked = true;
        $('bpm-input').disabled = true;
        midi.startClock(f);
        status('Drums started the clock at ' + t.bpm + ' BPM.');
      } else {
        status('Drums on.');
      }
      $('drum-panel').classList.remove('hidden');
    } else {
      status('Drums off.');
    }
  }

  function wireDrums() {
    $('drums-btn').addEventListener('click', function () {
      $('drum-panel').classList.toggle('hidden');
    });
    $('drums-toggle').addEventListener('click', wrapMappable(function () { toggleDrums(); }));
    $('drums-vol').addEventListener('input', function () {
      drums.setVolume(parseFloat(this.value));
    });
    $('drums-clear').addEventListener('click', function () {
      drums.clearPattern();
      status('Drum pattern cleared.');
    });

    $('drum-add-voice').addEventListener('click', function () {
      var type = $('drum-add-type').value;
      drums.addSynthRow(type);
      status('Added a ' + $('drum-add-type').selectedOptions[0].text + ' row.');
    });

    $('drum-add-sample').addEventListener('click', function () {
      $('drum-sample-file').click();
    });
    $('drum-sample-file').addEventListener('change', async function () {
      var files = Array.from(this.files);
      this.value = '';
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        try {
          var audio = await engine.ctx.decodeAudioData(await f.arrayBuffer());
          drums.addSampleRow(f.name.replace(/\.[^.]+$/, ''), audio);
          status('Added sample row "' + f.name + '" (' + audio.duration.toFixed(2) + 's).');
        } catch (e) {
          status('Could not decode "' + f.name + '": ' + e.message);
        }
      }
    });
  }

  /* ---------------- TB-303 bass ---------------- */
  function toggleBass() {
    bass.enabled = !bass.enabled;
    $('bass-toggle').classList.toggle('active', bass.enabled);
    if (bass.enabled) {
      var t = engine.transport;
      if (!t.running) {
        var f = Math.round(t.nowFrame() + 0.02 * t.sr);
        t.startAt(f);
        t.tempoLocked = true;
        $('bpm-input').disabled = true;
        midi.startClock(f);
        status('303 started the clock at ' + t.bpm + ' BPM.');
      } else {
        status('303 on.');
      }
      $('bass-panel').classList.remove('hidden');
    } else {
      status('303 off.');
    }
  }

  function wireBass() {
    $('bass-btn').addEventListener('click', function () {
      $('bass-panel').classList.toggle('hidden');
    });
    $('bass-toggle').addEventListener('click', wrapMappable(function () { toggleBass(); }));
    $('bass-vol').addEventListener('input', function () { bass.setVolume(parseFloat(this.value)); });
    $('bass-wave').addEventListener('change', function () { bass.setWave(this.value); });
    $('bass-cutoff').addEventListener('input', function () { bass.cutoff = parseFloat(this.value); });
    $('bass-reso').addEventListener('input', function () { bass.setReso(parseFloat(this.value)); });
    $('bass-env').addEventListener('input', function () { bass.envMod = parseFloat(this.value); });
    $('bass-decay').addEventListener('input', function () { bass.decay = parseFloat(this.value); });
    $('bass-clear').addEventListener('click', function () {
      bass.clearPattern();
      status('303 pattern cleared.');
    });
  }

  /* Insert an FxRack between an instrument's output and the master bus. */
  function attachInstrumentFx(sourceNode, containerId, btnId) {
    var rack = new window.FxRack(engine);
    var gate = engine.ctx.createGain();   // song-arrangement gate
    sourceNode.disconnect();
    sourceNode.connect(rack.input);
    rack.output.connect(gate);
    gate.connect(engine.masterGain);
    rack.mountUI($(containerId));
    $(btnId).addEventListener('click', function () {
      $(containerId).classList.toggle('hidden');
      this.classList.toggle('active', !$(containerId).classList.contains('hidden'));
    });
    rack.songGate = gate;
    return rack;
  }

  function slotName(i) { return i < 26 ? String.fromCharCode(65 + i) : String(i + 1); }

  /* Build a dynamic pattern-bank selector for an instrument (drums / 303):
     one button per pattern slot plus a "+" to add new patterns on demand. */
  function buildPatternBank(containerId, inst, label) {
    var el = $(containerId);
    function render() {
      el.innerHTML = '';
      inst.patterns.forEach(function (p, i) {
        var b = document.createElement('button');
        b.className = 'pat-slot' + (i === inst.curSlot ? ' active' : '') +
          (i === inst.curSlot || inst.slotHasContent(i) ? ' has' : '');
        b.textContent = slotName(i);
        b.addEventListener('click', function () {
          inst.switchSlot(i);
          render();
          status(label + ' pattern ' + slotName(i) + '.');
        });
        el.appendChild(b);
      });
      var add = document.createElement('button');
      add.className = 'pat-add';
      add.textContent = '+';
      add.title = 'Add a new empty pattern';
      add.addEventListener('click', function () {
        inst.addSlot();
        render();
        status(label + ' pattern ' + slotName(inst.curSlot) + ' added.');
      });
      el.appendChild(add);
    }
    render();
    return { render: render };
  }

  /* ---------------- song arranger ---------------- */
  function setDrumsOn(on) {
    drums.enabled = on;
    $('drums-toggle').classList.toggle('active', on);
  }
  function setBassOn(on) {
    bass.enabled = on;
    if (!on) bass.silence();
    $('bass-toggle').classList.toggle('active', on);
  }
  function songContext() {
    return {
      engine: engine, drums: drums, bass: bass,
      drumsGate: drums.fxRack.songGate,
      bassGate: bass.fxRack.songGate,
      loopTracks: function () {
        return strips
          .filter(function (s) { return s.ch.lenFrames > 0 && (s.ch.state === 'playing' || s.ch.state === 'stopped'); })
          .map(function (s) { return { id: s.ch.id, label: 'LOOP ' + (strips.indexOf(s) + 1), gate: s.ch.songGain, ch: s.ch }; });
      },
      automationTracks: function () {
        var out = [];
        strips.forEach(function (s, i) {
          out = out.concat(s.ch.rack.songAutomationTracks('LOOP ' + (i + 1)));
        });
        out = out.concat(drums.fxRack.songAutomationTracks('DRUMS'));
        out = out.concat(bass.fxRack.songAutomationTracks('303'));
        out = out.concat(prizm.fxRack.songAutomationTracks('PRIZM'));
        return out;
      },
      setDrums: setDrumsOn,
      setBass: setBassOn,
      status: status
    };
  }
  function wireSong() {
    $('song-btn').addEventListener('click', function () {
      window.SongArranger.toggle(songContext());
    });
  }

  /* ---------------- PRIZM synth ---------------- */
  function wirePrizm() {
    $('prizm-btn').addEventListener('click', function () {
      $('prizm-panel').classList.toggle('hidden');
    });
    $('prizm-midi-in').addEventListener('change', function () {
      prizm.midiIn = this.checked;
      if (!this.checked) prizm.allOff();
    });
    $('prizm-to-looper').addEventListener('change', function () {
      prizm.setLoopRoute(this.checked);
      status(this.checked ?
        'PRIZM routed into the loop input bus — loop channels now record it.' :
        'PRIZM plays to the master output only.');
    });
    $('prizm-vol').addEventListener('input', function () {
      prizm.setVolume(parseFloat(this.value));
    });
  }

  /* ---------------- stop all / play all (loops + 808 + 303) ---------------- */
  function stopEverything() {
    if (window.SongArranger && window.SongArranger.isPlaying()) window.SongArranger.stop();
    engine.stopAll();
    midi.sendStop();
    if (drums.enabled) {
      drums.enabled = false;
      $('drums-toggle').classList.remove('active');
    }
    if (bass.enabled) {
      bass.enabled = false;
      bass.silence();
      $('bass-toggle').classList.remove('active');
    }
    status('All stopped — loops, drums, 303 (clock keeps running).');
  }

  function drumsHavePattern() {
    return drums.hasPattern();
  }
  function bassHasPattern() {
    return bass.pattern.some(function (st) { return st.pitch !== null; });
  }

  /* Start everything that has something to play — together, on one downbeat.
     Clock stopped: everything starts now, aligned. Clock running: everything
     (stopped loops, 808, 303) comes in at the next bar, so the whole arrangement
     drops as one. */
  function playEverything() {
    var t = engine.transport;
    var wantLoops = engine.channels.some(function (c) { return c.state === 'stopped'; });
    var wantDrums = !drums.enabled && drumsHavePattern();
    var wantBass = !bass.enabled && bassHasPattern();
    if (!wantLoops && !wantDrums && !wantBass) { status('Nothing to play.'); return; }

    var f;
    if (!t.running) {
      f = Math.round(t.nowFrame() + 0.015 * t.sr);
      t.startAt(f);
      t.tempoLocked = true;
      $('bpm-input').disabled = true;
      midi.startClock(f);
    } else {
      f = t.nextBoundary('bar');
    }

    var started = [];
    if (wantLoops) { engine.playAllAt(f); started.push('loops'); }
    if (wantDrums) {
      drums.enabled = true;
      drums.schedFrom = f - 1;   // pump schedules strictly after schedFrom: downbeat step included
      $('drums-toggle').classList.add('active');
      started.push('drums');
    }
    if (wantBass) {
      bass.enabled = true;
      bass.schedFrom = f - 1;
      $('bass-toggle').classList.add('active');
      started.push('303');
    }
    var waitMs = (f - t.nowFrame()) / t.sr * 1000;
    status('Playing ' + started.join(' + ') + (waitMs > 100 ? ' together at the next bar.' : ' together.'));
  }

  /* ---------------- MIDI learn plumbing ---------------- */
  function clearArmed() {
    document.querySelectorAll('.learn-armed').forEach(function (el) {
      el.classList.remove('learn-armed');
    });
  }

  /* In learn mode, clicking a mappable control arms it instead of triggering it. */
  function wrapMappable(handler) {
    return function (ev) {
      if (document.body.classList.contains('learn-mode')) {
        var el = ev.currentTarget;
        var actionId = el.getAttribute('data-mappable');
        if (actionId) {
          clearArmed();
          el.classList.add('learn-armed');
          midi.arm(actionId);
          status('Armed "' + actionId + '" — send a MIDI note or CC to bind.');
        }
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      handler.call(this, ev);
    };
  }

  function wireMidi() {
    midi.onLearned = function (key, actionId) {
      clearArmed();
      status('Bound ' + key + ' → ' + actionId + '.');
    };
    midi.onClockState = function (on) {
      $('clock-led').classList.toggle('on', on);
    };
    midi.dispatch = function (actionId, value) {
      var parts = actionId.split(':');
      if (parts[0] === 'global') {
        if (parts[1] === 'stopAll') stopEverything();
        else if (parts[1] === 'addChannel') addChannel();
        else if (parts[1] === 'drums') toggleDrums();
        else if (parts[1] === 'bass') toggleBass();
        else if (parts[1] === 'playAll') playEverything();
        else if (parts[1] === 'exportLoops') {
          window.LoopExport.exportLoops(engine, strips, status).catch(function (e) {
            status('Export failed: ' + e.message);
          });
        }
        return;
      }
      var idx = parseInt(parts[1], 10) - 1;
      var ch = engine.channels[idx];
      if (!ch) return;
      switch (parts[2]) {
        case 'main': ch.mainAction(); break;
        case 'stop': ch.stop(); break;
        case 'clear': ch.clear(); break;
        case 'undo': ch.undo(); break;
        case 'arm':
          ch.armed = !ch.armed;
          if (strips[idx]) refreshStrip(strips[idx]);
          break;
        case 'auto':
          ch.autoEnd = !ch.autoEnd;
          if (strips[idx]) refreshStrip(strips[idx]);
          break;
        case 'vol':
          if (value !== null) {
            ch.setVolume(value * 1.5);
            var strip = strips[idx];
            if (strip) strip.els.vol.value = value * 1.5;
          }
          break;
      }
    };

    /* Performance MIDI (unmapped notes/CCs): arm-trigger + per-channel capture. */
    midi.onRaw = function (data, timeStamp) {
      var frame = engine.perfToFrame(timeStamp) - engine.compFrames;
      var isNoteOn = (data[0] & 0xF0) === 0x90 && data[2] > 0;
      if (prizm && prizm.midiIn) {
        var hiP = data[0] & 0xF0;
        if (isNoteOn) prizm.noteOn(data[1], data[2] / 127);
        else if (hiP === 0x80 || hiP === 0x90) prizm.noteOff(data[1]);
        else if (hiP === 0xB0 && data[1] === 123) prizm.allOff();
      }
      // step recording in an open sequencer consumes notes (skip arm-trigger/capture)
      if (window.MidiSequencer && window.MidiSequencer.handleMidi(data)) return;
      if (isNoteOn) {
        strips.forEach(function (s, i) {
          var c = s.ch;
          if (c.armed && c.state === 'empty' && !c.pendingAction) {
            c.armed = false;
            c.mainAction();
            status('MIDI note triggered recording on loop ' + (i + 1) + '.');
          }
        });
      }
      engine.channels.forEach(function (c) {
        if (c.state === 'recording' || c.pendingAction === 'record') {
          c.lastMidiAbs = frame;
          if (isNoteOn) { c.lastNoteOnAbs = frame; c.sawNote = true; }
        }
        c.captureMidi(data, frame);
      });
    };
  }

  /* AUTO-END: while recording, close the loop once MIDI input has been silent for
     the configured time. The close is retroactive — the loop ends at the last note
     (rounded up to the quantize grid when a tempo grid exists), silence trimmed. */
  function autoEndWatch() {
    if (!engine.ctx) return;
    var sr = engine.ctx.sampleRate;
    var nowF = engine.ctx.currentTime * sr;
    var idleFrames = engine.autoEndSec * sr;
    strips.forEach(function (s, i) {
      var ch = s.ch;
      if (!ch.autoEnd || ch.state !== 'recording' || ch.pendingAction === 'close') return;
      if (!ch.sawNote || nowF - ch.lastMidiAbs < idleFrames) return;
      var t = engine.transport;
      var len;
      var q = engine.effQuantize(ch);
      if (t.tempoLocked && q !== 'off') {
        var unit = q === 'beat' ? t.beatFrames() : t.barFrames();
        len = Math.ceil((ch.lastNoteOnAbs - ch.anchorFrame + 0.03 * sr) / unit) * unit;
      } else {
        len = ch.lastMidiAbs - ch.anchorFrame;
      }
      if (len < 0.2 * sr) return;
      ch.closeWithLength(len);
      status('Loop ' + (i + 1) + ' auto-closed after MIDI silence.');
    });
  }

  /* ---------------- MIDI loop playback ----------------
     Look-ahead scheduler: sends each channel's captured events to the MIDI output,
     repeating every loop cycle, phase-locked via the channel's anchor frame. */
  function flushNotes(ch) {
    if (ch.midiTarget === 'int') { if (prizm) prizm.allOff(); return; }
    if (!midi || !midi.output) return;
    ch.usedMidiChannels().forEach(function (c) {
      midi.output.send([0xB0 | c, 123, 0]);  // all notes off
      midi.output.send([0xB0 | c, 64, 0]);   // sustain off
    });
  }

  /* Pair a channel's note-on/off events into notes (for internal-synth scheduling). */
  function loopNotePairs(ch) {
    var open = {}, notes = [];
    ch.midiEvents.forEach(function (ev) {
      var hi = ev.data[0] & 0xF0, pitch = ev.data[1];
      if (hi === 0x90 && ev.data[2] > 0) open[pitch] = { on: ev.off, vel: ev.data[2] };
      else if ((hi === 0x80 || hi === 0x90) && open[pitch] !== undefined) {
        notes.push({ on: open[pitch].on, off: ev.off, pitch: pitch, vel: open[pitch].vel });
        delete open[pitch];
      }
    });
    Object.keys(open).forEach(function (p) {   // still-open: close at loop end
      notes.push({ on: open[p].on, off: ch.lenFrames, pitch: parseInt(p, 10), vel: open[p].vel });
    });
    return notes;
  }

  function midiLoopPump() {
    if (!engine.ctx) return;
    var sr = engine.ctx.sampleRate;
    var nowF = engine.ctx.currentTime * sr;
    var horizon = nowF + 0.2 * sr;
    strips.forEach(function (s) {
      var ch = s.ch;
      var internal = ch.midiTarget === 'int';
      var sink = internal ? prizm : (midi && midi.output);
      var active = (ch.state === 'playing' || ch.state === 'overdubbing') &&
        ch.lenFrames > 0 && ch.midiEvents.length > 0 && sink && !ch.midiMute;
      if (!active) {
        if (ch.schedFrom !== null) { flushNotes(ch); ch.schedFrom = null; }
        return;
      }
      var from = (ch.schedFrom === null || ch.schedFrom < nowF) ? nowF : ch.schedFrom;
      var anchor = ch.anchorFrame, len = ch.lenFrames;
      if (internal) {
        loopNotePairs(ch).forEach(function (n) {
          var pitch = Math.max(0, Math.min(127, n.pitch + (ch.transpose || 0)));
          var dur = n.off - n.on; if (dur <= 0) dur += len;
          var k = Math.floor((from - anchor - n.on) / len) + 1;
          var f = anchor + n.on + k * len;
          while (f <= horizon) {
            prizm.playScheduled(pitch, n.vel / 127, f / sr, (f + dur) / sr);
            f += len;
          }
        });
      } else {
        ch.midiEvents.forEach(function (ev) {
          var data = ev.data;
          if (ch.transpose) {
            var hi = data[0] & 0xF0;
            if (hi === 0x90 || hi === 0x80) {
              data = [data[0], Math.max(0, Math.min(127, data[1] + ch.transpose)), data[2]];
            }
          }
          var k = Math.floor((from - anchor - ev.off) / len) + 1;
          var f = anchor + ev.off + k * len;
          while (f <= horizon) {
            midi.output.send(data, Math.max(performance.now(), engine.frameToPerf(f)));
            f += len;
          }
        });
      }
      ch.schedFrom = horizon;
    });
  }

  /* ---------------- keyboard ---------------- */
  function wireKeyboard() {
    document.addEventListener('keydown', function (e) {
      if (e.repeat) return;
      var tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      // while the PRIZM panel is open its play-keys win over app shortcuts
      if (prizm && prizm.isOpen() && prizm.handlesKey(e.key.toLowerCase())) return;
      if (e.code === 'Space') {
        e.preventDefault();
        stopEverything();
        return;
      }
      if (e.code === 'KeyN') { addChannel(); return; }
      if (e.code === 'KeyD') { $('drum-panel').classList.toggle('hidden'); return; }
      if (e.code === 'KeyB') { $('bass-panel').classList.toggle('hidden'); return; }
      if (e.code === 'KeyP') { playEverything(); return; }
      var m = /^Digit([1-9])$/.exec(e.code);
      if (m) {
        var ch = engine.channels[parseInt(m[1], 10) - 1];
        if (!ch) return;
        if (e.shiftKey) ch.stop(); else ch.mainAction();
      }
    });
  }

  /* ---------------- channel strips ---------------- */
  $('add-channel').addEventListener('click', wrapMappable(function () { addChannel(); }));

  function addChannel() {
    var ch = engine.addChannel();
    var strip = buildStrip(ch);
    strips.push(strip);
    renumber();
    refreshStrip(strip);
    return strip;
  }

  function removeChannel(strip) {
    var i = strips.indexOf(strip);
    if (i < 0) return;
    flushNotes(strip.ch);
    strips.splice(i, 1);
    engine.removeChannel(strip.ch);
    strip.root.remove();
    renumber();
  }

  function renumber() {
    strips.forEach(function (s, i) {
      var n = i + 1;
      s.els.title.textContent = 'LOOP ' + n + (n <= 9 ? '  ·  key ' + n : '');
      s.els.main.setAttribute('data-mappable', 'ch:' + n + ':main');
      s.els.stopBtn.setAttribute('data-mappable', 'ch:' + n + ':stop');
      s.els.clearBtn.setAttribute('data-mappable', 'ch:' + n + ':clear');
      s.els.undoBtn.setAttribute('data-mappable', 'ch:' + n + ':undo');
      s.els.vol.setAttribute('data-mappable', 'ch:' + n + ':vol');
      s.els.armBtn.setAttribute('data-mappable', 'ch:' + n + ':arm');
      s.els.autoBtn.setAttribute('data-mappable', 'ch:' + n + ':auto');
    });
  }

  function buildStrip(ch) {
    var root = document.createElement('section');
    root.className = 'channel';
    root.dataset.state = 'empty';

    root.innerHTML =
      '<div class="ch-head">' +
        '<span class="ch-title"></span>' +
        '<select class="q-select" title="Quantize override for this loop (record/close/overdub timing)">' +
          '<option value="global">Q·glob</option>' +
          '<option value="bar">Q·bar</option>' +
          '<option value="beat">Q·beat</option>' +
          '<option value="off">Q·off</option>' +
        '</select>' +
        '<button class="ch-close" title="Remove this loop channel">✕</button>' +
      '</div>' +
      '<div class="loop-btn-wrap">' +
        '<button class="loop-btn">' +
          '<svg viewBox="0 0 108 108">' +
            '<circle class="ring-bg" cx="54" cy="54" r="50"></circle>' +
            '<circle class="ring-fg" cx="54" cy="54" r="50" stroke-dasharray="' + RING_C + '" stroke-dashoffset="' + RING_C + '"></circle>' +
          '</svg>' +
          '<span class="state-label">TAP TO REC<span class="time-label"></span></span>' +
        '</button>' +
      '</div>' +
      '<div class="ch-buttons">' +
        '<button class="b-stop">STOP</button>' +
        '<button class="b-undo" disabled>UNDO</button>' +
        '<button class="b-clear">CLEAR</button>' +
      '</div>' +
      '<div class="ch-buttons">' +
        '<button class="b-edit" disabled title="Open the waveform editor for this loop">EDIT</button>' +
        '<button class="b-seq" title="Open the MIDI sequencer — compose a pattern, ⏺ records it into this loop">SEQ</button>' +
        '<button class="b-slice" disabled title="Chop this loop on the beat grid: rearrange, repeat, reverse or silence slices (plays through the FX chain)">SLICE</button>' +
      '</div>' +
      '<div class="ch-buttons midi-row">' +
        '<button class="b-arm" title="Start recording on the first incoming MIDI note">ARM</button>' +
        '<button class="b-auto" title="Auto-close the loop when MIDI input goes silent (trailing silence is trimmed)">AUTO</button>' +
        '<label class="midi-rec" title="Capture incoming MIDI notes/CCs alongside the audio and loop them to the MIDI output">' +
          '<input type="checkbox"> ♪ MIDI <span class="midi-count"></span>' +
        '</label>' +
      '</div>' +
      '<div class="ch-vol"><label>Vol</label><input type="range" min="0" max="1.5" step="0.01" value="1"></div>' +
      '<div class="ch-vol ch-pitch"><label>Pitch</label>' +
        '<input type="number" min="-24" max="24" step="1" value="0" title="Transpose this loop in semitones — pitch shifts, tempo stays locked (MIDI notes follow)">' +
        '<span class="unit">st</span></div>' +
      '<div class="fx-section"><div class="fx-rack"></div></div>';

    var els = {
      title: root.querySelector('.ch-title'),
      main: root.querySelector('.loop-btn'),
      label: root.querySelector('.state-label'),
      time: root.querySelector('.time-label'),
      ring: root.querySelector('.ring-fg'),
      stopBtn: root.querySelector('.b-stop'),
      undoBtn: root.querySelector('.b-undo'),
      clearBtn: root.querySelector('.b-clear'),
      editBtn: root.querySelector('.b-edit'),
      seqBtn: root.querySelector('.b-seq'),
      sliceBtn: root.querySelector('.b-slice'),
      armBtn: root.querySelector('.b-arm'),
      autoBtn: root.querySelector('.b-auto'),
      midiChk: root.querySelector('.midi-rec input'),
      midiCount: root.querySelector('.midi-count'),
      vol: root.querySelector('.ch-vol input'),
      pitch: root.querySelector('.ch-pitch input')
    };

    ch.rack.mountUI(root.querySelector('.fx-rack'));

    var strip = { ch: ch, root: root, els: els };

    els.main.addEventListener('click', wrapMappable(function () { ch.mainAction(); }));
    els.stopBtn.addEventListener('click', wrapMappable(function () { ch.stop(); }));
    els.clearBtn.addEventListener('click', wrapMappable(function () { ch.clear(); refreshStrip(strip); }));
    els.undoBtn.addEventListener('click', wrapMappable(function () { ch.undo(); }));
    els.editBtn.addEventListener('click', function () {
      window.WaveEditor.open(engine, ch, strips.indexOf(strip) + 1, status);
    });
    els.seqBtn.addEventListener('click', function () {
      window.MidiSequencer.open(engine, midi, ch, strips.indexOf(strip) + 1, status);
    });
    els.sliceBtn.addEventListener('click', function () {
      window.BeatSlicer.open(engine, ch, strips.indexOf(strip) + 1, status);
    });
    els.vol.addEventListener('input', function () { ch.setVolume(parseFloat(this.value)); });
    els.vol.addEventListener('click', wrapMappable(function () {}));
    els.pitch.addEventListener('change', function () {
      var st = ch.setTranspose(parseFloat(this.value));
      this.value = st;
      flushNotes(ch);   // avoid hanging notes: note-offs would land on the new pitch
      status('Loop ' + (strips.indexOf(strip) + 1) + ' transposed ' + (st > 0 ? '+' : '') + st + ' st (tempo unchanged).');
    });
    els.armBtn.addEventListener('click', wrapMappable(function () {
      ch.armed = !ch.armed;
      if (ch.armed && !ch.midiRec) status('Armed — recording starts on the first MIDI note. Tick ♪ MIDI to also capture the notes.');
      refreshStrip(strip);
    }));
    els.midiChk.addEventListener('change', function () { ch.midiRec = this.checked; });
    root.querySelector('.q-select').addEventListener('change', function () {
      ch.quantOverride = this.value;
    });
    els.autoBtn.addEventListener('click', wrapMappable(function () {
      ch.autoEnd = !ch.autoEnd;
      refreshStrip(strip);
    }));
    root.querySelector('.ch-close').addEventListener('click', function () { removeChannel(strip); });

    ch.onUpdate = function () { refreshStrip(strip); };
    ch.onPos = function () { refreshPos(strip); };

    $('channels').appendChild(root);
    return strip;
  }

  var STATE_LABELS = {
    empty: 'TAP TO REC',
    recording: 'REC',
    playing: 'PLAY',
    overdubbing: 'OVERDUB',
    stopped: 'STOPPED'
  };
  var PENDING_LABELS = {
    record: 'REC QUEUED',
    close: 'CLOSE QUEUED',
    overdub: 'OD QUEUED',
    play: 'PLAY QUEUED',
    stop: 'STOP QUEUED'
  };

  function refreshStrip(strip) {
    var ch = strip.ch;
    strip.root.dataset.state = ch.state;
    strip.root.classList.toggle('pending', !!ch.pendingAction);
    var labelText = ch.pendingAction ? PENDING_LABELS[ch.pendingAction] : STATE_LABELS[ch.state];
    if (ch.armed && ch.state === 'empty' && !ch.pendingAction) labelText = 'WAITING FOR NOTE';
    strip.els.label.childNodes[0].textContent = labelText;
    strip.els.undoBtn.disabled = !ch.hasUndo;
    strip.els.editBtn.disabled = !(ch.state === 'playing' || ch.state === 'stopped');
    strip.els.sliceBtn.disabled = strip.els.editBtn.disabled;
    strip.els.armBtn.classList.toggle('active', ch.armed);
    strip.els.autoBtn.classList.toggle('active', ch.autoEnd);
    strip.els.midiCount.textContent = ch.midiEvents.length ? '(' + ch.midiEvents.length + ')' : '';
    if (ch.state === 'empty') {
      strip.els.ring.setAttribute('stroke-dashoffset', RING_C);
      strip.els.time.textContent = '';
      strip.els.pitch.value = ch.transpose;
    }
  }

  function refreshPos(strip) {
    var ch = strip.ch;
    if (ch.state === 'recording') {
      strip.els.time.textContent = ch.recSec.toFixed(1) + 's';
      strip.els.ring.setAttribute('stroke-dashoffset', RING_C);
    } else if (ch.loopSec > 0 && ch.state !== 'empty') {
      strip.els.ring.setAttribute('stroke-dashoffset', RING_C * (1 - ch.pos));
      strip.els.time.textContent = (ch.pos * ch.loopSec).toFixed(1) + ' / ' + ch.loopSec.toFixed(1) + 's';
    }
  }

  /* ---------------- beat LED ---------------- */
  function beatLoop() {
    var led = $('beat-led');
    var bp = engine.transport.beatPhase();
    if (bp && bp.phase < 0.2) {
      led.className = bp.beat === 0 ? 'bar' : 'on';
    } else {
      led.className = '';
    }
    if (drums) drums.updatePlayhead();
    if (bass) bass.updatePlayhead();
    requestAnimationFrame(beatLoop);
  }
})();
