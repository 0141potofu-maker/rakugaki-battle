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

// ---------- プレイヤー ----------
function makePlayer(slot) {
  return {
    slot,
    ws: null,
    active: false, // 絵を出して、試合に参加している
    art: null,     // 描いた絵(PNGのdataURL)
    bw: 56, bh: 84, // キャラの大きさ(ゲーム内)
    area: 0,        // 塗ったピクセル数(あとで体重・速度に使う)
    colors: [0, 0, 0, 0, 0], // 赤・青・黄・白・黒のピクセル数(あとで技に使う)
    x: 0, y: 0, vx: 0, vy: 0,
    f: 1,          // 向き 1=右 -1=左
    g: true,       // 接地
    airJump: false, // 空中ジャンプ使用済み
    prevJ: false,
    prevL: false,
    prevR: false,
    hang: 0,   // 崖につかまり中: -1=左の崖 1=右の崖 0=なし
    hangT: 0,  // つかまっているフレーム数
    cd: 0,     // 崖につかまれるようになるまでのフレーム数
    input: { l: 0, r: 0, j: 0 },
  };
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
  p.hang = 0;
  p.hangT = 0;
  p.cd = 0;
}

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
  if (p.g || p.vy < 0 || p.cd > 0) return;
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
  p.vx = 0;
  p.vy = 0;
  occ[s] = p.slot;
}

function step(p, occ) {
  const i = p.input;
  const pL = i.l && !p.prevL; // 押した瞬間
  const pR = i.r && !p.prevR;
  const pJ = i.j && !p.prevJ;
  p.prevL = !!i.l;
  p.prevR = !!i.r;
  p.prevJ = !!i.j;
  if (p.cd > 0) p.cd--;

  if (p.hang) {
    hangUpdate(p, pL, pR, pJ);
    return;
  }

  const dir = (i.r ? 1 : 0) - (i.l ? 1 : 0);

  // 左右移動
  if (dir) {
    p.f = dir;
    const acc = p.g ? PHYS.groundAcc : PHYS.airAcc;
    const target = dir * PHYS.run;
    if (p.vx < target) p.vx = Math.min(target, p.vx + acc * DT);
    else p.vx = Math.max(target, p.vx - acc * DT);
  } else {
    const fr = p.g ? PHYS.groundFric : PHYS.airFric;
    if (p.vx > 0) p.vx = Math.max(0, p.vx - fr * DT);
    else p.vx = Math.min(0, p.vx + fr * DT);
  }

  // ジャンプ(押した瞬間だけ)
  if (pJ) {
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
  if (!p.g) p.vy = Math.min(PHYS.maxFall, p.vy + PHYS.gravity * DT);
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

  // 崖つかまり
  tryGrab(p, occ);

  // 撃墜(今は即復活。ダメージ・ストックは後のステップで)
  if (Math.abs(p.x) > BLAST.x || p.y > BLAST.bottom || p.y < BLAST.top) {
    spawn(p, true);
  }
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
    p: [...r.players.values()].map((p) => ({ s: p.slot, r: p.active ? 1 : 0 })),
  };
}

function allReady(r) {
  if (r.players.size === 0) return false;
  for (const p of r.players.values()) if (!p.active) return false;
  return true;
}

function startMatch(r) {
  r.phase = 'play';
  for (const p of r.players.values()) spawn(p, false);
  broadcast(r, rosterMsg(r));
}

function artMsg(p) {
  return { t: 'art', s: p.slot, img: p.art, w: p.bw, h: p.bh };
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
        r = { id, players: new Map(), tick: 0, phase: 'draw' };
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
        if (q.active && q.art) send(ws, artMsg(q));
      }
      broadcast(r, rosterMsg(r));

    } else if (!player) {
      return;

    } else if (m.t === 'input') {
      player.input = { l: m.l ? 1 : 0, r: m.r ? 1 : 0, j: m.j ? 1 : 0 };

    } else if (m.t === 'art') {
      // 描いた絵を受け取る
      const w = Math.round(+m.w);
      const h = Math.round(+m.h);
      const img = m.img;
      if (!(w >= 4 && w <= 256 && h >= 4 && h <= 256)) return;
      if (typeof img !== 'string' || !img.startsWith('data:image/png;base64,') || img.length > 400000) return;
      if (room.phase === 'play' && player.active) return;

      player.art = img;
      player.bw = w * SCALE;
      player.bh = h * SCALE;
      player.area = clampInt(m.area, 65536);
      player.colors = Array.isArray(m.c) && m.c.length === 5 ? m.c.map((v) => clampInt(v, 65536)) : [0, 0, 0, 0, 0];
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
        player.art = null;
        broadcast(room, rosterMsg(room));
      }

    } else if (m.t === 'start') {
      // 全員かけたら「はじめる」で試合開始
      if (room.phase === 'draw' && allReady(room)) startMatch(room);
    }
  });

  ws.on('close', () => {
    if (room && player) {
      room.players.delete(player.slot);
      if (room.players.size === 0) rooms.delete(room.id);
      else broadcast(room, rosterMsg(room));
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
    const actives = [...r.players.values()].filter((p) => p.active);
    const occ = {}; // 崖ごとに、つかまっている人
    for (const p of actives) if (p.hang) occ[p.hang] = p.slot;
    for (const p of actives) step(p, occ);

    if (r.tick % SEND_EVERY === 0) {
      broadcast(r, {
        t: 'state',
        p: actives.map((p) => ({
          s: p.slot,
          x: +p.x.toFixed(1),
          y: +p.y.toFixed(1),
          f: p.f,
          g: p.g ? 1 : 0,
          h: p.hang ? 1 : 0,
        })),
      });
    }
  }
}, 1000 / TICK);

server.listen(PORT, () => console.log('listening on ' + PORT));
