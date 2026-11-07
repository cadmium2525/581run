/**
 * ゲーム進行（描画から独立したシミュレーション）。
 * - 固定タイムステップ (1/60 秒) で更新するので端末性能に関係なく同じ挙動になる。
 * - 581万人すべては計算しない。プレイヤー周辺の数百人だけを個別に動かし、
 *   順位は群衆全体の「先頭」「最後尾」と密度分布から決定論的に求める。
 */
import { Rng } from './rng';

export const N_TOTAL = 5_812_375;
export const COURSE = 100; // m
export const HALF_W = 6.6; // 走路の半幅 (m)
export const DT = 1 / 60;

// 群衆（ゲーム的に圧縮した 581 万人の流れ）
const FRONT0 = 36; // 先頭の初期位置
const FRONT_V = 2.6; // 先頭の速さ
const BACK0 = 1.4; // 最後尾（プレイヤーの 1 つ前）の初期位置
const BACK_V = 1.6;
const RANK_K = 3; // 順位カーブ（先頭付近ほど人がまばら）
const DENS_MAX = 0.72; // 最後尾付近の密度 (人/m²)
const AHEAD = 46; // 前方の生成範囲
const BEHIND = 14; // 後方の消去範囲

// プレイヤー
const P_SPEED = 6.0;
const P_DASH = 8.3;
const P_ACCEL = 7;
const P_LAT = 4.4;
const BODY_R = 0.26;
const STEP_CD = 0.75;

export const enum NState {
  Run = 0,
  Stumble = 1,
  Fallen = 2,
  Getup = 3,
}

export interface Npc {
  id: number;
  active: boolean;
  leader: boolean;
  x: number;
  z: number;
  vx: number;
  v: number; // 現在の前進速度
  baseV: number;
  wander: number;
  wanderT: number;
  skill: number; // 転倒者を避けるうまさ
  state: NState;
  t: number; // 状態タイマー
  phase: number; // 走りアニメ位相
  fallDir: number; // 倒れる向き（横ずれ）
  hat: number; // 0=赤 1=白
  tint: number;
  bumpCd: number;
}

export type GameEvent =
  | { type: 'npcStumble'; x: number; z: number }
  | { type: 'npcFall'; x: number; z: number; chain: boolean }
  | { type: 'bump'; x: number; z: number }
  | { type: 'trip'; x: number; z: number }
  | { type: 'playerFall'; x: number; z: number }
  | { type: 'sidestep' }
  | { type: 'hop' }
  | { type: 'land' }
  | { type: 'passLeader' }
  | { type: 'leaderFinish' }
  | { type: 'finish' };

export interface InputState {
  steer: number; // -1..1 (正=右)
  step: boolean; // 押した瞬間のみ true
  dash: boolean;
}

export const enum PState {
  Run = 0,
  Fallen = 1,
  Getup = 2,
}

export interface Player {
  x: number;
  z: number;
  y: number; // ホップの高さ
  vx: number;
  v: number;
  state: PState;
  t: number;
  balance: number; // 0..100
  balanceCd: number;
  stamina: number; // 0..1
  dashing: boolean;
  stepCd: number;
  sideT: number;
  sideDir: number;
  hopT: number;
  iframe: number;
  phase: number;
  falls: number;
  bumps: number;
  wobble: number;
}

const HOP_TIME = 0.46;
const HOP_H = 0.6;

export class Game {
  readonly rng: Rng;
  readonly evRng: Rng;
  readonly npcs: Npc[] = [];
  readonly player: Player;
  events: GameEvent[] = [];
  time = 0; // 経過秒（固定ステップ数 × DT）
  steps = 0;
  started = false;
  finished = false;
  cleared = false;
  front = FRONT0;
  back = BACK0;
  finishRank = N_TOTAL;
  leaderPassed = false;
  leaderFinished = false;
  private spawnEdge = BACK0;
  private spawnDebt = 0;
  // 空間グリッド
  private readonly cellHead: Int32Array;
  private readonly cellNext: Int32Array;
  private gridZ0 = 0;
  static readonly POOL = 320;
  static readonly GRID_COLS = 16;
  static readonly GRID_ROWS = 84;

