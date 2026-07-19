# LOOPING — software loop station

A Boss RC-style loop station in the browser: unlimited spawn-on-demand loop channels,
per-channel effect chains, sample-accurate loop sync, and **MIDI clock output** to keep
a hardware synth in time.

## Run it

Any static file server works. Easiest options:

```
py -m http.server 8080        # Python
npx serve .                   # Node
```

Then open **http://localhost:8080** in **Chrome or Edge** (they support Web MIDI +
AudioWorklet). Click **POWER ON** and grant microphone + MIDI permissions.

> Double-clicking `index.html` (file://) also works in Chrome in most setups, but the
> localhost route is the reliable one.

## How to use

1. **Pick your audio input** (your interface's input) and, under *MIDI clock out*, the
   MIDI port your synth is on.
2. Hit the big round button on a loop channel:
   - empty → **REC** (red)
   - recording → **close loop & PLAY** (green)
   - playing → **OVERDUB** (orange)
   - overdubbing → back to **PLAY**
3. With **1st loop sets tempo** on (default), your first loop is recorded freely; when
   you close it, the app guesses the bar count, locks the BPM, and starts sending MIDI
   clock + Start to your synth, aligned to your loop's downbeat.
   - Prefer a fixed tempo instead? Untick it, set the BPM, and every loop is quantized
     to the grid from the start.
4. **Quantize** (Bar / Beat / Off) controls when record/overdub/play/stop actions fire.
   Loops of different lengths stay phase-locked to the master grid, RC-505 style.
5. **＋ ADD LOOP** spawns a new channel — as many as you like.
6. Per channel: volume, **Pitch** (transpose ±24 semitones — granular pitch shift at
   playback, so tempo, length and grid stay locked; captured MIDI notes transpose
   with it, and it's non-destructive: 0 st is bit-exact passthrough and EDIT/SLICE/
   EXPORT always see the original audio), STOP / UNDO (one level of overdub undo) /
   CLEAR, and an FX chain (see *Effects & automation*).

### Effects & automation

One shared FX rack powers the loop channels **and** the instrument buses — the 808,
303 and PRIZM panels each have an **FX** button opening their own chain. Effects:
**Filter** (low/high/band-pass), **Delay** (free ms or tempo-synced 1/16…1 bar,
follows BPM changes), **Reverb** (free decay or synced to 1/2…2 bars),
**Distortion**, **Flanger**, **Chorus** — stack and order freely.

Every knob has an **A** button that opens a **drawable automation loop**: draw the
parameter's movement freehand on the lane, pick a loop length (1/4 … 4 bars), and it
plays back phase-locked to the transport with a moving playhead. The curve maps
across the parameter's full range (log-frequency for filter cutoff, so it sounds
even), and *flat* resets it to the current slider value. Draw a rising ramp on the
filter cutoff for a riser, a stepped shape for rhythmic gating, anything you can
draw — each parameter has its own independent loop.

### MIDI-triggered recording & MIDI loops

- **ARM**: arm an empty channel and recording starts the instant the first MIDI note
  arrives from your keyboard/synth — hands never leave the keys. (Notes mapped as
  controls via MIDI LEARN don't trigger it.)
- **♪ MIDI**: with this ticked, incoming MIDI notes/CCs are captured alongside the
  audio while recording or overdubbing. When the loop plays, the captured MIDI is sent
  back out of the *MIDI clock out* port in a phase-locked loop — your synth replays the
  part itself, on top of (or instead of) the audio loop. Overdubs add MIDI layers;
  UNDO removes the last layer's MIDI together with its audio; stopping a channel sends
  All Notes Off so nothing hangs.
- The event count next to ♪ MIDI shows how many MIDI events the loop holds.
- **AUTO**: with AUTO on, a recording closes itself once your MIDI input has been
  silent for the *Auto-end* time (top bar, default 2 s). The close is retroactive:
  the loop ends at your last note — rounded up to the quantize grid when a tempo grid
  exists — and the trailing silence is trimmed, so the timeout never ends up inside
  the loop. ARM + AUTO + ♪ MIDI together give a fully hands-free take: play a phrase,
  stop, and it loops.

### Perfect loops

With **Perfect loops** on (top bar, default on), every loop is cleaned up the moment
it closes, on the audio thread:

- **Leading-silence trim** — the dead time between hitting record (or the arm
  trigger) and your first actual sound is cut, with a 5 ms pre-roll, so the loop
  starts right on the first onset. Only applied to free-length loops (quantize off,
  or the tempo-defining first loop) — grid-locked loops keep their exact bar length.
  Because it runs *before* the tempo is calculated, the BPM guess from your first
  loop gets more accurate too.
- **Seam crossfade** — the looper keeps recording ~15 ms of input *past* the loop
  end (the natural continuation) and crossfades it over the loop start, so the wrap
  point flows seamlessly with no click and no fade-to-zero dip — even on sustained
  tones and pads. Applied after recording and after every overdub layer. (Loops with
  no captured tail — imports, rotates, slice edits — fall back to a short edge fade.)

### Per-loop quantize

Each channel header has a **Q** dropdown (glob / bar / beat / off) that overrides the
global Quantize setting for that loop only — e.g. keep the global setting on Bar but
let one loop close on the beat.

### 808 drums

**DRUMS** (top bar, or `D`) opens a built-in synthesized 808 kit — kick, snare,
closed/open hat (closed chokes open, like the original), clap — with a step
sequencer running on 16ths of the master bar, phase-locked to the transport and the
MIDI clock. Click steps to toggle, instrument names to preview, per-row levels plus
a kit volume. **PLAY** starts the pattern — and starts the clock at the current BPM
if nothing is running yet, so drums-first jamming works.

- **＋ VOICE** spawns another row of any synth voice (two kicks tuned by level, three
  hats…); ✕ removes a row.
- **＋ SAMPLE** imports audio files (wav/mp3/ogg, multi-select) as new drum rows —
  your own hits play sample-accurately on the same grid.
- **Polyrhythms**: each row has its own step count (2–32). A row with ≠16 steps
  cycles at its own length against the others — e.g. a 12-step hat over a 16-step
  kick realigns every 3 bars. Each row shows its own playhead.

### Waveform editor

**EDIT** on any finished loop opens a waveform editor (loop keeps playing while you
work). **TRIM SIL** removes leading silence with one click (auto-detected, 5 ms
pre-roll kept — handy for grid-recorded takes, which Perfect loops deliberately
leaves untrimmed). Drag on the waveform to select, then: **TRIM** (keep selection), **CUT**,
**SILENCE**, **FADE IN/OUT**, **REVERSE**, **NORM**alize, **APPLY GAIN** (slider,
selection or whole loop), and **SET START** (rotate the loop so the selection start
becomes the loop start — grid alignment is preserved). Bar lines are drawn when a
tempo grid exists; orange ticks mark captured MIDI notes, and MIDI events follow
trims, cuts, and rotations. Everything is staged: **UNDO**/**RESET** inside the
editor, and nothing touches the live loop until **APPLY** — which swaps the audio
in seamlessly without stopping playback.

### TB-303 bass

**303** (top bar, or `B`) opens a TB-303-style acid bass — mono saw/square voice
into a resonant lowpass with envelope modulation, driven by a 16-step pattern
locked to the same grid as the drums. One note per step (C2–B3), plus **ACC**
(accent: louder, brighter, snappier) and **SLD** (slide: glide into the next note
without retriggering the envelope) rows — the classic acid vocabulary. Knobs:
waveform, cutoff, resonance, env mod, decay, volume. PLAY starts the pattern (and
the clock, if needed); placing notes previews them when the pattern isn't running.

### Beat slicer

**SLICE** on any finished loop chops it on the beat grid (beat / 1/8 / 1/16 — or a
fixed slice count when no tempo grid exists) and lets you rework the audio slice by
slice: **click** a slice to silence it, **drag** one slice onto another position to
copy it there (stutters and rolls by repeating a slice), **double-click** to reverse
a slice, plus SHUFFLE (random order) and RESET. Moved slices show in purple with
their source number; PREVIEW loops the sliced version before you commit. APPLY
rebuilds the loop in place — same length, same grid anchor, 2 ms de-click fades at
every slice edge — and the result plays through the channel's FX chain, so slicing
happens **before the effects**.

### PRIZM-2 synth

**PRIZM** (top bar) opens a dual "refraction" synthesizer: each of its two
oscillators splits a note into up to 8 partial **rays** — ray k sits at
base·(k+1)ⁿ (index *n* = 1 gives a harmonic series, n ≠ 1 inharmonic
glass/bell tones), detuned by *dispersion*·k cents with a spectral *tilt* —
through a lowpass **Aperture** and an **Exposure** ADSR, 8-voice polyphonic.
Play it three ways: the on-screen keys, your computer keyboard (A W S E D F …,
Z/X octave — active while the panel is open), or **MIDI in**
(velocity-sensitive; any unmapped incoming note plays it). Tick **→ looper**
to route PRIZM into the loop input bus — loop channels then record it
directly, latency-compensated, so you can loop the synth without any cabling.

### MIDI sequencer (compose → record)

**SEQ** on any channel opens a piano-roll sequencer (C2–C6, 16th-note grid, 1–8
bars). Click to place notes (they preview as you place them), **drag a note to move
it** in pitch and time, **drag its right edge to resize** (or keep dragging while
placing to draw the length), **scroll the wheel over a note to change its velocity**
(shown as note brightness), and a plain click on a note deletes it. The pattern
plays out of the *MIDI clock out* port on a chosen MIDI channel — or **OMNI**, which
broadcasts every note on all 16 channels so it reaches your synth regardless of
which channel it listens on:

- **PREVIEW** loops the pattern to your synth (starts the clock if needed).
- **⏺ REC LOOP** is the point of it: the pattern plays once from the next bar and the
  channel records your synth's audio at the same time, closing at exactly the pattern
  length. The pattern is stored as the loop's MIDI (so it exports), but its output is
  muted by default since the audio already has the part — tick *loop MIDI out after
  rec* to keep the synth playing it live every cycle instead.
- **SAVE MIDI** writes the pattern into an existing loop's MIDI events without
  recording; opening SEQ on a loop with captured MIDI converts it into editable notes.
- **STEP REC** enters notes from your MIDI keyboard one step at a time: play a note
  (or hold a chord) to place it at the green cursor, and it advances by the current
  note length when you release — no timing pressure. Velocity is taken from how hard
  you play. **REST** advances without a note; **⟵** steps back and deletes. The step
  size follows the *Note* selector (1/16 … 1 bar), and the cursor wraps at the
  pattern end.
- **Bounce latency is self-calibrating**: the MIDI→synth→audio-input round trip
  would otherwise leave silence at the loop start and a cut-off tail. After each
  bounce the app measures where the first note's audio actually landed, rotates the
  loop into alignment (exact length and grid kept), re-fades the seam, and remembers
  the measured latency — so the next take records through a correctly shifted window
  and captures the full tail. The first-ever bounce self-corrects a moment after
  closing; takes after that are aligned from the start.

### Export / import

**EXPORT** downloads a zip with one WAV stem + one MIDI file per loop and a
`manifest.json` (BPM, sample rate). **IMPORT** loads such a zip back — each track
becomes a new loop channel with its audio and MIDI, and the tempo is restored (if the
grid isn't already locked). Loose `.wav`/`.mid` files and deflate-compressed zips work
too; imported loops arrive stopped and anchor themselves to the bar grid on first
play. A MIDI-only file becomes a silent loop of whole bars that plays its notes to
the synth.

Standalone WAVs are **tempo-synced to the master grid** on import: tempo comes from
the file's ACID chunk (the standard loop-tempo metadata) or a `...120bpm...`
filename; otherwise the audio is beat-detected, and if that isn't confident a
**tap-tempo dialog** pops up for that file (or import it unsynced). With a tempo
known, the loop is varispeed-stretched to the master BPM (half/double-time resolved
toward the least stretch) and snapped to exact whole beats — or, if no tempo is
locked yet, the sample's own tempo becomes the master. One-shot-flagged ACID files
are left untouched.

### VST?

Not possible in a browser — no plugin hosting exists in Web Audio. The realistic
routes are Web Audio Modules (a small ecosystem of web-native plugins) or porting
this design to a native JUCE app, which would also unlock ASIO latency.

### Controls

| Input | Action |
|---|---|
| `1`–`9` | Main loop button of channel 1–9 |
| `Shift` + `1`–`9` | Stop that channel |
| `N` | Add a loop channel |
| `P` | Play all: loops + 808 + 303 start together on one shared bar downbeat |
| `Space` | Stop all: loops, drums, and 303 (clock keeps running) |
| `D` | Show/hide the drum machine |

**MIDI controller:** click **MIDI LEARN**, click any control (loop buttons, stop/clear/
undo, volume sliders, STOP ALL, ADD LOOP), then press a pad/footswitch or turn a knob.
Bindings are saved in the browser. Volume maps to CCs as continuous values; buttons
trigger on note-on or CC > 63.

### Top-bar extras

- **Monitor** — hear the live input through the master output.
- **Comp (ms)** — latency compensation: shifts recorded/overdubbed audio earlier so it
  lands where you *heard* it, not where it arrived. The default is estimated from the
  audio output latency; if overdubs feel consistently late, raise it (try 20–40 ms).
- **STOP ALL** stops playback but keeps the MIDI clock running (synth stays in sync).
  **RESET** clears everything, unlocks the tempo, and sends MIDI Stop.

## Notes & limits

- Browsers can't use **ASIO** — Chrome talks to your interface via WASAPI. Latency is
  typically 10–20 ms, fine for looping; set your interface to a small buffer anyway.
- MIDI clock is scheduled with a look-ahead queue on Web MIDI timestamps, which keeps
  jitter low (well under typical hardware clock jitter), but the browser is not an
  atomic clock — for tightest sync keep the tab focused.
- Loop channels are capped at 5 minutes each; channel count is unbounded (each channel
  costs one AudioWorklet — dozens are fine on a modern machine).
- Changing BPM after loops exist is intentionally locked (no time-stretching); RESET to
  start a new tempo.
