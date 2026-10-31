(() => {
  const $ = (id) => document.getElementById(id);

  // ---------- ホーム画面 ----------
  const match = location.pathname.match(/^\/r\/([a-z0-9]{3,12})$/i);
  if (!match) {
    $('home').hidden = false;
    $('makeRoom').onclick = () => {
      const id = Math.random().toString(36).slice(2, 7);
      location.href = '/r/' + id;
    };
    return;
  }
  $('game').hidden = false;

  // ---------- 状態 ----------
  const room = match[1].toLowerCase();
  const INK = '#151515';
  const DEF = { w: 56, h: 84 }; // 絵が届くまでの仮の大きさ

  let ws = null;
  let me = -1;
  let stage = { w: 1800, top: 0, depth: 300, wall: 180 };
  let phase = 'draw';
  let submitted = false;
  let hintCount = 0; // 崖つかまりのヒントを出した回数
  let roomFull = false;
  let winner = -1;     // 勝った人の番号(-1はひきわけ)
  let myVote = false;  // 「もういちど」を押した
  const effects = [];  // ヒットや撃墜のエフェクト
  const SLOT_COLORS = ['#e5322d', '#2563e8', '#f5c518', '#ffffff'];
  const COLOR_NAMES = ['赤', '青', '黄', '白', '黒'];
  const HIT_COLORS = ['#e5322d', '#2563e8', '#f5c518', '#ffffff', '#777777'];
  const fxList = [];   // 技の当たり判定の見た目 {sh, t}
  let projs = [];      // 飛んでいる弾 {x,y,r,c,vx,vy,t}
  let roster = []; // [{s, r}]
  const players = new Map(); // slot -> {x,y,tx,ty,f,g}
  const arts = new Map();    // slot -> {rig, w, h}  (w,hはゲーム内の大きさ)

  // 試合が終わったときの画面
  const rsStyle = document.createElement('style');
  rsStyle.textContent = `
#rs { position: fixed; inset: 0; z-index: 90; display: flex; align-items: center; justify-content: center; background: rgba(207,227,242,.65); }
#rs[hidden] { display: none; }
.rs-box { background: #fff; border: 3px solid #151515; border-radius: 16px; box-shadow: 5px 5px 0 #151515; padding: 22px 30px; text-align: center; display: flex; flex-direction: column; gap: 12px; align-items: center; max-width: 90%; }
#rs-title { font-size: 34px; font-weight: 700; }
#rs-sub { font-size: 15px; font-weight: 700; opacity: .75; }
`;
  document.head.appendChild(rsStyle);
  const rs = document.createElement('div');
  rs.id = 'rs';
  rs.hidden = true;
  rs.innerHTML = '<div class="rs-box"><div id="rs-title"></div><div id="rs-sub"></div><button class="btn big" id="rs-btn">もういちど</button></div>';
  document.body.appendChild(rs);
  $('rs-btn').onclick = () => {
    myVote = true;
    sendRaw({ t: 'rematch' });
    updateResult();
  };

  function updateResult() {
    if (phase !== 'result') {
      rs.hidden = true;
      myVote = false;
      return;
    }
    rs.hidden = false;
    $('rs-title').textContent = winner < 0 ? 'ひきわけ！' : winner === me ? 'あなたのかち！' : 'P' + (winner + 1) + ' のかち！';
    const act = roster.filter((p) => p.r);
    const votes = act.filter((p) => p.v).length;
    const mine = myVote || roster.some((p) => p.s === me && p.v);
    $('rs-sub').textContent = mine
      ? 'ほかの人を待っています… (' + votes + '/' + act.length + ')'
      : 'みんなが押すと、同じキャラでもう一度はじまるよ';
    $('rs-btn').disabled = mine;
  }

  function setStatus(text) { $('status').textContent = text || ''; }
  function updateCount() { $('count').textContent = roster.length + ' / 4人'; }

  let toastTimer = 0;
  function toast(text, ms) {
    const t = $('toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms || 1800);
  }

  // 自分の技(必殺と通常の色)を、試合のはじめに知らせる
  function showMoves() {
    const a = arts.get(me);
    if (!a || a.sp === undefined) return;
    toast('ひっさつ: ' + COLOR_NAMES[a.sp] + '(Xボタン)  /  つうじょう: ' + COLOR_NAMES[a.nm] + '(Zボタン)', 4500);
  }

  // ---------- お絵描き画面とのやりとり ----------
  function applyRoster() {
    const meReady = roster.some((p) => p.s === me && p.r);
    const everyone = roster.length > 0 && roster.every((p) => p.r);
    DrawPad.setRoster(roster, me, everyone);
    updateCount();
    if (!(submitted || meReady)) DrawPad.open('draw');
    else if (phase === 'draw') DrawPad.open('wait');
    else DrawPad.close();
  }

  DrawPad.init({
    onSubmit(d) {
      submitted = true;
      sendRaw({ t: 'art', rig: d.rig, area: d.area, c: d.c });
      DrawPad.open('wait');
    },
    onRedraw() {
      submitted = false;
      sendRaw({ t: 'redraw' });
      DrawPad.open('draw');
    },
    onStart() { sendRaw({ t: 'start' }); },
    onInvite() { invite(); },
  });

  // ---------- 通信 ----------
  function sendRaw(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  let sentInput = '';
  function connect() {
    setStatus('つないでいます…');
    const sock = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    ws = sock;

    sock.onopen = () => {
      sentInput = '';
      sock.send(JSON.stringify({ t: 'join', room }));
    };

    sock.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === 'welcome') {
        me = m.you;
        stage = m.stage;
        phase = m.phase;
        submitted = false;
        setStatus('');
        DrawPad.open('draw');
      } else if (m.t === 'full') {
        roomFull = true;
        DrawPad.close();
        setStatus('この部屋は満員です(最大4人)。');
      } else if (m.t === 'art') {
        arts.set(m.s, { rig: Rig.load(m.rig), w: m.w, h: m.h, sp: m.sp, nm: m.nm });
        if (m.s === me && phase === 'play') showMoves();
      } else if (m.t === 'roster') {
        const prevPhase = phase;
        phase = m.phase;
        if (phase === 'play' && prevPhase !== 'play') showMoves();
        roster = m.p;
        for (const s of [...arts.keys()]) {
          if (!roster.some((p) => p.s === s && p.r)) arts.delete(s);
        }
        applyRoster();
        updateResult();
      } else if (m.t === 'result') {
        winner = m.w;
      } else if (m.t === 'state') {
        const alive = new Set();
        for (const p of m.p) {
          alive.add(p.s);
          let o = players.get(p.s);
          if (!o) {
            o = { x: p.x, y: p.y, tx: p.x, ty: p.y, f: p.f, g: p.g, vx: 0, vy: 0, pose: Rig.newPose() };
            players.set(p.s, o);
          }
          const wasHang = o.h;
          o.tx = p.x; o.ty = p.y; o.f = p.f; o.g = p.g; o.h = p.h; o.vx = p.vx; o.vy = p.vy;
          o.d = p.d; o.st = p.st; o.l = p.l; o.iv = p.iv; o.hs = p.hs; o.at = p.at; o.tt = p.tt; o.ms = p.ms; o.ch = p.ch;
          if (p.fx) for (const sh of p.fx) fxList.push({ sh, t: performance.now() });
          if (p.s === me && p.h && !wasHang && hintCount < 2) {
            hintCount++;
            toast('つかまった！ ' + (p.x < 0 ? '▶' : '◀') + 'でのぼる / ジャンプで飛び上がる');
          }
        }
        for (const s of [...players.keys()]) if (!alive.has(s)) players.delete(s);
        const tn = performance.now();
        projs = (m.pj || []).map((b) => ({ x: b[0], y: b[1], r: b[2], c: b[3], vx: b[4], vy: b[5], t: tn }));
        if (m.ev) {
          const now = performance.now();
          for (const e of m.ev) effects.push({ k: e.k, x: e.x, y: e.y, c: e.c, t: now });
        }
      }
    };

    sock.onclose = () => {
      if (ws !== sock || roomFull) return;
      players.clear();
      arts.clear();
      roster = [];
      me = -1;
      submitted = false;
      setStatus('つなぎ直しています…');
      setTimeout(connect, 1500);
    };
  }

  // ---------- 入力 ----------
  const input = { l: 0, r: 0, j: 0, a: 0, b: 0 };
  function sendInput() {
    const s = JSON.stringify({ t: 'input', l: input.l, r: input.r, j: input.j, a: input.a, b: input.b });
    if (s !== sentInput && ws && ws.readyState === 1) {
      ws.send(s);
      sentInput = s;
    }
  }

  const KEYMAP = {
    ArrowLeft: 'l', KeyA: 'l',
    ArrowRight: 'r', KeyD: 'r',
    ArrowUp: 'j', KeyW: 'j', Space: 'j',
    KeyZ: 'a', KeyJ: 'a', // こうげき
    KeyX: 'b', KeyK: 'b', // ひっさつ(あとで使う)
  };
  window.addEventListener('keydown', (e) => {
    const k = KEYMAP[e.code];
    if (!k || DrawPad.isOpen()) return;
    e.preventDefault();
    input[k] = 1;
    sendInput();
  });
  window.addEventListener('keyup', (e) => {
    const k = KEYMAP[e.code];
    if (!k) return;
    if (!DrawPad.isOpen()) e.preventDefault();
    input[k] = 0;
    sendInput();
  });
  window.addEventListener('blur', () => {
    input.l = input.r = input.j = input.a = input.b = 0;
    sendInput();
  });

  document.querySelectorAll('[data-k]').forEach((b) => {
    const k = b.dataset.k;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      b.setPointerCapture(e.pointerId);
      b.classList.add('on');
      input[k] = 1;
      sendInput();
    });
    const up = () => {
      b.classList.remove('on');
      input[k] = 0;
      sendInput();
    };
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((n) => b.addEventListener(n, up));
  });
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---------- 招待リンク ----------
  async function invite() {
    const url = location.href;
    try {
      if (navigator.share && /Mobi|Android|iPad/i.test(navigator.userAgent)) {
        await navigator.share({ title: 'ラクガキバトル', url });
      } else {
        await navigator.clipboard.writeText(url);
        toast('リンクをコピーしました');
        if (DrawPad.isOpen()) DrawPad.toast('リンクをコピーしました');
      }
    } catch (err) {
      // 共有をキャンセルした場合など
    }
  }
  $('invite').onclick = invite;

  // ---------- 描画 ----------
  const cv = $('cv');
  const ctx = cv.getContext('2d');
  let W = 0, H = 0, dpr = 1, safeB = 0;
  // 画面の下の安全な余白(iPhoneなど)を調べるための、見えない部品
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;left:0;bottom:0;width:0;height:0;visibility:hidden;padding-bottom:env(safe-area-inset-bottom,0px)';
  document.body.appendChild(probe);
  const coarse = window.matchMedia('(pointer: coarse)'); // スマホ・タブレットかどうか
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    safeB = parseFloat(getComputedStyle(probe).paddingBottom) || 0;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
  }
  window.addEventListener('resize', resize);
  resize();

  const cam = { x: 0, y: -80, s: 0.5, ready: false };

  function sizeOf(slot) {
    const a = arts.get(slot);
    return a ? { w: a.w, h: a.h } : DEF;
  }

  function updateCamera(dt) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [slot, o] of players) {
      if (o.l) continue; // 復活待ち・脱落の人は映さない
      const b = sizeOf(slot);
      minX = Math.min(minX, o.x - b.w / 2);
      maxX = Math.max(maxX, o.x + b.w / 2);
      minY = Math.min(minY, o.y - b.h);
      maxY = Math.max(maxY, o.y);
    }
    if (minX === Infinity) { minX = maxX = 0; minY = -DEF.h; maxY = 0; }

    const spanX = Math.max(maxX - minX + 700, 1000);
    const spanY = Math.max(maxY - minY + 500, 600);
    const ts = Math.max(Math.min(W / spanX, H / spanY), Math.min(W / 3800, H / 2400));
    const tx = (minX + maxX) / 2;
    const ty = (minY + maxY) / 2 - 40;

    if (!cam.ready) {
      cam.x = tx; cam.y = ty; cam.s = ts; cam.ready = true;
    } else {
      const k = 1 - Math.exp(-dt * 4);
      cam.x += (tx - cam.x) * k;
      cam.y += (ty - cam.y) * k;
      cam.s += (ts - cam.s) * k;
    }
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawStage() {
    const half = stage.w / 2;
    const top = stage.top;
    const bottom = top + stage.depth;
    ctx.lineJoin = 'round';
    ctx.lineWidth = 5;
    ctx.strokeStyle = INK;

    ctx.fillStyle = '#2a2a33';
    const wallBottom = top + stage.wall; // ここまでは垂直な壁、そこから下はせまくなる
    ctx.beginPath();
    ctx.moveTo(-half, top);
    ctx.lineTo(half, top);
    ctx.lineTo(half, wallBottom);
    ctx.lineTo(half - 140, bottom);
    ctx.lineTo(-half + 140, bottom);
    ctx.lineTo(-half, wallBottom);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#5a5a6a';
    ctx.fillRect(-half + 3, top + 2, stage.w - 6, 14);
  }

  function drawPlayer(slot, o) {
    const x = o.x;
    const y = o.y;
    const a = arts.get(slot);
    const w = a ? a.w : DEF.w;
    const h = a ? a.h : DEF.h;

    // 溜めているとき: まわりに輪が集まってくる
    if (o.ch > 0) {
      const k = o.ch / 100;
      const now = performance.now();
      ctx.save();
      ctx.translate(x, y - h / 2);
      ctx.lineWidth = 6;
      for (let n = 0; n < 3; n++) {
        const ph = (now / 400 + n / 3) % 1;
        ctx.globalAlpha = 0.55 * (1 - ph) * (0.4 + k);
        ctx.strokeStyle = INK;
        ctx.beginPath();
        ctx.arc(0, 0, (Math.max(w, h) * 0.5 + 70) * (1 - ph) + 10, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 0.18 + 0.3 * k;
      ctx.fillStyle = INK;
      ctx.beginPath();
      ctx.arc(0, 0, Math.max(w, h) * 0.55 + 12 * k, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.save();
    if (o.iv && Math.floor(performance.now() / 80) % 2) ctx.globalAlpha = 0.35; // 復活直後の無敵はチカチカ
    if (a) {
      // 描いた絵は右向き。左を向くときは左右を反転する
      const S = a.w / a.rig.w;
      ctx.save();
      ctx.translate(x, y);
      ctx.scale((o.f < 0 ? -1 : 1) * S, S);
      ctx.translate(-a.rig.w / 2, -a.rig.h);
      Rig.draw(ctx, a.rig, o.pose);
      ctx.restore();
    } else {
      ctx.fillStyle = '#bbb';
      ctx.strokeStyle = INK;
      ctx.lineWidth = 5;
      roundRect(x - w / 2, y - h, w, h, 14);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();

    // 名前
    ctx.font = '700 22px sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 5;
    ctx.strokeStyle = '#fff';
    const label = 'P' + (slot + 1);
    ctx.strokeText(label, x, y - h - 12);
    ctx.fillStyle = INK;
    ctx.fillText(label, x, y - h - 12);

    // 自分の目印
    if (slot === me) {
      ctx.fillStyle = INK;
      ctx.beginPath();
      ctx.moveTo(x, y - h - 52);
      ctx.lineTo(x - 11, y - h - 70);
      ctx.lineTo(x + 11, y - h - 70);
      ctx.closePath();
      ctx.fill();
    }
  }

  function draw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    const g = ctx.createLinearGradient(0, 0, 0, cv.height);
    g.addColorStop(0, '#b6d5ee');
    g.addColorStop(1, '#eef5fb');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cv.width, cv.height);

    const s = cam.s;
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * (W / 2 - cam.x * s), dpr * (H / 2 - cam.y * s));

    drawStage();
    const slots = [...players.keys()].sort((a, b) => a - b);
    for (const slot of slots) {
      const o = players.get(slot);
      if (!o.l) drawPlayer(slot, o);
    }
    drawMoveFx();
    drawHitEffects();

    // ここから画面に固定して描く
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawKoEffects();
    drawHud();
  }

  // 色ごとの、丸い技(火・水・雷・連続ヒット・溜め)の見た目
  function drawBlob(x, y, r, col, now) {
    ctx.save();
    ctx.translate(x, y);
    ctx.lineJoin = 'round';
    if (col === 0) {
      // 赤: 火
      const wob = 1 + 0.1 * Math.sin(now * 0.05 + x * 0.1);
      ctx.fillStyle = 'rgba(229,50,45,0.85)';
      ctx.beginPath(); ctx.arc(0, 0, r * wob, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(245,197,24,0.95)';
      ctx.beginPath(); ctx.arc(0, -r * 0.1, r * 0.55 * wob, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.beginPath(); ctx.arc(0, -r * 0.15, r * 0.22, 0, Math.PI * 2); ctx.fill();
    } else if (col === 1) {
      // 青: 水
      ctx.fillStyle = 'rgba(37,99,232,0.7)';
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(170,210,255,0.9)';
      ctx.beginPath(); ctx.arc(-r * 0.2, -r * 0.2, r * 0.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
    } else if (col === 2) {
      // 黄: 雷
      ctx.fillStyle = 'rgba(245,197,24,0.8)';
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
      ctx.lineCap = 'round';
      for (let k = 0; k < 4; k++) {
        const ang = (k * Math.PI) / 2 + now * 0.01;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(ang) * r * 0.5 + Math.sin(ang) * r * 0.2, Math.sin(ang) * r * 0.5 - Math.cos(ang) * r * 0.2);
        ctx.lineTo(Math.cos(ang) * r * 1.0, Math.sin(ang) * r * 1.0);
        ctx.strokeStyle = INK; ctx.lineWidth = 7; ctx.stroke();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.stroke();
      }
    } else if (col === 3) {
      // 白: 連続ヒット
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.strokeStyle = INK;
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.lineCap = 'round';
      ctx.lineWidth = 4;
      for (let k = 0; k < 6; k++) {
        const ang = (k * Math.PI) / 3 + now * 0.02;
        ctx.beginPath();
        ctx.moveTo(Math.cos(ang) * r * 0.25, Math.sin(ang) * r * 0.25);
        ctx.lineTo(Math.cos(ang) * r * 0.75, Math.sin(ang) * r * 0.75);
        ctx.stroke();
      }
    } else {
      // 黒: 重い一撃
      ctx.fillStyle = 'rgba(21,21,21,0.82)';
      ctx.strokeStyle = '#e5322d';
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.beginPath(); ctx.arc(-r * 0.25, -r * 0.25, r * 0.3, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  // 縦に落ちる雷の柱(四角い当たり判定)
  function drawBolt(x0, y0, x1, y1, col, now) {
    const w = x1 - x0;
    const cx = (x0 + x1) / 2;
    ctx.save();
    ctx.fillStyle = col === 2 ? 'rgba(245,197,24,0.4)' : 'rgba(255,255,255,0.4)';
    ctx.fillRect(x0, y0, w, y1 - y0);
    ctx.lineJoin = 'miter';
    ctx.lineCap = 'round';
    const steps = 8;
    ctx.beginPath();
    ctx.moveTo(cx, y0);
    for (let k = 1; k <= steps; k++) {
      const yy = y0 + ((y1 - y0) * k) / steps;
      const jig = (k % 2 ? -1 : 1) * w * 0.25 * (0.7 + 0.3 * Math.sin(now * 0.04 + k));
      ctx.lineTo(cx + (k === steps ? 0 : jig), yy);
    }
    ctx.strokeStyle = INK; ctx.lineWidth = 14; ctx.stroke();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 8; ctx.stroke();
    ctx.strokeStyle = '#f5c518'; ctx.lineWidth = 3; ctx.stroke();
    ctx.restore();
  }

  // 技の見た目(当たり判定のかたち)と、飛んでいる弾
  function drawMoveFx() {
    const now = performance.now();
    for (let i = fxList.length - 1; i >= 0; i--) {
      const f = fxList[i];
      const age = now - f.t;
      if (age > 170) { fxList.splice(i, 1); continue; }
      const sh = f.sh;
      ctx.globalAlpha = 1 - (age / 170) * 0.6;
      if (sh[0] === 0) drawBlob(sh[1], sh[2], sh[3], sh[4], now);
      else drawBolt(sh[1], sh[2], sh[3], sh[4], sh[5], now);
      ctx.globalAlpha = 1;
    }
    for (const b of projs) {
      const dt = Math.min(0.12, (now - b.t) / 1000);
      const x = b.x + b.vx * dt;
      const y = b.y + b.vy * dt;
      // しっぽ
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.lineCap = 'round';
      ctx.lineWidth = b.r * 1.2;
      ctx.strokeStyle = ['#e5322d', '#2563e8', '#f5c518', '#ffffff', '#151515'][b.c] || '#2563e8';
      ctx.beginPath();
      ctx.moveTo(x - b.vx * 0.05, y - b.vy * 0.05);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.restore();
      drawBlob(x, y, b.r, b.c, now);
    }
  }

  // ヒットのエフェクト(当たった場所に放射状の線)
  function drawHitEffects() {
    const now = performance.now();
    for (const e of effects) {
      if (e.k !== 'hit') continue;
      const t = (now - e.t) / 280;
      if (t < 0 || t > 1) continue;
      ctx.save();
      ctx.translate(e.x, e.y);
      ctx.globalAlpha = 1 - t;
      ctx.lineCap = 'round';
      for (let k = 0; k < 8; k++) {
        const ang = (k * Math.PI) / 4 + 0.4;
        const r0 = 16 + t * 24;
        const r1 = 40 + t * 56;
        ctx.strokeStyle = INK;
        ctx.lineWidth = 11;
        ctx.beginPath();
        ctx.moveTo(Math.cos(ang) * r0, Math.sin(ang) * r0);
        ctx.lineTo(Math.cos(ang) * r1, Math.sin(ang) * r1);
        ctx.stroke();
        ctx.strokeStyle = HIT_COLORS[e.c] || '#fff';
        ctx.lineWidth = 6;
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  // 撃墜のエフェクト(画面のふちで、大きくはじける)
  function drawKoEffects() {
    const now = performance.now();
    for (let i = effects.length - 1; i >= 0; i--) {
      const e = effects[i];
      const t = (now - e.t) / (e.k === 'ko' ? 800 : 280);
      if (t > 1) { effects.splice(i, 1); continue; }
      if (e.k !== 'ko' || t < 0) continue;
      const sx = Math.max(40, Math.min(W - 40, W / 2 + (e.x - cam.x) * cam.s));
      const sy = Math.max(40, Math.min(H - 40, H / 2 + (e.y - cam.y) * cam.s));
      ctx.save();
      ctx.translate(sx, sy);
      ctx.globalAlpha = 1 - t * t;
      ctx.lineCap = 'round';
      for (let k = 0; k < 14; k++) {
        const ang = (k * Math.PI * 2) / 14;
        const r0 = 20 + t * 60;
        const r1 = 60 + t * 190;
        ctx.strokeStyle = INK;
        ctx.lineWidth = 14 * (1 - t) + 4;
        ctx.beginPath();
        ctx.moveTo(Math.cos(ang) * r0, Math.sin(ang) * r0);
        ctx.lineTo(Math.cos(ang) * r1, Math.sin(ang) * r1);
        ctx.stroke();
        ctx.strokeStyle = k % 2 ? '#f5c518' : '#e5322d';
        ctx.lineWidth = 8 * (1 - t) + 2;
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  // ダメージ(%)と残機の表示
  function drawHud() {
    const slots = [...players.keys()].sort((a, b) => a - b);
    if (!slots.length) return;
    const pw = 92, ph = 52, gap = 6;
    const total = slots.length * pw + (slots.length - 1) * gap;
    let x = (W - total) / 2;
    let y;
    if (coarse.matches) {
      // スマホ・タブレット: 操作ボタンのあいだにおさまれば下、せまければボタンの上
      const roomW = W - 200 - 290;
      y = total + 16 <= roomW ? H - ph - 14 - safeB : H - (18 + safeB + 98) - ph - 8;
    } else {
      y = H - ph - 40; // PC: 画面下の操作説明の上
    }
    for (const s of slots) {
      const o = players.get(s);
      const out = o.l === 2;
      ctx.fillStyle = out ? '#d5d5d5' : s === me ? '#fff3bf' : '#fff'; // 自分のパネルはうす黄色
      ctx.strokeStyle = INK;
      ctx.lineWidth = 3;
      roundRect(x, y, pw, ph, 10);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = SLOT_COLORS[s % 4];
      ctx.beginPath();
      ctx.arc(x + 12, y + 13, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = INK;
      ctx.font = '700 13px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('P' + (s + 1), x + 22, y + 18);

      if (out) {
        ctx.font = '700 22px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('OUT', x + pw / 2, y + 44);
      } else {
        const d = Math.floor(o.d || 0);
        ctx.fillStyle = d < 50 ? INK : d < 100 ? '#c2410c' : d < 150 ? '#dc2626' : '#991b1b';
        ctx.font = '700 24px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(d + '%', x + pw / 2, y + 44);
        // 残機
        ctx.fillStyle = INK;
        for (let k = 0; k < (o.st || 0); k++) {
          ctx.beginPath();
          ctx.arc(x + pw - 12 - k * 13, y + 12, 4.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      x += pw + gap;
    }
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    const k = 1 - Math.exp(-dt * 25);
    for (const o of players.values()) {
      if (Math.abs(o.tx - o.x) > 300 || Math.abs(o.ty - o.y) > 300) { o.x = o.tx; o.y = o.ty; }
      o.x += (o.tx - o.x) * k;
      o.y += (o.ty - o.y) * k;
      Rig.updatePose(o.pose, dt, { vx: o.vx, vy: o.vy, g: o.g, hang: o.h, hs: o.hs, at: o.at, tt: o.tt, ms: o.ms });
    }

    updateCamera(dt);
    draw();
    requestAnimationFrame(frame);
  }

  connect();
  requestAnimationFrame(frame);
})();