  constructor(readonly seed: number) {
    this.rng = new Rng(seed);
    this.evRng = new Rng(seed ^ 0x5bd1e995);
    for (let i = 0; i < Game.POOL; i++) {
      this.npcs.push({
        id: i,
        active: false,
        leader: false,
        x: 0,
        z: 0,
        vx: 0,
        v: 0,
        baseV: 0,
        wander: 0,
        wanderT: 0,
        skill: 0,
        state: NState.Run,
        t: 0,
        phase: 0,
        fallDir: 0,
        hat: 0,
        tint: 0,
        bumpCd: 0,
      });
    }
    this.cellHead = new Int32Array(Game.GRID_COLS * Game.GRID_ROWS);
    this.cellNext = new Int32Array(Game.POOL);
    this.player = {
      x: 0,
      z: 0,
      y: 0,
      vx: 0,
      v: 0,
      state: PState.Run,
      t: 0,
      balance: 100,
      balanceCd: 0,
      stamina: 1,
      dashing: false,
      stepCd: 0,
      sideT: 0,
      sideDir: 0,
      hopT: 0,
      iframe: 0,
      phase: 0,
      falls: 0,
      bumps: 0,
      wobble: 0,
    };
    // 先頭ランナー
    const leader = this.npcs[0];
    this.activate(leader, 0.4, FRONT0, FRONT_V);
    leader.leader = true;
    leader.hat = 2;
    leader.skill = 1;
    // スタート時の群衆を配置（静止状態）
    this.fillSpawn(Math.min(FRONT0 - 0.6, AHEAD));
    for (const n of this.npcs) if (n.active) n.v = 0;
  }

  /** 位置 z における群衆内の相対位置 u（0=先頭, 1=最後尾） */
  private crowdU(z: number): number {
    const span = Math.max(1, this.front - this.back);
    return Math.min(1, Math.max(0, (this.front - z) / span));
  }

  private density(z: number): number {
    const u = this.crowdU(z);
    return DENS_MAX * (0.16 + 0.84 * Math.pow(u, 1.25));
  }

  private localSpeed(z: number): number {
    const u = this.crowdU(z);
    return FRONT_V + (BACK_V - FRONT_V) * u;
  }

  /** 現在の順位（自分より前にいる人数 + 1） */
  rank(): number {
    return this.rankAt(this.player.z);
  }

  rankAt(z: number): number {
    if (z >= this.front) return 1;
    const u = this.crowdU(z);
    const ahead = Math.ceil((N_TOTAL - 1) * Math.pow(u, RANK_K));
    return Math.min(N_TOTAL, Math.max(2, ahead + 1));
  }

  private activate(n: Npc, x: number, z: number, v: number) {
    const r = this.rng;
    n.active = true;
    n.leader = false;
    n.x = x;
    n.z = z;
    n.vx = 0;
    n.baseV = v;
    n.v = v;
    n.wander = r.range(-0.4, 0.4);
    n.wanderT = r.range(0.5, 2.5);
    n.skill = r.next();
    n.state = NState.Run;
    n.t = 0;
    n.phase = r.range(0, Math.PI * 2);
    n.fallDir = r.range(-0.6, 0.6);
    n.hat = r.chance(0.5) ? 0 : 1;
    n.tint = r.next();
    n.bumpCd = 0;
  }

  private freeNpc(): Npc | null {
    for (let i = 1; i < this.npcs.length; i++) if (!this.npcs[i].active) return this.npcs[i];
    return null;
  }

  /** 群衆の流れに乗って移動する生成境界 spawnEdge から target までを密度に応じて埋める */
  private fillSpawn(target: number) {
    const r = this.rng;
    const top = Math.min(target, this.front - 0.6);
    if (top <= this.spawnEdge) return;
    const step = 0.5;
    for (let z0 = this.spawnEdge; z0 < top; z0 += step) {
      const len = Math.min(step, top - z0);
      this.spawnDebt += this.density(z0 + len / 2) * len * HALF_W * 2;
      while (this.spawnDebt >= 1) {
        this.spawnDebt -= 1;
        const n = this.freeNpc();
        if (!n) {
          this.spawnDebt = 0;
          break;
        }
        let x = 0;
        let z = 0;
        let ok = false;
        for (let tries = 0; tries < 6 && !ok; tries++) {
          x = r.range(-HALF_W + 0.3, HALF_W - 0.3);
          z = z0 + r.next() * len;
          ok = true;
          for (const m of this.npcs) {
            if (!m.active) continue;
            const dx = m.x - x;
            const dz = m.z - z;
            if (dx * dx + dz * dz < 0.36) {
              ok = false;
              break;
            }
          }
        }
        const v = this.localSpeed(z) + r.range(-0.35, 0.35);
        this.activate(n, x, z, v);
      }
    }
    this.spawnEdge = top;
  }

