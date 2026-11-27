import { Synth } from '../engine/src';

/** Landscaping Inc.'s sound set on top of the engine's synth. The mower engine is the synth's drone. */
export class Sfx extends Synth {
  constructor() { super('li_muted'); }

  knock() { this.noise(0.07, 380, 0.5); this.noise(0.07, 360, 0.45, 0.18); this.noise(0.07, 400, 0.4, 0.36); }
  chop(k: number) { this.noise(0.035, 2400 + Math.random() * 1200, 0.05 + 0.06 * k, 0, 'bandpass'); }
  leaf() { this.noise(0.12, 1800 + Math.random() * 800, 0.06, 0, 'highpass'); }
  crunch() { this.noise(0.12, 600, 0.25); this.tone(220, 0.1, 'square', 0.05, -80); }
  cash() {
    this.tone(1568, 0.08, 'square', 0.1);
    this.tone(2093, 0.3, 'square', 0.1, 0, 0.07);
    this.noise(0.25, 7000, 0.06, 0.05, 'highpass');
  }
  hired() { this.arpeggio([523, 659, 784, 1047], 0.09, 0.25, 'triangle', 0.18); }
  rejected() { this.tone(330, 0.2, 'triangle', 0.15, -40); this.tone(262, 0.35, 'triangle', 0.15, -40, 0.16); }
  glug() { this.tone(180 + Math.random() * 60, 0.08, 'sine', 0.12, 120); }
  sputter() { for (let k = 0; k < 5; k++) this.noise(0.06, 300, 0.25 * (1 - k / 6), k * 0.14); this.tone(90, 0.8, 'sawtooth', 0.08, -50, 0.6); }
  gnome() { this.tone(900, 0.1, 'square', 0.12, 500); this.tone(500, 0.2, 'triangle', 0.15, -200, 0.08); }
  done() { this.arpeggio([523, 659, 784, 1047, 1319], 0.08, 0.35, 'triangle', 0.2); this.noise(0.6, 6000, 0.06, 0.1, 'highpass'); }
  evening() { this.arpeggio([784, 659, 523, 392], 0.2, 0.5, 'sine', 0.18); }
  morning() { this.arpeggio([392, 523, 659, 784], 0.12, 0.35, 'triangle', 0.16); }
  trim() { this.noise(0.05, 3200 + Math.random() * 1500, 0.12, 0, 'bandpass'); this.noise(0.05, 2800, 0.1, 0.06, 'bandpass'); }
  horn() { this.tone(392, 0.25, 'square', 0.08); this.tone(330, 0.3, 'square', 0.08, 0, 0.22); }
  unlock2() { this.arpeggio([392, 523, 659, 784, 1047, 1319], 0.1, 0.4, 'triangle', 0.2); }
  strike() { this.tone(196, 0.5, 'sawtooth', 0.1, -60); }

  private rainGain: GainNode | null = null;
  /** Rain on the roof: a looped band of noise faded to `level` (0..1). */
  rain(level: number) {
    if (!this.ctx || !this.master || !this.noiseBuf) return;
    if (!this.rainGain) {
      if (level < 0.01) return;
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      src.loop = true;
      const f = this.ctx.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = 1400; f.Q.value = 0.4;
      this.rainGain = this.ctx.createGain();
      this.rainGain.gain.value = 0;
      src.connect(f).connect(this.rainGain).connect(this.master);
      src.start();
    }
    this.rainGain.gain.setTargetAtTime(level * 0.16, this.ctx.currentTime, 0.5);
  }
}
