/**
 * Tiny procedural synth on WebAudio: no sound files, every effect is a couple of tones and
 * filtered noise. Includes a looping "motor" drone whose level and pitch follow your speed.
 */
export class Synth {
  ctx: AudioContext | null = null;
  master: GainNode | null = null;
  noiseBuf: AudioBuffer | null = null;
  muted = false;
  volume = 0.6;
  private droneGain: GainNode | null = null;
  private droneFilter: BiquadFilterNode | null = null;
  private droneOsc: OscillatorNode | null = null;

  constructor(private storageKey = 'engine_muted') {
    try { this.muted = localStorage.getItem(storageKey) === '1'; } catch { /* storage blocked */ }
  }

  /** Must be called from a user gesture (click / key) before anything is audible. */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      const ctx = (this.ctx = new AC());
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.volume;
      this.master.connect(ctx.destination);
      const len = ctx.sampleRate * 2;
      this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

      // motor drone: band-passed noise + a soft sawtooth
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      src.loop = true;
      this.droneFilter = ctx.createBiquadFilter();
      this.droneFilter.type = 'bandpass';
      this.droneFilter.frequency.value = 600;
      this.droneFilter.Q.value = 1.2;
      this.droneGain = ctx.createGain();
      this.droneGain.gain.value = 0;
      src.connect(this.droneFilter).connect(this.droneGain).connect(this.master);
      src.start();
      this.droneOsc = ctx.createOscillator();
      this.droneOsc.type = 'sawtooth';
      this.droneOsc.frequency.value = 110;
      const og = ctx.createGain();
      og.gain.value = 0.05;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 400;
      this.droneOsc.connect(lp).connect(og).connect(this.droneGain);
      this.droneOsc.start();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  setMuted(m: boolean) {
    this.muted = m;
    try { localStorage.setItem(this.storageKey, m ? '1' : '0'); } catch { /* storage blocked */ }
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : this.volume, this.ctx.currentTime, 0.05);
  }

  /** Motor drone: level 0..1, pitch 0..~1.5. Call every frame; it glides on its own. */
  drone(level: number, pitch: number) {
    if (!this.ctx || !this.droneGain || !this.droneFilter || !this.droneOsc) return;
    const t = this.ctx.currentTime;
    this.droneGain.gain.setTargetAtTime(level * 0.22, t, 0.08);
    this.droneFilter.frequency.setTargetAtTime(500 + pitch * 900, t, 0.1);
    this.droneOsc.frequency.setTargetAtTime(90 + pitch * 60, t, 0.1);
  }

  /** One enveloped oscillator note. `slide` bends the pitch by that many Hz; `out` is a pan or a node. */
  tone(freq: number, dur: number, type: OscillatorType = 'sine', vol = 0.3, slide = 0, delay = 0, out: number | AudioNode = 0) {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.route(out));
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /** A burst of filtered noise (thumps, whooshes, crackles). */
  noise(dur: number, freq: number, vol = 0.3, delay = 0, type: BiquadFilterType = 'lowpass', out: number | AudioNode = 0) {
    if (!this.ctx || !this.master || !this.noiseBuf) return;
    const t = this.ctx.currentTime + delay;
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(this.route(out));
    s.start(t, Math.random());
    s.stop(t + dur + 0.05);
  }

  /** Play notes one after another: arpeggio([523, 659, 784], 0.12). */
  arpeggio(freqs: number[], step: number, dur = 0.3, type: OscillatorType = 'triangle', vol = 0.2) {
    freqs.forEach((f, i) => this.tone(f, dur, type, vol, 0, i * step));
  }

  // ---- a few stock effects, tuned in Clean Sweep
  bump(k: number) { this.tone(140, 0.14, 'sine', 0.35 * k + 0.1, -80); this.noise(0.08, 900, 0.25 * k); }
  pickup() { this.tone(988, 0.08, 'square', 0.12); this.tone(1319, 0.25, 'square', 0.12, 0, 0.07); }
  combo(level: number) { this.tone(520 + level * 120, 0.12, 'triangle', 0.18); this.tone(780 + level * 160, 0.18, 'triangle', 0.14, 0, 0.06); }
  success() { this.arpeggio([523, 659, 784, 659, 784, 1047], 0.12); }
  fail() { [523, 440, 349, 262].forEach((f, i) => this.tone(f, 0.4, 'triangle', 0.22, -20, i * 0.18)); }
  click() { this.tone(700, 0.05, 'square', 0.08); }
  deny() { this.tone(200, 0.15, 'square', 0.12, -40); }

  /** `out` is a stereo pan (-1..1) or a node to play into (e.g. a positional bus). */
  protected route(out: number | AudioNode): AudioNode {
    if (typeof out !== 'number') return out;
    const pan = out;
    if (!pan || !this.ctx || !this.ctx.createStereoPanner) return this.master!;
    const p = this.ctx.createStereoPanner();
    p.pan.value = pan;
    p.connect(this.master!);
    return p;
  }
}