  private buildGrid() {
    this.cellHead.fill(-1);
    this.gridZ0 = this.player.z - BEHIND - 2;
    for (const n of this.npcs) {
      if (!n.active) continue;
      const c = this.cellOf(n.x, n.z);
      if (c < 0) continue;
      this.cellNext[n.id] = this.cellHead[c];
      this.cellHead[c] = n.id;
    }
  }

  private cellOf(x: number, z: number): number {
    const col = Math.floor(x + 8);
    const row = Math.floor(z - this.gridZ0);
    if (col < 0 || col >= Game.GRID_COLS || row < 0 || row >= Game.GRID_ROWS) return -1;
    return row * Game.GRID_COLS + col;
  }

  /** 近傍 NPC を列挙 */
  private forNear(x: number, z: number, fn: (m: Npc) => void) {
    const col = Math.floor(x + 8);
    const row = Math.floor(z - this.gridZ0);
    for (let r = row - 1; r <= row + 2; r++) {
      if (r < 0 || r >= Game.GRID_ROWS) continue;
      for (let c = col - 1; c <= col + 1; c++) {
        if (c < 0 || c >= Game.GRID_COLS) continue;
        for (let id = this.cellHead[r * Game.GRID_COLS + c]; id >= 0; id = this.cellNext[id]) fn(this.npcs[id]);
      }
    }
  }

  start() {
    this.started = true;
    for (const n of this.npcs) if (n.active) n.v = n.baseV * 0.3;
  }

  private stumble(n: Npc) {
    if (n.state !== NState.Run) return;
    n.state = NState.Stumble;
    n.t = this.evRng.range(0.55, 0.8);
    this.events.push({ type: 'npcStumble', x: n.x, z: n.z });
  }

  private fall(n: Npc, chain: boolean) {
    n.state = NState.Fallen;
    n.t = this.evRng.range(1.9, 2.6);
    n.v = Math.min(n.v, 1.2);
    this.events.push({ type: 'npcFall', x: n.x, z: n.z, chain });
  }

  update(input: InputState) {
    this.events = [];
    if (!this.started || this.finished) return;
    this.steps++;
    this.time = this.steps * DT;

    this.front += FRONT_V * DT;
    this.back += BACK_V * DT;
    this.spawnEdge += this.localSpeed(this.spawnEdge) * DT;
    this.fillSpawn(this.player.z + AHEAD);

    this.buildGrid();
    this.updateNpcs();
    this.updatePlayer(input);

    // 先頭関連のイベント
    if (!this.leaderPassed && this.player.z > this.front) {
      this.leaderPassed = true;
      this.events.push({ type: 'passLeader' });
    }
    if (!this.leaderFinished && this.front >= COURSE) {
      this.leaderFinished = true;
      this.events.push({ type: 'leaderFinish' });
    }
    if (this.player.z >= COURSE) {
      this.finished = true;
      this.finishRank = this.rankAt(COURSE);
      this.cleared = this.finishRank === 1;
      this.events.push({ type: 'finish' });
    }
  }

