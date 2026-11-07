/** 効果音はすべて Web Audio でその場合成（素材費 0 円・外部ファイルなし） */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private crowd: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  enabled = true;

  /** ユーザー操作の中で呼ぶ（iOS の自動再生制限対策） */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.6;
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate * 2;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      // 群衆のざわめき（ループするフィルタ付きノイズ）
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      src.loop = true;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 700;
      bp.Q.value = 0.6;
      this.crowd = this.ctx.createGain();
      this.crowd.gain.value = 0;
      src.connect(bp).connect(this.crowd).connect(this.master);
      src.start();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (this.master) this.master.gain.value = on ? 0.6 : 0;
  }

  setCrowd(level: number) {
    if (!this.ctx || !this.crowd) return;
    this.crowd.gain.setTargetAtTime(level * 0.18, this.ctx.currentTime, 0.3);
  }

  private tone(freq: number, dur: number, type: OscillatorType, vol: number, slideTo?: number, delay = 0) {
    if (!this.ctx || !this.master || !this.enabled) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private noise(dur: number, vol: number, freq: number, q = 1, delay = 0) {
    if (!this.ctx || !this.master || !this.noiseBuf || !this.enabled) return;
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + dur + 0.02);
  }

  beep(high = false) {
    this.tone(high ? 1320 : 880, 0.18, 'square', 0.12);
  }
  pistol() {
    this.noise(0.35, 0.9, 1800, 0.4);
    this.tone(160, 0.2, 'sawtooth', 0.25, 60);
  }
  bump() {
    this.tone(180, 0.09, 'sine', 0.35, 90);
  }
  trip() {
    this.tone(320, 0.18, 'triangle', 0.3, 120);
  }
  npcFall(dist: number) {
    const v = Math.max(0, 0.22 - dist * 0.008);
    if (v <= 0.01) return;
    this.tone(260 + Math.random() * 80, 0.16, 'sine', v, 90);
    this.noise(0.12, v * 0.8, 400, 1.2, 0.02);
  }
  playerFall() {
    this.tone(420, 0.35, 'triangle', 0.4, 70);
    this.noise(0.25, 0.5, 300, 1, 0.05);
  }
  whoosh() {
    this.noise(0.18, 0.35, 2400, 2);
  }
  hop() {
    this.tone(500, 0.15, 'sine', 0.2, 900);
  }
  step() {
    this.noise(0.04, 0.12, 900, 3);
  }
  passLeader() {
    [660, 880, 1100].forEach((f, i) => this.tone(f, 0.15, 'square', 0.1, undefined, i * 0.08));
  }
  fanfare(win: boolean) {
    const notes = win ? [523, 659, 784, 1047, 784, 1047] : [440, 415, 392, 330];
    notes.forEach((f, i) => this.tone(f, win ? 0.22 : 0.3, 'square', 0.12, undefined, i * (win ? 0.12 : 0.22)));
  }
}
