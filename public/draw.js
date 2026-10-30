// お絵描き画面(試合の前にキャラを描く)
(() => {
  const SIZE = 256; // キャンバスの大きさ(ピクセル)
  const PALETTE = [
    { name: '赤', css: '#e5322d', rgb: [229, 50, 45] },
    { name: '青', css: '#2563e8', rgb: [37, 99, 232] },
    { name: '黄', css: '#f5c518', rgb: [245, 197, 24] },
    { name: '白', css: '#ffffff', rgb: [255, 255, 255] },
    { name: '黒', css: '#151515', rgb: [21, 21, 21] },
  ];
  const SIZES = [6, 14, 28];
  const SLOT_COLORS = ['#e5322d', '#2563e8', '#f5c518', '#ffffff'];

  let handlers = {};
  let colorIdx = 0;
  let tool = 'pen'; // pen | eraser | fill
  let sizeIdx = 1;
  const undoStack = [];
  let limbTool = 'hand'; // hand | foot | erase
  let limbSize = 1;

  // ---------- 見た目 ----------
  const style = document.createElement('style');
  style.textContent = `
#dp { position: fixed; inset: 0; z-index: 100; background: #cfe3f2; display: flex; flex-direction: column; gap: 8px;
  padding: calc(10px + env(safe-area-inset-top, 0px)) calc(10px + env(safe-area-inset-right, 0px)) calc(10px + env(safe-area-inset-bottom, 0px)) calc(10px + env(safe-area-inset-left, 0px)); }
#dp[hidden] { display: none; }
.dp-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dp-title { font-weight: 700; font-size: 20px; }
#dp-roster { display: flex; gap: 6px; flex-wrap: wrap; flex: 1; }
.dp-chip { display: flex; align-items: center; gap: 5px; background: #fff; border: 3px solid #151515; border-radius: 10px; padding: 3px 8px; font-size: 13px; font-weight: 700; }
.dp-chip i { width: 14px; height: 14px; border-radius: 50%; border: 2px solid #151515; }
.dp-chip.ok { background: #d8f5d0; }
.dp-main { flex: 1; min-height: 0; display: flex; gap: 10px; }
.dp-stage { flex: 1; min-width: 0; min-height: 0; display: flex; align-items: center; justify-content: center; }
#dp-cv { border: 3px solid #151515; border-radius: 8px; touch-action: none; background-color: #c9ced3;
  background-image: linear-gradient(45deg, #b4bac0 25%, transparent 25%, transparent 75%, #b4bac0 75%), linear-gradient(45deg, #b4bac0 25%, transparent 25%, transparent 75%, #b4bac0 75%);
  background-size: 28px 28px; background-position: 0 0, 14px 14px; }
.dp-tools { width: 214px; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; padding: 2px 4px 6px 2px; }
.dp-row { display: flex; gap: 8px; flex-wrap: wrap; }
.dp-color { width: 44px; height: 44px; border-radius: 50%; border: 3px solid #151515; padding: 0; cursor: pointer; }
.dp-color.sel { outline: 4px solid #151515; outline-offset: 2px; }
.dp-tools .btn { padding: 8px 10px; }
.dp-tools .btn.sel { background: #f5c518; }
.dp-s { width: 52px; height: 44px; display: flex; align-items: center; justify-content: center; }
.dp-s i { display: block; background: #151515; border-radius: 50%; }
.dp-submit { font-size: 20px; background: #7bdc6a; padding: 12px; margin-top: auto; }
#dp-wait { flex: 1; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; text-align: center; }
#dp-prev { max-width: 70%; max-height: 38vh; min-width: 60px; min-height: 60px; object-fit: contain; border: 3px solid #151515; border-radius: 8px; background-color: #c9ced3; image-rendering: auto; }
#dp-hint { font-size: 16px; font-weight: 700; max-width: 90%; }
.dp-btns { display: flex; gap: 12px; flex-wrap: wrap; justify-content: center; }
.btn:disabled { opacity: .4; cursor: default; }
#dp-lcv, #dp-lprev { border: 3px solid #151515; border-radius: 8px; touch-action: none; background-color: #c9ced3;
  background-image: linear-gradient(45deg, #b4bac0 25%, transparent 25%, transparent 75%, #b4bac0 75%), linear-gradient(45deg, #b4bac0 25%, transparent 25%, transparent 75%, #b4bac0 75%);
  background-size: 28px 28px; background-position: 0 0, 14px 14px; image-rendering: pixelated; }
#dp-lprev { width: 140px; height: 140px; align-self: center; flex: none; }
#dp-ltext { font-size: 14px; font-weight: 700; line-height: 1.4; }
#dp-msg { position: absolute; left: 50%; bottom: 24px; transform: translateX(-50%); background: #151515; color: #fff; border-radius: 10px; padding: 8px 14px; font-size: 14px; opacity: 0; transition: opacity .2s; pointer-events: none; }
#dp-msg.show { opacity: 1; }
@media (orientation: portrait) {
  .dp-main { flex-direction: column; }
  .dp-tools { width: auto; flex-direction: row; flex-wrap: wrap; overflow-y: auto; max-height: 38%; align-content: flex-start; }
  .dp-submit { margin-top: 0; }
}
`;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'dp';
  root.hidden = true;
  root.innerHTML = `
<div class="dp-top">
  <div class="dp-title">キャラをかこう</div>
  <div id="dp-roster"></div>
  <button class="btn" data-a="invite">招待リンクをコピー</button>
</div>
<div class="dp-main" id="dp-draw">
  <div class="dp-stage" id="dp-stage"><canvas id="dp-cv" width="${SIZE}" height="${SIZE}"></canvas></div>
  <div class="dp-tools">
    <div class="dp-row">${PALETTE.map((c, i) => `<button class="dp-color" data-c="${i}" style="background:${c.css}" aria-label="${c.name}"></button>`).join('')}</div>
    <div class="dp-row">
      <button class="btn" data-t="pen">ペン</button>
      <button class="btn" data-t="eraser">けしごむ</button>
      <button class="btn" data-t="fill">ぬりつぶし</button>
    </div>
    <div class="dp-row">${SIZES.map((s, i) => `<button class="btn dp-s" data-s="${i}" aria-label="太さ${i + 1}"><i style="width:${6 + i * 8}px;height:${6 + i * 8}px"></i></button>`).join('')}</div>
    <div class="dp-row">
      <button class="btn" data-a="undo">もどす</button>
      <button class="btn" data-a="clear">ぜんぶけす</button>
    </div>
    <button class="btn dp-submit" data-a="submit">かけた！</button>
  </div>
</div>
<div class="dp-main" id="dp-limb" hidden>
  <div class="dp-stage" id="dp-lstage"><canvas id="dp-lcv"></canvas></div>
  <div class="dp-tools">
    <canvas id="dp-lprev" width="140" height="140"></canvas>
    <div id="dp-ltext">なぞって、動かしたいところをえらぼう。手は緑、足は紫。えらんだところが歩くとき・ジャンプのときに動くよ。</div>
    <div class="dp-row">
      <button class="btn" data-lt="hand">手をえらぶ</button>
      <button class="btn" data-lt="foot">足をえらぶ</button>
      <button class="btn" data-lt="erase">えらびなおし</button>
    </div>
    <div class="dp-row">${[0, 1, 2].map((i) => `<button class="btn dp-s" data-ls="${i}" aria-label="太さ${i + 1}"><i style="width:${6 + i * 8}px;height:${6 + i * 8}px"></i></button>`).join('')}</div>
    <div class="dp-row">
      <button class="btn" data-a="lclear">ぜんぶ解除</button>
      <button class="btn" data-a="lback">絵にもどる</button>
    </div>
    <button class="btn dp-submit" data-a="lok">これでOK</button>
    <button class="btn" data-a="lskip">手足なしで決定</button>
  </div>
</div>
<div id="dp-wait" hidden>
  <img id="dp-prev" alt="かいたキャラ">
  <div id="dp-hint"></div>
  <div class="dp-btns">
    <button class="btn" data-a="redraw">かきなおす</button>
    <button class="btn dp-submit" data-a="start" id="dp-start">はじめる</button>
  </div>
</div>
<div id="dp-msg"></div>
`;
  document.body.appendChild(root);

  const $ = (id) => document.getElementById(id);
  const cv = $('dp-cv');
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const stageEl = $('dp-stage');

  // ---------- 画面の大きさに合わせる ----------
  function fit() {
    const r = stageEl.getBoundingClientRect();
    const s = Math.max(120, Math.floor(Math.min(r.width, r.height)) - 4);
    cv.style.width = s + 'px';
    cv.style.height = s + 'px';
  }
  window.addEventListener('resize', fit);

  let msgTimer = 0;
  function msg(text) {
    const m = $('dp-msg');
    m.textContent = text;
    m.classList.add('show');
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => m.classList.remove('show'), 2000);
  }

  function refreshSel() {
    root.querySelectorAll('[data-c]').forEach((b) => b.classList.toggle('sel', +b.dataset.c === colorIdx));
    root.querySelectorAll('[data-t]').forEach((b) => b.classList.toggle('sel', b.dataset.t === tool));
    root.querySelectorAll('[data-s]').forEach((b) => b.classList.toggle('sel', +b.dataset.s === sizeIdx));
    root.querySelectorAll('[data-lt]').forEach((b) => b.classList.toggle('sel', b.dataset.lt === limbTool));
    root.querySelectorAll('[data-ls]').forEach((b) => b.classList.toggle('sel', +b.dataset.ls === limbSize));
  }

  // ---------- ピクセル処理 ----------
  function nearest(r, g, b) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < PALETTE.length; i++) {
      const c = PALETTE[i].rgb;
      const d = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  // 線のふちのぼかしをなくして、すべて「5色のどれか」か「透明」にそろえる
  function harden() {
    const id = ctx.getImageData(0, 0, SIZE, SIZE);
    const d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) {
        d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0;
      } else {
        const c = PALETTE[nearest(d[i], d[i + 1], d[i + 2])].rgb;
        d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
      }
    }
    ctx.putImageData(id, 0, 0);
  }

  function pushUndo() {
    if (undoStack.length >= 30) undoStack.shift();
    undoStack.push(ctx.getImageData(0, 0, SIZE, SIZE));
  }

  function floodFill(sx, sy, colorI) {
    if (sx < 0 || sy < 0 || sx >= SIZE || sy >= SIZE) return;
    const id = ctx.getImageData(0, 0, SIZE, SIZE);
    const u32 = new Uint32Array(id.data.buffer);
    const c = PALETTE[colorI].rgb;
    const tmp = new Uint8ClampedArray([c[0], c[1], c[2], 255]);
    const fill = new Uint32Array(tmp.buffer)[0];
    const target = u32[sy * SIZE + sx];
    if (target === fill) return;
    const stack = [sy * SIZE + sx];
    while (stack.length) {
      const i = stack.pop();
      if (u32[i] !== target) continue;
      u32[i] = fill;
      const cx = i % SIZE;
      if (cx > 0) stack.push(i - 1);
      if (cx < SIZE - 1) stack.push(i + 1);
      if (i >= SIZE) stack.push(i - SIZE);
      if (i < SIZE * (SIZE - 1)) stack.push(i + SIZE);
    }
    ctx.putImageData(id, 0, 0);
  }

  // かいた絵を調べる(大きさ・面積・色ごとのピクセル数)して、まわりの透明部分を切り取る
  function analyze() {
    const d = ctx.getImageData(0, 0, SIZE, SIZE).data;
    let minX = SIZE, minY = SIZE, maxX = -1, maxY = -1, area = 0;
    const counts = [0, 0, 0, 0, 0];
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const i = (y * SIZE + x) * 4;
        if (d[i + 3] < 128) continue;
        area++;
        counts[nearest(d[i], d[i + 1], d[i + 2])]++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (area === 0) return null;
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').drawImage(cv, minX, minY, w, h, 0, 0, w, h);
    return { crop: c, img: c.toDataURL('image/png'), w, h, area, c: counts };
  }

  // ---------- 描く ----------
  let drawing = false;
  let pid = null;
  let last = null;

  function pos(e) {
    const r = cv.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * SIZE) / r.width, y: ((e.clientY - r.top) * SIZE) / r.height };
  }

  function setBrush() {
    ctx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = ctx.fillStyle = PALETTE[colorIdx].css;
    ctx.lineWidth = SIZES[sizeIdx];
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }

  function dot(p) {
    setBrush();
    ctx.beginPath();
    ctx.arc(p.x, p.y, SIZES[sizeIdx] / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  function line(a, b) {
    setBrush();
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  cv.addEventListener('pointerdown', (e) => {
    if (drawing) return;
    e.preventDefault();
    const p = pos(e);
    if (tool === 'fill') {
      pushUndo();
      floodFill(Math.floor(p.x), Math.floor(p.y), colorIdx);
      return;
    }
    cv.setPointerCapture(e.pointerId);
    pid = e.pointerId;
    drawing = true;
    pushUndo();
    last = p;
    dot(p);
  });
  cv.addEventListener('pointermove', (e) => {
    if (!drawing || e.pointerId !== pid) return;
    e.preventDefault();
    const p = pos(e);
    line(last, p);
    last = p;
  });
  const endStroke = (e) => {
    if (!drawing || e.pointerId !== pid) return;
    drawing = false;
    pid = null;
    harden();
  };
  cv.addEventListener('pointerup', endStroke);
  cv.addEventListener('pointercancel', endStroke);

  // ---------- 手足をえらぶ ----------
  const LSIZES = [14, 28, 48]; // ブラシの太さ(画面上のピクセル)
  let limb = null; // { crop, w, h, area, c, img, mask, drawn }
  let limbRig = null;
  let limbRaf = 0;
  let pLast = 0;
  const lcv = $('dp-lcv');
  const lctx = lcv.getContext('2d');
  const lstageEl = $('dp-lstage');
  const lprev = $('dp-lprev');
  const pctx = lprev.getContext('2d');
  const ov = document.createElement('canvas');
  const ovctx = ov.getContext('2d');
  const prevPose = Rig.newPose();

  function fitLimb() {
    if (!limb) return;
    const r = lstageEl.getBoundingClientRect();
    const s = Math.min(8, Math.max(0.5, Math.min((r.width - 6) / limb.w, (r.height - 6) / limb.h)));
    lcv.style.width = Math.floor(limb.w * s) + 'px';
    lcv.style.height = Math.floor(limb.h * s) + 'px';
  }
  window.addEventListener('resize', fitLimb);

  function renderLimb() {
    const w = limb.w;
    const h = limb.h;
    lctx.clearRect(0, 0, w, h);
    lctx.drawImage(limb.crop, 0, 0);
    const id = ovctx.createImageData(w, h);
    const m = limb.mask;
    for (let i = 0; i < m.length; i++) {
      if (!m[i]) continue;
      const o = i * 4;
      if (m[i] === 1) { id.data[o] = 34; id.data[o + 1] = 197; id.data[o + 2] = 94; }
      else { id.data[o] = 168; id.data[o + 1] = 85; id.data[o + 2] = 247; }
      id.data[o + 3] = 150;
    }
    ovctx.putImageData(id, 0, 0);
    lctx.drawImage(ov, 0, 0);
  }

  function rebuildLimbRig() {
    limbRig = Rig.build(limb.crop, limb.mask);
  }

  function previewLoop(now) {
    limbRaf = 0;
    if (root.hidden || $('dp-limb').hidden) return;
    const dt = Math.min(0.05, (now - pLast) / 1000 || 0.016);
    pLast = now;
    const t = (now / 1000) % 4; // 歩く → ジャンプ → 立ち止まる をくりかえす
    const walking = t < 1.6;
    const jumping = t >= 1.6 && t < 2.6;
    const vy = jumping ? -800 + (t - 1.6) * 1600 : 0;
    Rig.updatePose(prevPose, dt, { vx: walking ? 430 : 0, vy, g: !jumping, hang: false });
    pctx.clearRect(0, 0, 140, 140);
    if (limbRig) {
      const sc = Math.min(2, 112 / limbRig.w, 112 / limbRig.h);
      pctx.save();
      pctx.translate(70, 128);
      pctx.scale(sc, sc);
      pctx.translate(-limbRig.w / 2, -limbRig.h);
      Rig.draw(pctx, limbRig, prevPose);
      pctx.restore();
    }
    limbRaf = requestAnimationFrame(previewLoop);
  }
  function startPreview() {
    if (limbRaf) return;
    pLast = performance.now();
    limbRaf = requestAnimationFrame(previewLoop);
  }

  function showLimb(d) {
    const n = d.w * d.h;
    const alpha = d.crop.getContext('2d').getImageData(0, 0, d.w, d.h).data;
    const drawn = new Uint8Array(n);
    for (let i = 0; i < n; i++) drawn[i] = alpha[i * 4 + 3] >= 128 ? 1 : 0;
    limb = { crop: d.crop, w: d.w, h: d.h, area: d.area, c: d.c, img: d.img, mask: new Uint8Array(n), drawn };
    lcv.width = d.w;
    lcv.height = d.h;
    ov.width = d.w;
    ov.height = d.h;
    limbTool = 'hand';
    refreshSel();
    setMode('limb');
    renderLimb();
    rebuildLimbRig();
  }

  let lPaint = false;
  let lPid = null;
  let lLast = null;

  function lpos(e) {
    const r = lcv.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * limb.w) / r.width, y: ((e.clientY - r.top) * limb.h) / r.height };
  }
  function brushR() {
    const r = lcv.getBoundingClientRect();
    return ((LSIZES[limbSize] / 2) * limb.w) / r.width; // 絵のピクセル単位の半径
  }
  function stampL(p) {
    const R = brushR();
    const code = limbTool === 'hand' ? 1 : limbTool === 'foot' ? 2 : 0;
    const x0 = Math.max(0, Math.floor(p.x - R));
    const x1 = Math.min(limb.w - 1, Math.ceil(p.x + R));
    const y0 = Math.max(0, Math.floor(p.y - R));
    const y1 = Math.min(limb.h - 1, Math.ceil(p.y + R));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * limb.w + x;
        if (!limb.drawn[i]) continue; // 描いてあるところだけえらべる
        const dx = x + 0.5 - p.x;
        const dy = y + 0.5 - p.y;
        if (dx * dx + dy * dy <= R * R) limb.mask[i] = code;
      }
    }
  }
  function strokeL(a, b) {
    const R = brushR();
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(dist / Math.max(0.5, R / 2)));
    for (let k = 1; k <= n; k++) {
      stampL({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
    }
  }

  lcv.addEventListener('pointerdown', (e) => {
    if (lPaint || !limb) return;
    e.preventDefault();
    lcv.setPointerCapture(e.pointerId);
    lPid = e.pointerId;
    lPaint = true;
    lLast = lpos(e);
    stampL(lLast);
    renderLimb();
  });
  lcv.addEventListener('pointermove', (e) => {
    if (!lPaint || e.pointerId !== lPid) return;
    e.preventDefault();
    const p = lpos(e);
    strokeL(lLast, p);
    lLast = p;
    renderLimb();
  });
  const endL = (e) => {
    if (!lPaint || e.pointerId !== lPid) return;
    lPaint = false;
    lPid = null;
    rebuildLimbRig();
  };
  lcv.addEventListener('pointerup', endL);
  lcv.addEventListener('pointercancel', endL);

  function finishLimb(skip) {
    const rig = Rig.build(limb.crop, skip ? null : limb.mask);
    if (!rig) return msg('からだの部分も残してね');
    $('dp-prev').src = limb.img;
    if (handlers.onSubmit) handlers.onSubmit({ rig: Rig.serialize(rig), area: limb.area, c: limb.c, img: limb.img });
  }

  // ---------- ボタン ----------
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-c],[data-t],[data-s],[data-a],[data-lt],[data-ls]');
    if (!b) return;
    if (b.dataset.c !== undefined) { colorIdx = +b.dataset.c; if (tool === 'eraser') tool = 'pen'; refreshSel(); return; }
    if (b.dataset.t !== undefined) { tool = b.dataset.t; refreshSel(); return; }
    if (b.dataset.s !== undefined) { sizeIdx = +b.dataset.s; refreshSel(); return; }
    if (b.dataset.lt !== undefined) { limbTool = b.dataset.lt; refreshSel(); return; }
    if (b.dataset.ls !== undefined) { limbSize = +b.dataset.ls; refreshSel(); return; }

    const a = b.dataset.a;
    if (a === 'undo') {
      const prev = undoStack.pop();
      if (prev) ctx.putImageData(prev, 0, 0);
    } else if (a === 'clear') {
      pushUndo();
      ctx.clearRect(0, 0, SIZE, SIZE);
    } else if (a === 'submit') {
      const r = analyze();
      if (!r) return msg('なにか描いてね');
      if (r.w < 16 || r.h < 16) return msg('もう少し大きく描いてね');
      showLimb(r);
    } else if (a === 'lback') {
      setMode('draw');
    } else if (a === 'lclear') {
      limb.mask.fill(0);
      renderLimb();
      rebuildLimbRig();
    } else if (a === 'lok') {
      finishLimb(false);
    } else if (a === 'lskip') {
      finishLimb(true);
    } else if (a === 'redraw') {
      if (handlers.onRedraw) handlers.onRedraw();
    } else if (a === 'start') {
      if (handlers.onStart) handlers.onStart();
    } else if (a === 'invite') {
      if (handlers.onInvite) handlers.onInvite();
    }
  });

  refreshSel();

  // ---------- 外から使う入り口 ----------
  let mode = 'draw';
  const TITLES = { draw: 'キャラをかこう', limb: '手と足をえらぼう', wait: 'みんなを待っています' };
  function setMode(m) {
    mode = m;
    $('dp-draw').hidden = m !== 'draw';
    $('dp-limb').hidden = m !== 'limb';
    $('dp-wait').hidden = m !== 'wait';
    root.querySelector('.dp-title').textContent = TITLES[m];
    if (m === 'draw') requestAnimationFrame(fit);
    if (m === 'limb') { requestAnimationFrame(fitLimb); startPreview(); }
  }

  window.DrawPad = {
    init(h) { handlers = h || {}; },
    open(m) {
      root.hidden = false;
      if (m === 'draw' && mode === 'limb') return; // 手足をえらんでいる最中は、そのまま
      setMode(m || 'draw');
    },
    close() { root.hidden = true; },
    isOpen() { return !root.hidden; },
    setPreview(url) { $('dp-prev').src = url; },
    toast(text) { msg(text); },
    setRoster(list, me, canStart) {
      $('dp-roster').innerHTML = list.map((p) =>
        `<span class="dp-chip ${p.r ? 'ok' : ''}"><i style="background:${SLOT_COLORS[p.s % 4]}"></i>P${p.s + 1}${p.s === me ? '(あなた)' : ''} ${p.r ? 'OK' : 'かいてる'}</span>`
      ).join('');
      $('dp-start').disabled = !canStart;
      $('dp-hint').textContent = canStart
        ? 'みんなできたよ！「はじめる」を押そう。'
        : '友達に招待リンクを送って、みんながかけるまで待とう。';
    },
  };
})();