  private updateNpcs() {
    const p = this.player;
    const er = this.evRng;
    for (const n of this.npcs) {
      if (!n.active) continue;
      if (n.z < p.z - BEHIND) {
        n.active = false;
        continue;
      }
      n.bumpCd = Math.max(0, n.bumpCd - DT);
      switch (n.state) {
        case NState.Run: {
          n.wanderT -= DT;
          if (n.wanderT <= 0) {
            n.wanderT = er.range(0.8, 2.6);
            n.wander = er.range(-0.5, 0.5);
          }
          let targetV = n.baseV;
          let steer = n.wander;
          // 前方確認：詰まり・転倒者の回避
          this.forNear(n.x, n.z, (m) => {
            if (m === n) return;
            const dz = m.z - n.z;
            const dx = m.x - n.x;
            if (dz <= 0 || dz > 2.6) return;
            if (m.state === NState.Fallen) {
              if (Math.abs(dx) < 0.9 && n.skill > 0.35) steer += dx > 0 ? -1.6 : 1.6;
            } else if (dz < 0.9 && Math.abs(dx) < 0.45) {
              targetV = Math.min(targetV, m.v + 0.1);
              steer += dx > 0 ? -0.6 : 0.6;
            }
          });
          if (n.leader) {
            targetV = FRONT_V;
            steer = -n.x * 0.5;
          } else if (n.z > this.front - 0.35) {
            targetV = Math.min(targetV, FRONT_V * 0.97);
          }
          n.v += Math.max(-6 * DT, Math.min(2.5 * DT, targetV - n.v));
          n.vx += (steer * 1.1 - n.vx) * Math.min(1, 6 * DT);
          // 自然なつまずき（前兆あり）
          const crowd = this.density(n.z) / DENS_MAX;
          if (!n.leader && er.chance((0.006 + 0.012 * crowd) * DT)) this.stumble(n);
          break;
        }
        case NState.Stumble:
          n.t -= DT;
          n.v *= 1 - 1.4 * DT;
          n.vx += (n.fallDir - n.vx) * 3 * DT;
          if (n.t <= 0) {
            if (er.chance(0.7)) this.fall(n, false);
            else n.state = NState.Run;
          }
          break;
        case NState.Fallen:
          n.t -= DT;
          n.v = Math.max(0, n.v - 4 * DT);
          n.vx *= 1 - 5 * DT;
          if (n.t <= 0) {
            n.state = NState.Getup;
            n.t = 0.65;
          }
          break;
        case NState.Getup:
          n.t -= DT;
          n.v = 0;
          n.vx = 0;
          if (n.t <= 0) {
            n.state = NState.Run;
            n.v = 0.5;
          }
          break;
      }
      n.z += n.v * DT;
      n.x += n.vx * DT;
      if (n.leader) n.z = Math.min(n.z, this.front);
      if (n.x < -HALF_W + 0.25) {
        n.x = -HALF_W + 0.25;
        n.vx = Math.abs(n.vx) * 0.3;
      } else if (n.x > HALF_W - 0.25) {
        n.x = HALF_W - 0.25;
        n.vx = -Math.abs(n.vx) * 0.3;
      }
      n.phase += (n.v * 2.6 + 0.2) * DT;
    }

    // NPC 同士の接触：押し合い・転倒の連鎖
    for (const n of this.npcs) {
      if (!n.active) continue;
      this.forNear(n.x, n.z, (m) => {
        if (m.id <= n.id || !m.active) return;
        const dx = m.x - n.x;
        const dz = m.z - n.z;
        const d2 = dx * dx + dz * dz;
        const nUp = n.state !== NState.Fallen;
        const mUp = m.state !== NState.Fallen;
        if (nUp && mUp) {
          if (d2 < 0.46 * 0.46 && d2 > 1e-6) {
            const d = Math.sqrt(d2);
            const push = (0.46 - d) * 0.5;
            const ux = dx / d;
            const uz = dz / d;
            n.x -= ux * push;
            n.z -= uz * push;
            m.x += ux * push;
            m.z += uz * push;
            if (n.state === NState.Stumble && m.state === NState.Run && er.chance(0.25 * DT * 10)) this.stumble(m);
            if (m.state === NState.Stumble && n.state === NState.Run && er.chance(0.25 * DT * 10)) this.stumble(n);
          }
        } else if (nUp !== mUp) {
          // 転倒者に足を取られる
          const runner = nUp ? n : m;
          const down = nUp ? m : n;
          const hx = down.x + down.fallDir * 0.3;
          const hz = down.z + 0.45;
          const ex = runner.x - hx;
          const ez = runner.z - hz;
          if (ex * ex + ez * ez < 0.55 * 0.55 && runner.z < hz && runner.state === NState.Run && runner.bumpCd <= 0) {
            runner.bumpCd = 0.8;
            if (er.chance(runner.leader ? 0.05 : 0.8 - runner.skill * 0.35)) this.fall(runner, true);
          }
        }
      });
    }
  }

