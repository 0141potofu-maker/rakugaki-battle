const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// ---------- ゲーム設定(サーバーが正) ----------
const TICK = 60;
const DT = 1 / TICK;
const SEND_EVERY = 2; // 2tickごとに送信 = 30回/秒
const MAX_PLAYERS = 4;
const SCALE = 0.8; // 描いた絵の1ピクセル = ゲーム内の0.8

const STAGE = { w: 1800, top: 0, depth: 300, wall: 180 }; // 終点風。上面が y=0、wallは垂直な側面の高さ
const BLAST = { x: 1500, top: -1200, bottom: 900 }; // これを超えたら撃墜
const PHYS = {
  run: 430,
  groundAcc: 3200,
  airAcc: 1800,
  groundFric: 3600,
  airFric: 500,
  gravity: 2600,
  maxFall: 1200,
  jump: 1139,    // ジャンプの高さが約1.5倍になる強さ
  airJump: 1004,
};

// 仮の通常攻撃(パンチ)。色ごとの技はあとのステップで入れ替える
const ATK = { startup: 7, active: 7, total: 26, dmg: 7 };
const STOCKS = 3;           // 残機
const RESPAWN_FRAMES = 90;  // 撃墜されてから復活するまで(1.5秒)
const INV_FRAMES = 150;     // 復活してからの無敵(2.5秒)

// ---------- プレイヤー ----------
function makePlayer(slot) {
  return {
    slot,
    ws: null,
    active: false, // 絵を出して、試合に参加している
    rig: null,     // 描いた絵(からだ+手足のパーツ)
    hb: [0, 0, 56, 84], // 食らい判定(からだだけ。手足はふくまない)
    limbs: [],     // 手足の大きさ(攻撃判定に使う)
    bw: 56, bh: 84, // キャラの大きさ(ゲーム内)
    area: 0,        // 塗ったピクセル数(体重・速さに使う)
    colors: [0, 0, 0, 0, 0], // 赤・青・黄・白・黒のピクセル数(あとで技に使う)
    weight: 100,    // 体重(重いほど吹っ飛びにくい)
    speedMul: 1,    // 移動の速さの倍率
    gravMul: 1,     // 重力の倍率
    atkR: 20,       // 攻撃判定の大きさ(手の大きさで決まる)
    x: 0, y: 0, vx: 0, vy: 0,
    f: 1,          // 向き 1=右 -1=左
    g: true,       // 接地
    airJump: false, // 空中ジャンプ使用済み
    prevJ: false,
    prevL: false,
    prevR: false,
    prevA: false,
    hang: 0,   // 崖につかまり中: -1=左の崖 1=右の崖 0=なし
    hangT: 0,  // つかまっているフレーム数
    cd: 0,     // 崖につかまれるようになるまでのフレーム数
    dmg: 0,    // 蓄積ダメージ(%)
    stocks: STOCKS,
    life: 0,   // 0=戦っている 1=復活待ち 2=脱落
    respT: 0,  // 復活までのフレーム数
    inv: 0,    // 無敵のフレーム数
    stun: 0,   // のけぞりのフレーム数
    atk: null, // 攻撃中の状態 {t, hit}
    ko: false, // 撃墜されたばかり
    vote: false, // 「もういちど」を押した
    input: { l: 0, r: 0, j: 0, a: 0, b: 0 },
  };
}

// 面積から体重・速さ、手の大きさから攻撃判定の大きさを決める
function applyBody(p) {
  const lo = Math.log(400);
  const hi = Math.log(40000);
  const t = Math.max(0, Math.min(1, (Math.log(Math.max(p.area, 1)) - lo) / (hi - lo)));
  p.weight = 70 + 70 * t;          // 70(軽い)〜140(重い)
  p.speedMul = 1.35 - 0.65 * t;    // 1.35(速い)〜0.7(遅い)
  p.gravMul = 0.92 + 0.2 * t;      // 重いほど速く落ちる
  const hands = p.limbs.filter((l) => l.k === 'h').map((l) => l.a);
  const big = hands.length ? Math.max(...hands) : 0;
  p.atkR = big ? Math.max(18, Math.min(72, Math.sqrt(big / Math.PI) * SCALE * 1.4 + 12)) : 16;
}

function resetFighter(p) {
  p.dmg = 0;
  p.stocks = STOCKS;
  p.life = 0;
  p.respT = 0;
  p.inv = 0;
  p.vote = false;
}

