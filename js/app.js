/* UI wiring: channel strips, transport display, MIDI learn, keyboard shortcuts. */
(function () {
  'use strict';

  var engine = null;   // constructed on power-on so a failed script load is reportable
  var midi = null;
  var drums = null;
  var bass = null;
  var prizm = null;
  var choppah = null;
  var internalSynths = {};   // midiTarget key -> engine instance (registry)
  function internalSynthFor(t) { return (t && internalSynths[t]) || null; }
  var strips = [];           // parallel to engine.channels: { ch, root, els }
  var autoStrips = [];       // automation loop strips
  var autoTargetsUnsub = null;
  var autoTargetRefreshTick = 0;
  var autoDomTargets = {};
  var autoDomSeq = 1;
  var autoDomListenerOn = false;
  var autoLoopsRun = false;
  var autoLoopsStartFrame = 0;
  var nextAutoId = 1;
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

      choppah = new window.Choppah(engine);
      choppah.buildUI($('choppah-panel'), $('choppah-ui'));
      wireChoppah();

      wireSong();
      // internal-synth targets for the sequencer's OUT selector and the loop pump
      internalSynths.prizm = prizm;
      internalSynths.chop = choppah;
      internalSynths.int = prizm;             // back-compat: old channels used 'int'
      window.MidiSequencer.registerSynth('prizm', 'PRIZM synth', prizm);
      window.MidiSequencer.registerSynth('chop', 'CHOPPAH', choppah);

      drums.fxRack = attachInstrumentFx(drums.out, 'drums-fx', 'drums-fx-btn');
      bass.fxRack = attachInstrumentFx(bass.out, 'bass-fx', 'bass-fx-btn');
      drums.bankUI = buildPatternBank('drum-bank', drums, 'Drum');
      bass.bankUI = buildPatternBank('bass-bank', bass, '303');
      prizm.fxRack = attachInstrumentFx(prizm.out, 'prizm-fx', 'prizm-fx-btn');
      prizm.routeTap = prizm.fxRack.output;   // → looper records the FX'd signal
      choppah.fxRack = attachInstrumentFx(choppah.out, 'choppah-fx', 'choppah-fx-btn');
      choppah.routeTap = choppah.fxRack.output;

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
    ['topbar', 'channels', 'add-loop-tools', 'statusbar'].forEach(function (id) {
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
    setInterval(automationLoopPump, 30);
    if (window.FXAutomationTargets) {
      autoTargetsUnsub = window.FXAutomationTargets.subscribe(function (ev) {
        onAutomationTargetMoved(ev);
      });
    }
    ensureAutoDomInputListener();
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
      if (choppah) choppah.allOff();
      autoLoopsRun = false;
      autoLoopsStartFrame = 0;
      autoStrips.forEach(function (s) { s.root.remove(); });
      autoStrips = [];
      nextAutoId = 1;
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
        autoStrips.forEach(function (s, i) {
          out.push({
            id: 'aloop:' + s.id,
            label: 'LOOP ' + (i + 1) + ' - AUTOMATION',
            loopBars: s.loopBars || 1,
            apply: function (on) { s.songEnabled = !!on; },
            reset: function () { s.songEnabled = null; }
          });
        });
        strips.forEach(function (s, i) {
          out = out.concat(s.ch.rack.songAutomationTracks('LOOP ' + (i + 1)));
        });
        out = out.concat(drums.fxRack.songAutomationTracks('DRUMS'));
        out = out.concat(bass.fxRack.songAutomationTracks('303'));
        out = out.concat(prizm.fxRack.songAutomationTracks('PRIZM'));
        out = out.concat(choppah.fxRack.songAutomationTracks('CHOPPAH'));
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
  function refreshSongArranger() {
    if (window.SongArranger && window.SongArranger.refresh) {
      window.SongArranger.refresh(songContext());
    }
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

  /* ---------------- CHOPPAH sample chopper ---------------- */
  function wireChoppah() {
    $('choppah-btn').addEventListener('click', function () {
      var hidden = $('choppah-panel').classList.toggle('hidden');
      if (!hidden && choppah.selCanvas) {   // re-fit the canvas now that it has width
        choppah.selCanvas.width = choppah.selCanvas.clientWidth || 900;
        choppah.drawSel();
      }
    });
    $('choppah-midi-in').addEventListener('change', function () {
      choppah.midiIn = this.checked;
      if (!this.checked) choppah.allOff();
    });
    $('choppah-to-looper').addEventListener('change', function () {
      choppah.setLoopRoute(this.checked);
      status(this.checked ?
        'CHOPPAH routed into the loop input bus — loop channels now record it.' :
        'CHOPPAH plays to the master output only.');
    });
    $('choppah-vol').addEventListener('input', function () {
      choppah.setVolume(parseFloat(this.value));
    });
  }

  /* Grab a recorded loop's audio and load it into CHOPPAH as a sample to chop. */
  function sendToChoppah(ch, n) {
    if (!choppah) { status('CHOPPAH unavailable.'); return; }
    ch.requestSnapshot().then(function (snap) {
      if (!snap.len || !snap.bufL) { status('Loop ' + n + ' has no audio to chop yet.'); return; }
      choppah.loadBuffers(new Float32Array(snap.bufL), new Float32Array(snap.bufR),
        engine.ctx.sampleRate, 'loop ' + n);
      $('choppah-panel').classList.remove('hidden');
      if (choppah.selCanvas) {
        choppah.selCanvas.width = choppah.selCanvas.clientWidth || 900;
        choppah.drawSel();
      }
      status('Loop ' + n + ' sent to CHOPPAH (' + choppah.slices.length + ' slices) — chop it in the CHOP panel.');
    });
  }

  /* ---------------- stop all / play all (loops + 808 + 303) ---------------- */
  function stopEverything() {
    if (window.SongArranger && window.SongArranger.isPlaying()) window.SongArranger.stop();
    autoLoopsRun = false;
    autoLoopsStartFrame = 0;
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
    var wantAuto = autoStrips.some(function (s) { return s.targetId && s.state === 'playing'; });
    if (!wantLoops && !wantDrums && !wantBass && !wantAuto) { status('Nothing to play.'); return; }

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
    if (wantAuto) {
      autoLoopsRun = true;
      autoLoopsStartFrame = f;
      started.push('automation');
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
      var hiP = data[0] & 0xF0;
      if (prizm && prizm.midiIn) {
        if (isNoteOn) prizm.noteOn(data[1], data[2] / 127);
        else if (hiP === 0x80 || hiP === 0x90) prizm.noteOff(data[1]);
        else if (hiP === 0xB0 && data[1] === 123) prizm.allOff();
      }
      if (choppah && choppah.midiIn) {
        if (isNoteOn) choppah.noteOn(data[1], data[2] / 127);
        else if (hiP === 0x80 || hiP === 0x90) choppah.noteOff(data[1]);
        else if (hiP === 0xB0 && data[1] === 123) choppah.allOff();
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
    var synth = internalSynthFor(ch.midiTarget);
    if (synth) { synth.allOff(); return; }
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
      var synth = internalSynthFor(ch.midiTarget);
      var internal = !!synth;
      var sink = internal ? synth : (midi && midi.output);
      var active = (ch.state === 'playing' || ch.state === 'overdubbing') &&
        ch.lenFrames > 0 && ch.midiEvents.length > 0 && sink && !ch.midiMute;
      if (!active) {
        if (ch.schedFrom !== null) { flushNotes(ch); ch.schedFrom = null; }
        return;
      }
      var from = (ch.schedFrom === null || ch.schedFrom < nowF) ? nowF : ch.schedFrom;
      var anchor = ch.anchorFrame, len = ch.lenFrames;
      if (internal) {
        // schedule in onset order so control notes latch before their pitch notes
        loopNotePairs(ch).sort(function (a, b) { return a.on - b.on; }).forEach(function (n) {
          var pitch = Math.max(0, Math.min(127, n.pitch + (ch.transpose || 0)));
          var dur = n.off - n.on; if (dur <= 0) dur += len;
          var k = Math.floor((from - anchor - n.on) / len) + 1;
          var f = anchor + n.on + k * len;
          while (f <= horizon) {
            synth.playScheduled(pitch, n.vel / 127, f / sr, (f + dur) / sr);
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
  $('add-auto-channel').addEventListener('click', function () { addAutomationLoop(); });

  function addChannel() {
    var ch = engine.addChannel();
    var strip = buildStrip(ch);
    strips.push(strip);
    renumber();
    refreshStrip(strip);
    refreshSongArranger();
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
    refreshSongArranger();
  }

  function renumber() {
    strips.forEach(function (s, i) {
      var n = i + 1;
      s.els.title.textContent = 'LOOP ' + n + ' - AUDIO' + (n <= 9 ? '  ·  key ' + n : '');
      s.els.main.setAttribute('data-mappable', 'ch:' + n + ':main');
      s.els.stopBtn.setAttribute('data-mappable', 'ch:' + n + ':stop');
      s.els.clearBtn.setAttribute('data-mappable', 'ch:' + n + ':clear');
      s.els.undoBtn.setAttribute('data-mappable', 'ch:' + n + ':undo');
      s.els.vol.setAttribute('data-mappable', 'ch:' + n + ':vol');
      s.els.armBtn.setAttribute('data-mappable', 'ch:' + n + ':arm');
      s.els.autoBtn.setAttribute('data-mappable', 'ch:' + n + ':auto');
    });
  }

  function renumberAutomation() {
    autoStrips.forEach(function (s, i) {
      s.els.title.textContent = 'LOOP ' + (i + 1) + ' - AUTOMATION';
    });
  }

  function normForTarget(t, v) {
    if (!t) return 0;
    if (t.log) return (Math.log(v) - Math.log(t.min)) / (Math.log(t.max) - Math.log(t.min));
    return (v - t.min) / (t.max - t.min);
  }
  function valForTarget(t, norm) {
    norm = Math.max(0, Math.min(1, norm));
    if (t.log) return Math.exp(Math.log(t.min) + norm * (Math.log(t.max) - Math.log(t.min)));
    return t.min + norm * (t.max - t.min);
  }
  function currentTransportBeats() {
    var t = engine.transport;
    if (!t.running) return null;
    return (t.nowFrame() - t.origin) / t.beatFrames();
  }
  function ensureTransportRunning() {
    var t = engine.transport;
    if (t.running) return;
    var f = Math.round(t.nowFrame() + 0.02 * t.sr);
    t.startAt(f);
    t.tempoLocked = true;
    $('bpm-input').disabled = true;
    midi.startClock(f);
  }
  function samplePoints(pts, ph) {
    var n = pts.length;
    var f = ph * n;
    var i0 = Math.floor(f) % n;
    var i1 = (i0 + 1) % n;
    var fr = f - Math.floor(f);
    return pts[i0] * (1 - fr) + pts[i1] * fr;
  }
  function rebuildPointsFromNodes(s) {
    var nn = s.nodes.length;
    for (var i = 0; i < s.points.length; i++) {
      var f = i / (s.points.length - 1) * (nn - 1);
      var i0 = Math.floor(f), i1 = Math.min(nn - 1, i0 + 1), fr = f - i0;
      s.points[i] = s.nodes[i0] * (1 - fr) + s.nodes[i1] * fr;
    }
  }
  function rebuildNodesFromPoints(s) {
    var nn = s.nodes.length;
    for (var i = 0; i < nn; i++) {
      var ph = i / (nn - 1);
      s.nodes[i] = samplePoints(s.points, ph);
    }
  }
  function ensureDomTargetId(el) {
    if (!el.dataset.autoTargetId) {
      el.dataset.autoTargetId = 'dom:' + (autoDomSeq++);
    }
    return el.dataset.autoTargetId;
  }
  function sliderLabel(el) {
    if (el.id) return '[UI] ' + el.id;
    var row = el.closest('.tb-group,.drum-head,.ch-vol,.pz-ctl,.fx-param,.editor-row,.seq-l');
    if (row) {
      var lb = row.querySelector('label');
      if (lb && lb.textContent) return '[UI] ' + lb.textContent.trim();
    }
    return '[UI] slider';
  }
  function rebuildDomTargets() {
    var next = {};
    Array.prototype.forEach.call(document.querySelectorAll('input[type="range"]'), function (el) {
      if (el.id === 'master-vol') return;
      if (el.closest('.fx-rack')) return; // FX sliders are provided by FXAutomationTargets
      var id = ensureDomTargetId(el);
      var min = parseFloat(el.min); if (!isFinite(min)) min = 0;
      var max = parseFloat(el.max); if (!isFinite(max) || max <= min) max = min + 1;
      next[id] = {
        id: id,
        label: sliderLabel(el),
        min: min,
        max: max,
        log: false,
        get: function () { return parseFloat(el.value); },
        apply: function (v, source) {
          v = Math.max(min, Math.min(max, v));
          el._autoApplying = true;
          el.value = String(v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el._autoApplying = false;
          onAutomationTargetMoved({ targetId: id, value: v, source: source || 'automation' });
        }
      };
    });
    autoDomTargets = next;
  }
  function listAutomationTargets() {
    rebuildDomTargets();
    var out = [];
    if (window.FXAutomationTargets) out = out.concat(window.FXAutomationTargets.list());
    Object.keys(autoDomTargets).forEach(function (k) { out.push(autoDomTargets[k]); });
    out.sort(function (a, b) { return a.label.localeCompare(b.label); });
    return out;
  }
  function getAutomationTarget(id) {
    rebuildDomTargets();
    if (autoDomTargets[id]) return autoDomTargets[id];
    if (window.FXAutomationTargets) return window.FXAutomationTargets.get(id);
    return null;
  }
  function ensureAutoDomInputListener() {
    if (autoDomListenerOn) return;
    autoDomListenerOn = true;
    document.addEventListener('input', function (e) {
      var el = e.target;
      if (!el || el.tagName !== 'INPUT' || el.type !== 'range') return;
      if (el.id === 'master-vol') return;
      if (el.closest('.fx-rack')) return;
      if (el._autoApplying) return;
      var id = ensureDomTargetId(el);
      onAutomationTargetMoved({ targetId: id, value: parseFloat(el.value), source: 'manual' });
    }, true);
  }

  function drawAutomationSeq(s, ph) {
    var c = s.els.canvas;
    var g = c.getContext('2d');
    c.width = c.clientWidth || 200;
    var W = c.width, H = c.height;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(181,140,255,0.10)';
    g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(216,220,230,0.10)';
    for (var q = 1; q < 4; q++) {
      var gx = q / 4 * W;
      g.beginPath(); g.moveTo(gx, 0); g.lineTo(gx, H); g.stroke();
    }
    g.strokeStyle = '#b58cff';
    g.lineWidth = 1.4;
    g.beginPath();
    for (var i = 0; i < s.points.length; i++) {
      var x = i / (s.points.length - 1) * W;
      var y = (1 - s.points[i]) * H;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
    g.fillStyle = '#b58cff';
    for (var k = 0; k < s.nodes.length; k++) {
      var nx = k / (s.nodes.length - 1) * W;
      var ny = (1 - s.nodes[k]) * H;
      g.beginPath(); g.arc(nx, ny, 2.8, 0, 2 * Math.PI); g.fill();
    }
    if (ph >= 0) {
      var px = ph * W;
      g.strokeStyle = '#ffa229';
      g.beginPath(); g.moveTo(px, 0); g.lineTo(px, H); g.stroke();
    }
  }
  function refreshAutoTargetSelect(s) {
    var sel = s.els.target;
    var list = listAutomationTargets();
    sel.innerHTML = '<option value="">select slider…</option>';
    list.forEach(function (t) {
      var o = document.createElement('option');
      o.value = t.id;
      o.textContent = t.label;
      sel.appendChild(o);
    });
    if (s.targetId && getAutomationTarget(s.targetId)) sel.value = s.targetId;
    else s.targetId = sel.value || '';
  }
  function refreshAutomationStrip(s) {
    s.root.dataset.state = s.state;
    s.els.rec.classList.toggle('active', s.state === 'recording');
    s.els.seq.classList.add('active');
    s.els.state.textContent = s.state === 'recording' ? 'REC' : (s.targetId ? 'PLAY' : 'NO TARGET');
  }
  function removeAutomationLoop(s) {
    var i = autoStrips.indexOf(s);
    if (i < 0) return;
    autoStrips.splice(i, 1);
    s.root.remove();
    renumberAutomation();
    refreshSongArranger();
  }
  function addAutomationLoop() {
    var root = document.createElement('section');
    root.className = 'channel auto-channel';
    root.dataset.state = 'empty';
    root.innerHTML =
      '<div class="ch-head">' +
        '<span class="ch-title"></span>' +
        '<button class="ch-close" title="Remove this automation loop">✕</button>' +
      '</div>' +
      '<div class="ch-buttons">' +
        '<button class="a-rec" title="Arm record: starts transport and captures slider movement until idle">REC</button>' +
        '<button class="a-seq active" title="Sequence editor (always editable)">SEQ</button>' +
      '</div>' +
      '<div class="ch-vol"><label>Target</label><select class="a-target"></select></div>' +
      '<canvas class="a-seq-canvas" height="64"></canvas>' +
      '<div class="ch-vol"><label>State</label><span class="a-state">NO TARGET</span></div>';

    var s = {
      id: nextAutoId++,
      root: root,
      state: 'empty',
      points: new Float32Array(128),
      nodes: new Float32Array(16),
      lenBeats: 4,
      loopBars: 1,
      targetId: '',
      recStartBeat: 0,
      recEvents: [],
      recStarted: false,
      lastMoveWall: 0,
      songEnabled: null,
      els: {
        title: root.querySelector('.ch-title'),
        rec: root.querySelector('.a-rec'),
        seq: root.querySelector('.a-seq'),
        target: root.querySelector('.a-target'),
        canvas: root.querySelector('.a-seq-canvas'),
        state: root.querySelector('.a-state')
      }
    };
    s.points.fill(0.5); s.nodes.fill(0.5);

    refreshAutoTargetSelect(s);
    drawAutomationSeq(s, -1);
    refreshAutomationStrip(s);

    s.els.target.addEventListener('change', function () {
      s.targetId = this.value;
      if (s.targetId) s.state = 'playing';
      refreshAutomationStrip(s);
    });
    s.els.rec.addEventListener('click', function () {
      if (!s.targetId) { status('Pick a target slider first.'); return; }
      ensureTransportRunning();
      s.state = 'recording';
      s.recStartBeat = currentTransportBeats() || 0;
      s.recEvents = [];
      s.recStarted = false;
      s.lastMoveWall = Date.now();
      refreshAutomationStrip(s);
    });
    s.els.seq.addEventListener('click', function () {
      status('Sequence editor is always active: drag nodes in the lane to edit automation.');
    });
    root.querySelector('.ch-close').addEventListener('click', function () { removeAutomationLoop(s); });

    // node editing
    var dragNode = -1;
    function pickNode(e) {
      var rect = s.els.canvas.getBoundingClientRect();
      var x = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
      var idx = Math.round(x / rect.width * (s.nodes.length - 1));
      return Math.max(0, Math.min(s.nodes.length - 1, idx));
    }
    function setNode(e) {
      var rect = s.els.canvas.getBoundingClientRect();
      var y = Math.min(Math.max(e.clientY - rect.top, 0), rect.height);
      s.nodes[dragNode] = 1 - y / rect.height;
      rebuildPointsFromNodes(s);
      if (s.targetId) s.state = 'playing';
      drawAutomationSeq(s, -1);
      refreshAutomationStrip(s);
    }
    s.els.canvas.addEventListener('pointerdown', function (e) {
      dragNode = pickNode(e);
      s.els.canvas.setPointerCapture(e.pointerId);
      setNode(e);
    });
    s.els.canvas.addEventListener('pointermove', function (e) { if (dragNode >= 0) setNode(e); });
    s.els.canvas.addEventListener('pointerup', function () { dragNode = -1; });
    s.els.canvas.addEventListener('pointercancel', function () { dragNode = -1; });

    $('channels').appendChild(root);
    autoStrips.push(s);
    renumberAutomation();
    refreshSongArranger();
    return s;
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
      '<div class="ch-buttons">' +
        '<button class="b-chop" disabled title="Send this loop\'s audio to CHOPPAH as a sample to chop, rearrange and re-pitch">→ CHOP</button>' +
        '<button class="b-oneshot" title="One-shot: play the loop once and stop instead of looping (applies live and in the song arranger)">1-SHOT</button>' +
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
      chopBtn: root.querySelector('.b-chop'),
      oneshotBtn: root.querySelector('.b-oneshot'),
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
    els.chopBtn.addEventListener('click', function () {
      sendToChoppah(ch, strips.indexOf(strip) + 1);
    });
    els.oneshotBtn.addEventListener('click', wrapMappable(function () {
      ch.setOneShot(!ch.oneShot);
      refreshStrip(strip);
      status('Loop ' + (strips.indexOf(strip) + 1) + (ch.oneShot ?
        ' set to one-shot (plays once, then stops).' : ' loops continuously.'));
    }));
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
    strip.els.chopBtn.disabled = strip.els.editBtn.disabled;
    strip.els.oneshotBtn.classList.toggle('active', ch.oneShot);
    strip.els.armBtn.classList.toggle('active', ch.armed);
    strip.els.autoBtn.classList.toggle('active', ch.autoEnd);
    strip.els.midiCount.textContent = ch.midiEvents.length ? '(' + ch.midiEvents.length + ')' : '';
    if (ch.state === 'empty') {
      strip.els.ring.setAttribute('stroke-dashoffset', RING_C);
      strip.els.time.textContent = '';
    }
    // keep the Pitch field in sync (transpose resets to 0 on new takes / edits)
    if (document.activeElement !== strip.els.pitch) strip.els.pitch.value = ch.transpose;
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

  function onAutomationTargetMoved(ev) {
    autoStrips.forEach(function (s) {
      if (s.state !== 'recording') return;
      if (!s.targetId || ev.targetId !== s.targetId) return;
      if (ev.source !== 'manual') return;
      var tgt = getAutomationTarget(s.targetId);
      if (!tgt) return;
      var beats = currentTransportBeats();
      if (beats === null) return;
      var rel = Math.max(0, beats - s.recStartBeat);
      s.recEvents.push({ beat: rel, norm: normForTarget(tgt, ev.value) });
      s.recStarted = true;
      s.lastMoveWall = Date.now();
    });
  }

  function finishAutomationRecord(s) {
    if (!s.recStarted || !s.recEvents.length) {
      s.state = s.targetId ? 'playing' : 'empty';
      refreshAutomationStrip(s);
      return;
    }
    var endBeat = s.recEvents[s.recEvents.length - 1].beat;
    var dur = Math.max(0.5, endBeat || 1);
    s.lenBeats = Math.max(1, Math.round(dur));
    s.loopBars = Math.max(1, Math.round(s.lenBeats / 4));

    for (var i = 0; i < s.points.length; i++) {
      var t = i / (s.points.length - 1) * dur;
      var j = 0;
      while (j < s.recEvents.length - 1 && s.recEvents[j + 1].beat < t) j++;
      var a = s.recEvents[j], b = s.recEvents[Math.min(s.recEvents.length - 1, j + 1)];
      if (!b || b.beat === a.beat) s.points[i] = a.norm;
      else {
        var f = (t - a.beat) / (b.beat - a.beat);
        s.points[i] = a.norm * (1 - f) + b.norm * f;
      }
    }
    rebuildNodesFromPoints(s);
    s.state = 'playing';
    s.recStarted = false;
    drawAutomationSeq(s, -1);
    refreshAutomationStrip(s);
  }

  function automationLoopPump() {
    if (!engine || !engine.transport) return;
    autoTargetRefreshTick++;
    if (autoTargetRefreshTick % 25 === 0) {
      autoStrips.forEach(function (s) { refreshAutoTargetSelect(s); });
    }
    autoStrips.forEach(function (s) {
      if (!s.targetId) return;
      if (!getAutomationTarget(s.targetId)) {
        s.targetId = '';
        refreshAutoTargetSelect(s);
        s.state = 'empty';
        refreshAutomationStrip(s);
      }
    });

    var beats = currentTransportBeats();
    var nowFrame = engine.transport.nowFrame();
    var songPlaying = !!(window.SongArranger && window.SongArranger.isPlaying && window.SongArranger.isPlaying());
    autoStrips.forEach(function (s) {
      if (s.state === 'recording' && s.recStarted && Date.now() - s.lastMoveWall > 900) {
        finishAutomationRecord(s);
      }
      if (beats === null || s.state !== 'playing' || !s.targetId) {
        drawAutomationSeq(s, -1);
        return;
      }
      if (!songPlaying && (!autoLoopsRun || nowFrame < autoLoopsStartFrame)) {
        drawAutomationSeq(s, -1);
        return;
      }
      if (s.songEnabled === false) {
        drawAutomationSeq(s, -1);
        return;
      }
      var tgt = getAutomationTarget(s.targetId);
      if (!tgt) return;
      var cyc = s.lenBeats || 4;
      var ph = ((beats / cyc) % 1 + 1) % 1;
      var norm = samplePoints(s.points, ph);
      tgt.apply(valForTarget(tgt, norm), 'loop');
      drawAutomationSeq(s, ph);
    });
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