  private updatePlayer(input: InputState) {
    const p = this.player;
    const er = this.evRng;
    p.stepCd = Math.max(0, p.stepCd - DT);
    p.iframe = Math.max(0, p.iframe - DT);
    p.balanceCd = Math.max(0, p.balanceCd - DT);
    p.wobble = Math.max(0, p.wobble - DT * 2);

    if (p.state === PState.Fallen) {
      p.t -= DT;
      p.v = Math.max(0, p.v - 9 * DT);
      p.vx *= 1 - 6 * DT;
      if (p.t <= 0) {
        p.state = PState.Getup;
        p.t = 0.45;
      }
    } else if (p.state === PState.Getup) {
      p.t -= DT;
      p.v = 0;
      p.vx = 0;
      if (p.t <= 0) {
        p.state = PState.Run;
        p.balance = 100;
        p.iframe = 1.0; // 起き上がり直後の無敵（理不尽な連続転倒を防ぐ）
      }
    } else {
      // ダッシュ（スタミナ制）
      p.dashing = input.dash && p.stamina > 0.02;
      if (p.dashing) p.stamina = Math.max(0, p.stamina - 0.5 * DT);
      else p.stamina = Math.min(1, p.stamina + 0.2 * DT);
      const target = p.dashing ? P_DASH : P_SPEED;
      p.v += Math.max(-14 * DT, Math.min(P_ACCEL * DT, target - p.v));

      // 回避アクション：方向入力ありなら横ステップ、なしならホップ（転倒者を飛び越せる）
      if (input.step && p.stepCd <= 0 && p.hopT <= 0) {
        p.stepCd = STEP_CD;
        if (Math.abs(input.steer) > 0.25) {
          p.sideT = 0.2;
          p.sideDir = Math.sign(input.steer);
          p.iframe = Math.max(p.iframe, 0.3);
          this.events.push({ type: 'sidestep' });
        } else {
          p.hopT = HOP_TIME;
          this.events.push({ type: 'hop' });
        }
      }
      let targetVx = input.steer * P_LAT;
      if (p.sideT > 0) {
        p.sideT -= DT;
        targetVx = p.sideDir * 9.5;
        p.vx = targetVx;
      }
      p.vx += (targetVx - p.vx) * Math.min(1, 18 * DT);
    }

    if (p.hopT > 0) {
      p.hopT -= DT;
      const k = 1 - Math.max(0, p.hopT) / HOP_TIME;
      p.y = Math.sin(k * Math.PI) * HOP_H;
      if (p.hopT <= 0) {
        p.y = 0;
        this.events.push({ type: 'land' });
      }
    }

    p.z += p.v * DT;
    p.x += p.vx * DT;
    p.x = Math.max(-HALF_W + BODY_R, Math.min(HALF_W - BODY_R, p.x));
    p.phase += (p.v * 2.5 + 0.2) * DT;

    if (p.state !== PState.Run) return;

    // 接触判定
    const rr = BODY_R + 0.24;
    this.forNear(p.x, p.z, (n) => {
      if (!n.active) return;
      const dx = p.x - n.x;
      const dz = p.z - n.z;
      if (n.state === NState.Fallen) {
        // 倒れている子：足元の障害ゾーン
        const hx = n.x + n.fallDir * 0.3;
        const hz = n.z + 0.45;
        const ex = p.x - hx;
        const ez = p.z - hz;
        if (ex * ex + ez * ez < 0.6 * 0.6 && p.y < 0.22 && p.iframe <= 0 && n.bumpCd <= 0) {
          n.bumpCd = 0.7;
          this.hitBalance(46);
          p.v *= 0.45;
          p.wobble = 1;
          this.events.push({ type: 'trip', x: n.x, z: n.z });
        }
        return;
      }
      const d2 = dx * dx + dz * dz;
      if (d2 >= rr * rr) return;
      const d = Math.sqrt(d2) || 0.001;
      const ux = dx / d;
      const uz = dz / d;
      const overlap = rr - d;
      if (p.y > 0.35) return; // 跳んでいる間は頭上を抜ける
      // 押し合い：プレイヤーは横へずれ、前の子に詰まる
      p.x += ux * overlap * 0.7;
      p.z += uz * overlap * 0.5;
      n.x -= ux * overlap * 0.3;
      if (n.z > p.z) p.v = Math.min(p.v, Math.max(n.v, 1.5));
      if (p.iframe <= 0 && n.bumpCd <= 0) {
        n.bumpCd = 0.5;
        p.bumps++;
        this.hitBalance(n.state === NState.Stumble ? 26 : 15);
        p.wobble = 0.6;
        this.events.push({ type: 'bump', x: n.x, z: n.z });
        // ぶつかられた子もよろける → 連鎖のきっかけ
        if (!n.leader && er.chance(0.35)) this.stumble(n);
      }
    });

    if (p.balanceCd <= 0) p.balance = Math.min(100, p.balance + 11 * DT);
    if (p.balance <= 0) {
      p.state = PState.Fallen;
      p.t = 1.25;
      p.falls++;
      p.hopT = 0;
      p.y = 0;
      this.events.push({ type: 'playerFall', x: p.x, z: p.z });
    }
  }

  private hitBalance(amount: number) {
    const p = this.player;
    p.balance = Math.max(0, p.balance - amount);
    p.balanceCd = 1.0;
  }
}