function spawn(p, fromAir) {
  p.x = -300 + p.slot * 200;
  p.y = fromAir ? -450 : STAGE.top;
  p.vx = 0;
  p.vy = 0;
  p.g = !fromAir;
  p.airJump = false;
  p.prevJ = false;
  p.prevL = false;
  p.prevR = false;
  p.prevA = false;
  p.hang = 0;
  p.hangT = 0;
  p.cd = 0;
  p.stun = 0;
  p.atk = null;
  p.ko = false;
}

function respawn(p) {
  spawn(p, true);
  p.dmg = 0;
  p.inv = INV_FRAMES;
  p.life = 0;
}

// 撃墜されたとき
function koPlayer(r, p, events) {
  p.ko = false;
  events.push({
    k: 'ko',
    x: Math.max(-BLAST.x, Math.min(BLAST.x, p.x)),
    y: Math.max(BLAST.top, Math.min(BLAST.bottom, p.y)),
  });
  if (r.versus) p.stocks--;
  p.hang = 0;
  p.atk = null;
  p.stun = 0;
  p.vx = 0;
  p.vy = 0;
  if (p.stocks > 0 || !r.versus) {
    p.life = 1;
    p.respT = RESPAWN_FRAMES;
  } else {
    p.life = 2; // 残機がなくなった
  }
}

// ---------- 当たり判定 ----------
// 食らい判定(からだだけ。手足はふくまない)。左向きのときは左右反転
function hurtRect(p) {
  const hx = p.hb[0], hy = p.hb[1], hw = p.hb[2], hh = p.hb[3];
  const x0 = p.f >= 0 ? p.x - p.bw / 2 + hx : p.x + p.bw / 2 - hx - hw;
  const y0 = p.y - p.bh + hy;
  return { x0, y0, x1: x0 + hw, y1: y0 + hh };
}

function circleHitsRect(cx, cy, R, r) {
  const nx = Math.max(r.x0, Math.min(cx, r.x1));
  const ny = Math.max(r.y0, Math.min(cy, r.y1));
  return (cx - nx) ** 2 + (cy - ny) ** 2 <= R * R;
}

// 攻撃が当たったとき: ダメージを増やして、吹っ飛ばす
function applyHit(att, tgt, hx, hy, events) {
  tgt.dmg = Math.min(999, tgt.dmg + ATK.dmg);
  const kb = Math.min(1800, 320 + tgt.dmg * 11 * (100 / tgt.weight)); // ダメージが多いほど、軽いほど飛ぶ
  const ang = Math.PI / 4; // 斜め上45度
  tgt.vx = att.f * kb * Math.cos(ang);
  tgt.vy = -kb * Math.sin(ang);
  tgt.g = false;
  tgt.hang = 0;
  tgt.atk = null;
  tgt.stun = Math.min(70, Math.floor(kb / 18));
  events.push({ k: 'hit', x: +hx.toFixed(1), y: +hy.toFixed(1) });
}

function updateAttack(p, others, events) {
  const a = p.atk;
  if (!a) return;
  a.t++;
  if (a.t > ATK.startup && a.t <= ATK.startup + ATK.active) {
    const R = p.atkR;
    const cx = p.x + p.f * (p.bw / 2 + R * 0.4);
    const cy = p.y - p.bh * 0.55;
    for (const q of others) {
      if (q === p || q.life !== 0 || q.inv > 0 || q.hang || a.hit.includes(q.slot)) continue;
      if (circleHitsRect(cx, cy, R, hurtRect(q))) {
        a.hit.push(q.slot);
        applyHit(p, q, cx, cy, events);
      }
    }
  }
  if (p.atk && a.t >= ATK.total) p.atk = null;
}

// ---------- 動き ----------
// 崖(ステージのかど)につかまっている間の動き
function hangUpdate(p, pL, pR, pJ) {
  const s = p.hang; // -1=左の崖 1=右の崖
  const half = STAGE.w / 2;
  p.hangT++;
  p.vx = 0;
  p.vy = 0;
  p.x = s * (half + p.bw / 2);
  p.y = STAGE.top + p.bh + 6;
  p.f = -s; // ステージのほうを向く
  if (p.hangT < 12) return; // つかまった直後は少しの間、操作できない

  const toStage = s < 0 ? pR : pL; // ステージ側へ押す
  const away = s < 0 ? pL : pR;    // 反対側へ押す
  if (pJ) {
    // 飛び上がる
    p.hang = 0;
    p.cd = 30;
    p.vy = -PHYS.jump;
    p.vx = -s * 160;
    p.g = false;
  } else if (toStage) {
    // ステージにのぼる
    p.hang = 0;
    p.x = s * (half - p.bw / 2 - 6);
    p.y = STAGE.top;
    p.vx = 0;
    p.vy = 0;
    p.g = true;
    p.airJump = false;
  } else if (away || p.hangT > 300) {
    // はなす(つかまりつづけると5秒で自動ではなれる)
    p.hang = 0;
    p.cd = 40;
    p.vx = s * 80;
    p.g = false;
  }
}

