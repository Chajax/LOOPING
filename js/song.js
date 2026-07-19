/* Song arranger: a bar-grid arrangement timeline. Each track (loop channels, the
   808 drums, the 303 bass) has a lane of bars you paint active/inactive. Playing the
   song schedules every track's mute/unmute up front on the audio clock (sample-
   accurate), so the whole arrangement stays locked in time. */
(function () {
  'use strict';

  var GUTTER = 78, RULER = 16;
  var ROW_H = 26, CELL_W = 20;          // zoomable
  var COLORS = { loop: '#4da3ff', drums: '#ffa229', bass: '#3ddc84', auto: '#b58cff' };

  var ui = null;
  var ctx = null;           // { engine, drums, bass, drumsGate, bassGate, loopTracks, setDrums, setBass, status }
  var tracks = [];          // [{ key, label, kind, color, cells:Uint8Array, gate, ch }]
  var savedCells = {};      // key -> Uint8Array, persists across opens
  var bars = 32;
  var playing = false;
  var startF = 0;
  var loopSong = false;
  var passTimer = null;
  var rafOn = false;

  /* ---------------- tracks ---------------- */
  function cellsFor(key) {
    var src = savedCells[key];
    var out = new Uint8Array(bars);
    if (src) out.set(src.subarray(0, Math.min(bars, src.length)));
    savedCells[key] = out;
    return out;
  }

  function slotName(i) { return i < 26 ? String.fromCharCode(65 + i) : String(i + 1); }

  function buildTracks() {
    tracks = [];
    var bf = ctx.engine.transport.barFrames();
    ctx.loopTracks().forEach(function (lt) {
      var key = 'loop:' + lt.id;   // stable across added/removed channels
      var loopBars = Math.max(1, Math.round(lt.ch.lenFrames / bf));
      tracks.push({ key: key, label: lt.label + ' (' + loopBars + ')', kind: 'loop', group: key,
        color: COLORS.loop, cells: cellsFor(key), gate: lt.gate, ch: lt.ch, loopBars: loopBars });
    });
    addSlotLanes(ctx.drums, 'drums', 'DRUMS', COLORS.drums);
    addSlotLanes(ctx.bass, 'bass', '303', COLORS.bass);
    if (ctx.automationTracks) {
      ctx.automationTracks().forEach(function (at) {
        tracks.push({
          key: 'auto:' + at.id,
          label: at.label,
          kind: 'auto',
          color: COLORS.auto,
          cells: cellsFor('auto:' + at.id),
          loopBars: Math.max(1, at.loopBars || 1),
          apply: at.apply,
          reset: at.reset,
          _lastOn: null
        });
      });
    }
  }

  /* One lane per pattern slot that has content (plus the current slot), so different
     song sections can call up different drum / 303 patterns. */
  function addSlotLanes(inst, kind, prefix, color) {
    inst.syncSlot();   // persist the live edit into its slot first
    var shown = 0;
    for (var i = 0; i < inst.patterns.length; i++) {
      if (inst.slotHasContent(i) || i === inst.curSlot) {
        var key = kind + ':' + i;
        tracks.push({ key: key, label: prefix + ' ' + slotName(i), kind: kind, group: kind,
          slot: i, color: color, cells: cellsFor(key), inst: inst });
        shown++;
      }
    }
    return shown;
  }

  /* ---------------- UI ---------------- */
  function buildUI() {
    var panel = document.createElement('section');
    panel.id = 'song-panel';
    panel.className = 'hidden';
    panel.innerHTML =
      '<div class="drum-head">' +
        '<span class="drum-title song-title">SONG</span>' +
        '<label>Bars <select class="song-bars">' +
          '<option>8</option><option>16</option><option selected>32</option><option>64</option>' +
        '</select></label>' +
        '<button class="song-play">▶ PLAY SONG</button>' +
        '<button class="song-stop">■ STOP</button>' +
        '<label class="chk"><input type="checkbox" class="song-loop"> loop song</label>' +
        '<button class="song-clear">CLEAR</button>' +
        '<span class="song-zoom"><button class="song-zo" title="Smaller">–</button><button class="song-zi" title="Bigger">+</button></span>' +
        '<span class="hint">paint bars per track · audio loops, automation clips, and drums/303 pattern swaps stay bar-locked</span>' +
      '</div>' +
      '<div class="song-scroll"><canvas class="song-canvas"></canvas></div>';
    document.body.insertBefore(panel, document.getElementById('channels'));

    var canvas = panel.querySelector('.song-canvas');
    ui = {
      panel: panel,
      canvas: canvas,
      g: canvas.getContext('2d'),
      bars: panel.querySelector('.song-bars'),
      loop: panel.querySelector('.song-loop')
    };

    ui.bars.addEventListener('change', function () {
      bars = parseInt(this.value, 10);
      buildTracks();
      layout();
      render();
    });
    ui.loop.addEventListener('change', function () { loopSong = this.checked; });
    function zoom(delta) {
      CELL_W = Math.max(10, Math.min(48, CELL_W + delta));
      ROW_H = Math.max(18, Math.min(52, ROW_H + delta));
      layout(); render();
    }
    panel.querySelector('.song-zo').addEventListener('click', function () { zoom(-4); });
    panel.querySelector('.song-zi').addEventListener('click', function () { zoom(4); });
    panel.querySelector('.song-play').addEventListener('click', play);
    panel.querySelector('.song-stop').addEventListener('click', stop);
    panel.querySelector('.song-clear').addEventListener('click', function () {
      tracks.forEach(function (t) { t.cells.fill(0); });
      render();
    });

    // paint
    var painting = false, paintVal = 1;
    function cellAt(e) {
      var rect = canvas.getBoundingClientRect();
      var x = (e.clientX - rect.left) * (canvas.width / rect.width);
      var y = (e.clientY - rect.top) * (canvas.height / rect.height);
      var bar = Math.floor((x - GUTTER) / CELL_W);
      var row = Math.floor((y - RULER) / ROW_H);
      if (bar < 0 || bar >= bars || row < 0 || row >= tracks.length) return null;
      return { bar: bar, row: row };
    }
    /* Loop lanes place whole loop-length blocks, snapped so each block starts the
       loop from bar 1 (which also keeps it phase-aligned on playback). */
    function setCell(row, bar, val) {
      var tr = tracks[row];
      if (tr.loopBars > 1) {
        var start = Math.floor(bar / tr.loopBars) * tr.loopBars;
        for (var b = start; b < start + tr.loopBars && b < bars; b++) tr.cells[b] = val;
        return;
      }
      tr.cells[bar] = val;
      // instrument slots are mutually exclusive per bar (one pattern at a time)
      if (val && (tr.group === 'drums' || tr.group === 'bass')) {
        tracks.forEach(function (o) {
          if (o !== tr && o.group === tr.group) o.cells[bar] = 0;
        });
      }
    }
    function blockActive(tr, bar) {
      if (tr.loopBars > 1) {
        return tr.cells[Math.floor(bar / tr.loopBars) * tr.loopBars];
      }
      return tr.cells[bar];
    }
    canvas.addEventListener('pointerdown', function (e) {
      var c = cellAt(e);
      if (!c) return;
      painting = true;
      canvas.setPointerCapture(e.pointerId);
      paintVal = blockActive(tracks[c.row], c.bar) ? 0 : 1;
      setCell(c.row, c.bar, paintVal);
      render();
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!painting) return;
      var c = cellAt(e);
      if (!c) return;
      if (blockActive(tracks[c.row], c.bar) !== paintVal) {
        setCell(c.row, c.bar, paintVal);
        render();
      }
    });
    canvas.addEventListener('pointerup', function () { painting = false; });
    canvas.addEventListener('pointercancel', function () { painting = false; });
  }

  function layout() {
    ui.canvas.width = GUTTER + bars * CELL_W;
    ui.canvas.height = RULER + tracks.length * ROW_H;
  }

  function render() {
    var g = ui.g, W = ui.canvas.width, H = ui.canvas.height;
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#14161a';
    g.fillRect(0, 0, W, H);

    // ruler
    g.fillStyle = '#8b93a5';
    g.font = '9px sans-serif';
    for (var b = 0; b < bars; b += 4) {
      var x = GUTTER + b * CELL_W;
      g.fillText(String(b + 1), x + 2, 11);
    }

    // rows
    for (var r = 0; r < tracks.length; r++) {
      var t = tracks[r];
      var y = RULER + r * ROW_H;
      g.fillStyle = r % 2 ? 'rgba(255,255,255,0.02)' : 'transparent';
      if (r % 2) g.fillRect(0, y, W, ROW_H);
      // label
      g.fillStyle = t.color;
      g.font = '10px sans-serif';
      g.fillText(t.label, 6, y + ROW_H / 2 + 3);
      // clips
      var lb = t.loopBars > 1 ? t.loopBars : 1;
      for (var bi = 0; bi < bars; ) {
        if (t.cells[bi]) {
          // extent of this contiguous active run
          var end = bi; while (end < bars && t.cells[end]) end++;
          var x0 = GUTTER + bi * CELL_W;
          g.fillStyle = t.color;
          g.globalAlpha = 0.85;
          g.fillRect(x0 + 1, y + 2, (end - bi) * CELL_W - 2, ROW_H - 4);
          g.globalAlpha = 1;
          // loop-length block dividers within the run (each block = one loop pass)
          if (lb > 1) {
            g.strokeStyle = 'rgba(6,7,13,0.55)';
            for (var d = bi + lb; d < end; d += lb) {
              var dx = GUTTER + d * CELL_W;
              g.beginPath(); g.moveTo(dx + 0.5, y + 2); g.lineTo(dx + 0.5, y + ROW_H - 2); g.stroke();
            }
          }
          bi = end;
        } else bi++;
      }
    }

    // grid lines (every bar, stronger every 4)
    for (var s = 0; s <= bars; s++) {
      g.strokeStyle = s % 4 === 0 ? 'rgba(216,220,230,0.22)' : 'rgba(216,220,230,0.07)';
      var gx = GUTTER + s * CELL_W;
      g.beginPath(); g.moveTo(gx + 0.5, 0); g.lineTo(gx + 0.5, H); g.stroke();
    }
    g.strokeStyle = 'rgba(216,220,230,0.22)';
    g.beginPath(); g.moveTo(GUTTER + 0.5, 0); g.lineTo(GUTTER + 0.5, H); g.stroke();
    for (var rr = 0; rr <= tracks.length; rr++) {
      var ly = RULER + rr * ROW_H;
      g.beginPath(); g.moveTo(0, ly + 0.5); g.lineTo(W, ly + 0.5); g.stroke();
    }

    // playhead
    if (playing) {
      var bar = songBar();
      if (bar >= 0 && bar <= bars) {
        var px = GUTTER + bar * CELL_W;
        g.strokeStyle = '#ff4747';
        g.lineWidth = 2;
        g.beginPath(); g.moveTo(px, 0); g.lineTo(px, H); g.stroke();
        g.lineWidth = 1;
      }
    }
  }

  function songBar() {
    var t = ctx.engine.transport;
    var bf = t.barFrames();
    var rel = (t.nowFrame() - startF) / bf;
    if (loopSong) return ((rel % bars) + bars) % bars;
    return rel;
  }

  /* ---------------- playback ---------------- */
  function scheduleGate(gate, cells, sf) {
    var sr = ctx.engine.ctx.sampleRate;
    var bf = ctx.engine.transport.barFrames();
    var g = gate.gain;
    var now = ctx.engine.ctx.currentTime;
    var t0 = Math.max(now, sf / sr);
    g.cancelScheduledValues(now);
    var cur = cells[0] ? 1 : 0;
    g.setValueAtTime(cur, t0);
    for (var b = 1; b < bars; b++) {
      var target = cells[b] ? 1 : 0;
      if (target !== cur) {
        var tb = (sf + b * bf) / sr;
        if (tb <= t0) { g.setValueAtTime(target, t0); }
        else { g.setValueAtTime(cur, tb); g.linearRampToValueAtTime(target, tb + 0.005); }
        cur = target;
      }
    }
    // gate off at song end
    var tend = (sf + bars * bf) / sr;
    g.setValueAtTime(cur, tend);
    g.linearRampToValueAtTime(0, tend + 0.005);
  }

  function hasCells(t) {
    for (var i = 0; i < t.cells.length; i++) if (t.cells[i]) return true;
    return false;
  }

  function barForFrame(frame) {
    var bf = ctx.engine.transport.barFrames();
    var b = Math.floor((frame - startF) / bf);
    if (loopSong) b = ((b % bars) + bars) % bars;
    return b;
  }

  /* which pattern slot is active for this instrument kind at a given bar (-1 = none) */
  function slotAtBar(kind, bar) {
    for (var i = 0; i < tracks.length; i++) {
      var t = tracks[i];
      if (t.kind === kind && t.cells[bar]) return t.slot;
    }
    return -1;
  }
  function drumsSource(frame) {
    var bar = barForFrame(frame);
    if (bar < 0 || bar >= bars) return null;
    var slot = slotAtBar('drums', bar);
    return slot < 0 ? null : ctx.drums.patterns[slot];
  }
  function bassSource(frame) {
    var bar = barForFrame(frame);
    if (bar < 0 || bar >= bars) return null;
    var slot = slotAtBar('bass', bar);
    return slot < 0 ? null : ctx.bass.patterns[slot];
  }

  function autoOnAtBar(t, bar) {
    if (bar < 0 || bar >= bars) return false;
    if (t.loopBars > 1) {
      return !!t.cells[Math.floor(bar / t.loopBars) * t.loopBars];
    }
    return !!t.cells[bar];
  }

  function refreshAutomation(frame) {
    var bar = barForFrame(frame);
    for (var i = 0; i < tracks.length; i++) {
      var t = tracks[i];
      if (t.kind !== 'auto' || !t.apply) continue;
      var on = autoOnAtBar(t, bar);
      if (t._lastOn === on) continue;
      t._lastOn = on;
      t.apply(on);
    }
  }

  /* Schedule the loop-audio gates for one pass; re-armed each pass while looping. */
  function armLoopPass(sf) {
    tracks.forEach(function (t) {
      if (t.kind === 'loop' && hasCells(t) && t.ch) {
        t.ch.songPlayAt(sf);
        scheduleGate(t.gate, t.cells, sf);
      }
    });
    refreshAutomation(sf);
    var sr = ctx.engine.ctx.sampleRate;
    var bf = ctx.engine.transport.barFrames();
    var msToEnd = ((sf + bars * bf) / sr - ctx.engine.ctx.currentTime) * 1000;
    clearTimeout(passTimer);
    passTimer = setTimeout(function () {
      if (!playing) return;
      if (loopSong) armLoopPass(sf + bars * bf);
      else stop();
    }, Math.max(50, msToEnd - 60));
  }

  function play() {
    if (!ctx) return;
    if (playing) stop();
    var t = ctx.engine.transport;
    if (!t.running) {
      startF = Math.round(t.nowFrame() + 0.06 * t.sr);
      t.startAt(startF);
      t.tempoLocked = true;
      if (ctx.engine.onTransportStart) ctx.engine.onTransportStart(startF);
    } else {
      startF = t.nextBoundary('bar');
    }
    playing = true;

    // drums / 303: enable and drive their pumps from the arrangement (pattern per bar)
    var anyDrums = tracks.some(function (t) { return t.kind === 'drums' && hasCells(t); });
    var anyBass = tracks.some(function (t) { return t.kind === 'bass' && hasCells(t); });
    ctx.drums.syncSlot(); ctx.bass.syncSlot();
    if (anyDrums) { ctx.setDrums(true); ctx.drums.songSource = drumsSource; ctx.drums.schedFrom = startF - 1; }
    else { ctx.setDrums(false); ctx.drums.songSource = null; }
    if (anyBass) { ctx.setBass(true); ctx.bass.songSource = bassSource; ctx.bass.schedFrom = startF - 1; }
    else { ctx.setBass(false); ctx.bass.songSource = null; }

    tracks.forEach(function (tr) {
      if (tr.kind === 'auto') tr._lastOn = null;
    });

    armLoopPass(startF);
    ctx.status('Playing song (' + bars + ' bars' + (loopSong ? ', looping' : '') + ').');
    if (!rafOn) { rafOn = true; requestAnimationFrame(frame); }
  }

  function stop() {
    playing = false;
    clearTimeout(passTimer);
    var now = ctx.engine.ctx.currentTime;
    // release loop gates back to audible; stop loops and instruments
    tracks.forEach(function (t) {
      if (t.kind === 'loop' && t.gate) {
        t.gate.gain.cancelScheduledValues(now);
        t.gate.gain.setTargetAtTime(1, now, 0.01);
      }
      if (t.kind === 'auto') {
        t._lastOn = null;
        if (t.reset) t.reset();
      }
    });
    ctx.drums.songSource = null;
    ctx.bass.songSource = null;
    ctx.engine.stopAll();
    ctx.setDrums(false);
    ctx.setBass(false);
    ctx.status('Song stopped.');
    render();
  }

  function frame() {
    if (!playing) { rafOn = false; render(); return; }
    refreshAutomation(ctx.engine.transport.nowFrame());
    render();
    requestAnimationFrame(frame);
  }

  /* ---------------- entry ---------------- */
  function open(context) {
    ctx = context;
    if (!ui) buildUI();
    bars = parseInt(ui.bars.value, 10);
    buildTracks();
    layout();
    render();
    ui.panel.classList.remove('hidden');
  }
  function toggle(context) {
    if (!ui) { open(context); return; }
    if (ui.panel.classList.contains('hidden')) open(context);
    else ui.panel.classList.add('hidden');
  }

  window.SongArranger = {
    open: open, toggle: toggle, stop: stop,
    isPlaying: function () { return playing; }
  };
})();
