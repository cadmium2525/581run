/** キーボード＋タッチ入力 */
import type { InputState } from './game';

export class Input {
  private keys = new Set<string>();
  private stepQueued = false;
  private dashTouch = false;
  private pointers = new Map<number, { x0: number; x: number; drag: boolean }>();
  onPause: (() => void) | null = null;
  onAnyKey: ((code: string) => void) | null = null;

  constructor(touchArea: HTMLElement, stepBtn: HTMLElement, dashBtn: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) {
        if (['Space', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
        return;
      }
      this.keys.add(e.code);
      if (e.code === 'Space') {
        this.stepQueued = true;
        e.preventDefault();
      }
      if (e.code === 'Escape') this.onPause?.();
      this.onAnyKey?.(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.pointers.clear();
      this.dashTouch = false;
    });

    // 画面の左半分／右半分を長押し、またはドラッグで左右移動
    touchArea.addEventListener('pointerdown', (e) => {
      touchArea.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x0: e.clientX, x: e.clientX, drag: false });
    });
    touchArea.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      p.x = e.clientX;
      if (Math.abs(p.x - p.x0) > 14) p.drag = true;
    });
    const end = (e: PointerEvent) => this.pointers.delete(e.pointerId);
    touchArea.addEventListener('pointerup', end);
    touchArea.addEventListener('pointercancel', end);

    const press = (el: HTMLElement, down: () => void, up?: () => void) => {
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.classList.add('pressed');
        down();
      });
      const release = () => {
        el.classList.remove('pressed');
        up?.();
      };
      el.addEventListener('pointerup', release);
      el.addEventListener('pointercancel', release);
      el.addEventListener('pointerleave', release);
    };
    press(stepBtn, () => (this.stepQueued = true));
    press(
      dashBtn,
      () => (this.dashTouch = true),
      () => (this.dashTouch = false),
    );
    window.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  reset() {
    this.stepQueued = false;
  }

  read(): InputState {
    let steer = 0;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) steer -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) steer += 1;
    const half = window.innerWidth / 2;
    for (const p of this.pointers.values()) {
      if (p.drag) steer += Math.max(-1, Math.min(1, (p.x - p.x0) / 55));
      else steer += p.x < half ? -1 : 1;
    }
    steer = Math.max(-1, Math.min(1, steer));
    const step = this.stepQueued;
    this.stepQueued = false;
    const dash = this.dashTouch || this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    return { steer, step, dash };
  }
}