// 崖につかまれるか調べる
function tryGrab(p, occ) {
  if (p.g || p.vy < 0 || p.cd > 0 || p.stun > 0) return;
  const s = p.x < 0 ? -1 : 1;
  if (p.f !== -s) return; // ステージのほうを向いているときだけ
  if (occ[s] !== undefined && occ[s] !== p.slot) return; // 先に誰かがつかまっている
  const half = STAGE.w / 2;
  const dy = p.y - p.bh - STAGE.top;          // 頭が崖の上面よりどれだけ下か
  const out = s * (p.x - (s * p.bw) / 2) - half; // 体のステージ側のはしが、かどより外へどれだけ出ているか
  if (dy < -20 || dy > 100 || out < -25 || out > 50) return;
  p.hang = s;
  p.hangT = 0;
  p.airJump = false; // つかまると空中ジャンプが回復
  p.atk = null;
  p.vx = 0;
  p.vy = 0;
  occ[s] = p.slot;
}

function step(p, occ, others, events) {
  const i = p.input;
  const pL = i.l && !p.prevL; // 押した瞬間
  const pR = i.r && !p.prevR;
  const pJ = i.j && !p.prevJ;
  const pA = i.a && !p.prevA;
  p.prevL = !!i.l;
  p.prevR = !!i.r;
  p.prevJ = !!i.j;
  p.prevA = !!i.a;
  if (p.cd > 0) p.cd--;
  if (p.inv > 0) p.inv--;

  if (p.hang) {
    hangUpdate(p, pL, pR, pJ);
    return;
  }

  const stunned = p.stun > 0;
  if (stunned) p.stun--;

  // 攻撃(のけぞり中はできない)
  if (!stunned && pA && !p.atk) p.atk = { t: 0, hit: [] };

  // 左右移動(地上で攻撃中・のけぞり中は動けない)
  const dir = stunned || (p.atk && p.g) ? 0 : (i.r ? 1 : 0) - (i.l ? 1 : 0);
  const maxRun = PHYS.run * p.speedMul;
  if (dir) {
    if (!p.atk) p.f = dir;
    const acc = p.g ? PHYS.groundAcc : PHYS.airAcc;
    const target = dir * maxRun;
    if (p.vx < target) p.vx = Math.min(target, p.vx + acc * DT);
    else p.vx = Math.max(target, p.vx - acc * DT);
  } else {
    const fr = p.g ? PHYS.groundFric : stunned ? 220 : PHYS.airFric;
    if (p.vx > 0) p.vx = Math.max(0, p.vx - fr * DT);
    else p.vx = Math.min(0, p.vx + fr * DT);
  }

  // ジャンプ(押した瞬間だけ)
  if (!stunned && pJ) {
    if (p.g) {
      p.vy = -PHYS.jump;
      p.g = false;
    } else if (!p.airJump) {
      p.vy = -PHYS.airJump;
      p.airJump = true;
    }
  }

  // 移動
  const prevY = p.y;
  if (!p.g) p.vy = Math.min(PHYS.maxFall, p.vy + PHYS.gravity * p.gravMul * DT);
  p.x += p.vx * DT;
  p.y += p.vy * DT;

  // ステージ
  const half = STAGE.w / 2;
  const edge = half + p.bw / 4;
  if (!p.g && p.vy >= 0 && prevY <= STAGE.top + 1 && p.y >= STAGE.top && Math.abs(p.x) <= edge) {
    p.y = STAGE.top;
    p.vy = 0;
    p.g = true;
    p.airJump = false; // 着地で回復
  } else if (p.g && Math.abs(p.x) > edge) {
    p.g = false;
  }
  // ステージの側面(壁)
  if (!p.g && p.y > STAGE.top + 24 && p.y < STAGE.top + STAGE.wall + p.bh && Math.abs(p.x) < half + p.bw / 2) {
    p.x = p.x < 0 ? -half - p.bw / 2 : half + p.bw / 2;
    p.vx = 0;
  }

  tryGrab(p, occ);        // 崖つかまり
  updateAttack(p, others, events);

  // 画面外に出たら撃墜
  if (Math.abs(p.x) > BLAST.x || p.y > BLAST.bottom || p.y < BLAST.top) p.ko = true;
}

