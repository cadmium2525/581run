/**
 * 効果音は Web Audio でその場合成（素材費 0 円）。
 * BGM（天国と地獄風ギャロップ）は scripts/bgm/ の曲 JSON から「かなでる」で書き出した MP3 をループ再生する。
 */
const BGM_LOOP_SEC = (96 * 60) / 176; // 48 小節（2/4 拍子・176 BPM）

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private crowd: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  enabled = true;
  bgmEnabled = true;
  private bgmBytes: Promise<ArrayBuffer> | null = null;
  private bgmBuf: AudioBuffer | null = null;
  private bgmLoopStart = 0;
  private bgmGain: GainNode | null = null;
  private bgmSrc: AudioBufferSourceNode | null = null;
  private bgmStartedAt = 0;
  private bgmOffset = 0;
  private bgmWanted = false;

  /** BGM のファイルを先に読み込んでおく（デコードは AudioContext ができてから） */
  preloadBgm(url: string) {
    this.bgmBytes = fetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .catch(() => new ArrayBuffer(0));
  }

  private async decodeBgm() {
    if (this.bgmBuf || !this.ctx || !this.bgmBytes) return;
    const bytes = await this.bgmBytes;
    if (!bytes.byteLength || this.bgmBuf) return;
    try {
      const buf = await this.ctx.decodeAudioData(bytes.slice(0));
      // MP3 の先頭の無音（エンコーダー遅延）を飛ばしてループ位置を決める
      const d = buf.getChannelData(0);
      let i = 0;
      while (i < d.length && Math.abs(d[i]) < 0.003) i++;
      this.bgmLoopStart = i / buf.sampleRate;
      this.bgmBuf = buf;
      if (this.bgmWanted && !this.bgmSrc) this.playBgm();
    } catch {
      /* 再生できない形式なら BGM なしで続行 */
    }
  }

  /** BGM を再生（一時停止した位置から再開） */
  playBgm(fromStart = false) {
    this.bgmWanted = true;
    if (fromStart) this.bgmOffset = 0;
    if (!this.ctx || !this.bgmGain) return;
    if (!this.bgmBuf) {
      void this.decodeBgm();
      return;
    }
    this.stopSource();
    const src = this.ctx.createBufferSource();
    src.buffer = this.bgmBuf;
    src.loop = true;
    src.loopStart = this.bgmLoopStart;
    src.loopEnd = Math.min(this.bgmBuf.duration, this.bgmLoopStart + BGM_LOOP_SEC);
    src.connect(this.bgmGain);
    this.bgmGain.gain.cancelScheduledValues(this.ctx.currentTime);
    this.bgmGain.gain.setValueAtTime(this.bgmEnabled ? 0.55 : 0, this.ctx.currentTime);
    src.start(0, this.bgmLoopStart + this.bgmOffset);
    this.bgmSrc = src;
    this.bgmStartedAt = this.ctx.currentTime - this.bgmOffset;
  }

  private stopSource() {
    if (this.bgmSrc) {
      try {
        this.bgmSrc.stop();
      } catch {
        /* noop */
      }
      this.bgmSrc.disconnect();
      this.bgmSrc = null;
    }
  }

  /** 一時停止（位置を覚えておく） */
  pauseBgm() {
    this.bgmWanted = false;
    if (!this.ctx || !this.bgmSrc) return;
    this.bgmOffset = (this.ctx.currentTime - this.bgmStartedAt) % BGM_LOOP_SEC;
    this.stopSource();
  }

  /** フェードアウトして止める */
  stopBgm(fade = 0.6) {
    this.bgmWanted = false;
    this.bgmOffset = 0;
    if (!this.ctx || !this.bgmGain || !this.bgmSrc) return;
    const t = this.ctx.currentTime;
    this.bgmGain.gain.cancelScheduledValues(t);
    this.bgmGain.gain.setValueAtTime(this.bgmGain.gain.value, t);
    this.bgmGain.gain.linearRampToValueAtTime(0, t + fade);
    const src = this.bgmSrc;
    this.bgmSrc = null;
    src.stop(t + fade + 0.05);
  }

  setBgmEnabled(on: boolean) {
    this.bgmEnabled = on;
    if (this.ctx && this.bgmGain && this.bgmSrc) this.bgmGain.gain.setTargetAtTime(on ? 0.55 : 0, this.ctx.currentTime, 0.05);
  }

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
      this.bgmGain = this.ctx.createGain();
      this.bgmGain.gain.value = 0;
      this.bgmGain.connect(this.ctx.destination);
      void this.decodeBgm();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (this.master) this.master.gain.value = on ? 0.6 : 0;
  }

  setCrowd(level: number) {
    if (!this.ctx || !this.crowd) return;
    this.crowd.gain.setTargetAtTime(level * 0.1, this.ctx.currentTime, 0.3);
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

  /** カメラのシャッター（カシャッ） */
  shutter() {
    this.noise(0.025, 0.7, 4200, 1.5);
    this.tone(2400, 0.02, 'square', 0.12);
    this.noise(0.07, 0.5, 1800, 1.2, 0.045);
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