// ---------- 部屋 ----------
const rooms = new Map();

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(r, obj) {
  const s = JSON.stringify(obj);
  for (const p of r.players.values()) {
    if (p.ws && p.ws.readyState === 1) p.ws.send(s);
  }
}

function rosterMsg(r) {
  return {
    t: 'roster',
    phase: r.phase,
    p: [...r.players.values()].map((p) => ({ s: p.slot, r: p.active ? 1 : 0, v: p.vote ? 1 : 0 })),
  };
}

function allReady(r) {
  if (r.players.size === 0) return false;
  for (const p of r.players.values()) if (!p.active) return false;
  return true;
}

function startMatch(r) {
  r.phase = 'play';
  r.versus = r.players.size >= 2;
  r.events = [];
  r.tick = 0;
  for (const p of r.players.values()) {
    resetFighter(p);
    spawn(p, false);
  }
  broadcast(r, rosterMsg(r));
}

// 試合終了。winner は勝った人の番号(ひきわけは -1)
function endMatch(r, winner) {
  r.phase = 'result';
  for (const p of r.players.values()) p.vote = false;
  broadcast(r, { t: 'result', w: winner });
  broadcast(r, rosterMsg(r));
}

// 全員が「もういちど」を押したら、同じキャラでもう一度
function checkRematch(r) {
  if (r.phase !== 'result') return;
  const act = [...r.players.values()].filter((p) => p.active);
  if (act.length === 0 || !act.every((p) => p.vote)) return;
  r.versus = act.length >= 2;
  r.events = [];
  r.tick = 0;
  for (const p of act) {
    resetFighter(p);
    spawn(p, false);
    p.inv = 60;
  }
  r.phase = 'play';
  broadcast(r, rosterMsg(r));
}

function artMsg(p) {
  return { t: 'art', s: p.slot, rig: p.rig, w: p.bw, h: p.bh };
}

// 届いた絵のデータを確認して、安全な形にそろえる
function cleanRig(r) {
  if (!r || typeof r !== 'object') return null;
  const w = Math.round(+r.w);
  const h = Math.round(+r.h);
  if (!(w >= 4 && w <= 256 && h >= 4 && h <= 256)) return null;
  const okImg = (v) => typeof v === 'string' && v.startsWith('data:image/png;base64,') && v.length <= 200000;
  if (!okImg(r.body)) return null;
  if (!Array.isArray(r.parts) || r.parts.length > 8) return null;
  const num = (v, max) => Math.max(0, Math.min(max, +v || 0));
  const parts = [];
  for (const p of r.parts) {
    if (!p || (p.k !== 'h' && p.k !== 'f') || !okImg(p.img)) return null;
    parts.push({
      k: p.k,
      i: Math.max(0, Math.min(7, Math.floor(+p.i) || 0)),
      img: p.img,
      x: num(p.x, 256), y: num(p.y, 256), w: num(p.w, 256), h: num(p.h, 256),
      px: num(p.px, 256), py: num(p.py, 256),
      a: Math.floor(num(p.a, 65536)),
      d0: Math.max(-7, Math.min(7, +p.d0 || 0)),
    });
  }
  const hb = Array.isArray(r.hb) && r.hb.length === 4 ? r.hb.map((v) => num(v, 256)) : [0, 0, w, h];
  const rig = { w, h, body: r.body, hb, parts };
  if (JSON.stringify(rig).length > 500000) return null;
  return rig;
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/r/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/healthz', (req, res) => res.send('ok'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 600 * 1024 });

function clampInt(v, max) {
  return Math.max(0, Math.min(max, Math.floor(+v) || 0));
}

wss.on('connection', (ws) => {
  let room = null;
  let player = null;

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.t === 'join' && !room) {
      const id = String(m.room || '').toLowerCase();
      if (!/^[a-z0-9]{3,12}$/.test(id)) return ws.close();

      let r = rooms.get(id);
      if (!r) {
        r = { id, players: new Map(), tick: 0, phase: 'draw', versus: false, events: [] };
        rooms.set(id, r);
      }
      let slot = -1;
      for (let s = 0; s < MAX_PLAYERS; s++) {
        if (!r.players.has(s)) { slot = s; break; }
      }
      if (slot < 0) {
        send(ws, { t: 'full' });
        return ws.close();
      }
      room = r;
      player = makePlayer(slot);
      player.ws = ws;
      r.players.set(slot, player);

      send(ws, { t: 'welcome', you: slot, room: id, stage: STAGE, phase: r.phase });
      for (const q of r.players.values()) {
        if (q.active && q.rig) send(ws, artMsg(q));
      }
      broadcast(r, rosterMsg(r));

    } else if (!player) {
      return;

    } else if (m.t === 'input') {
      player.input = { l: m.l ? 1 : 0, r: m.r ? 1 : 0, j: m.j ? 1 : 0, a: m.a ? 1 : 0, b: m.b ? 1 : 0 };

    } else if (m.t === 'art') {
      // 描いた絵を受け取る
      const rig = cleanRig(m.rig);
      if (!rig) return;
      if (room.phase !== 'draw' && player.active) return;

      player.rig = rig;
      player.bw = rig.w * SCALE;
      player.bh = rig.h * SCALE;
      player.hb = rig.hb.map((v) => v * SCALE);
      player.limbs = rig.parts.map((p) => ({ k: p.k, a: p.a }));
      player.area = clampInt(m.area, 65536);
      player.colors = Array.isArray(m.c) && m.c.length === 5 ? m.c.map((v) => clampInt(v, 65536)) : [0, 0, 0, 0, 0];
      applyBody(player);
      resetFighter(player);
      player.active = true;
      spawn(player, false);

      broadcast(room, artMsg(player));
      if (room.phase === 'draw' && room.players.size === MAX_PLAYERS && allReady(room)) {
        startMatch(room);
      } else {
        broadcast(room, rosterMsg(room));
      }

    } else if (m.t === 'redraw') {
      // 試合が始まる前なら、描き直せる
      if (room.phase === 'draw' && player.active) {
        player.active = false;
        player.rig = null;
        broadcast(room, rosterMsg(room));
      }

    } else if (m.t === 'start') {
      // 全員かけたら「はじめる」で試合開始
      if (room.phase === 'draw' && allReady(room)) startMatch(room);

    } else if (m.t === 'rematch') {
      // 試合のあと「もういちど」
      if (room.phase === 'result' && player.active) {
        player.vote = true;
        checkRematch(room);
        if (room.phase === 'result') broadcast(room, rosterMsg(room));
      }
    }
  });

  ws.on('close', () => {
    if (room && player) {
      room.players.delete(player.slot);
      if (room.players.size === 0) {
        rooms.delete(room.id);
      } else {
        checkRematch(room);
        broadcast(room, rosterMsg(room));
      }
    }
  });
});

// 接続が切れないように、定期的に声をかける
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.readyState === 1) ws.ping();
  }
}, 25000);

// ---------- メインループ ----------
setInterval(() => {
  for (const r of rooms.values()) {
    if (r.phase !== 'play') continue;
    r.tick++;

    const present = [...r.players.values()].filter((p) => p.active);
    if (present.length >= 2) r.versus = true;

    // 復活
    for (const p of present) {
      if (p.life === 1 && --p.respT <= 0) respawn(p);
    }

    // 戦っている人を動かす
    const alive = present.filter((p) => p.life === 0);
    const occ = {}; // 崖ごとに、つかまっている人
    for (const p of alive) if (p.hang) occ[p.hang] = p.slot;
    for (const p of alive) step(p, occ, alive, r.events);
    for (const p of alive) if (p.ko) koPlayer(r, p, r.events);

    // 勝敗(対戦のとき、残機が残っている人が1人以下になったら終わり)
    let ended = false;
    if (r.versus) {
      const holders = present.filter((p) => p.stocks > 0);
      if (holders.length <= 1) {
        endMatch(r, holders.length ? holders[0].slot : -1);
        ended = true;
      }
    }

    if (r.tick % SEND_EVERY === 0 || ended) {
      const msg = {
        t: 'state',
        p: present.map((p) => ({
          s: p.slot,
          x: +p.x.toFixed(1),
          y: +p.y.toFixed(1),
          f: p.f,
          g: p.g ? 1 : 0,
          h: p.hang ? 1 : 0,
          vx: Math.round(p.vx),
          vy: Math.round(p.vy),
          d: p.dmg,
          st: p.stocks,
          l: p.life,
          iv: p.inv > 0 ? 1 : 0,
          hs: p.stun > 0 ? 1 : 0,
          at: p.atk ? p.atk.t : 0,
        })),
      };
      if (r.events.length) {
        msg.ev = r.events;
        r.events = [];
      }
      broadcast(r, msg);
    }
  }
}, 1000 / TICK);

server.listen(PORT, () => console.log('listening on ' + PORT));
