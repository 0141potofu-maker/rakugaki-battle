// 描いた絵を「からだ」と「手足」に分けて、動かすためのしくみ
(() => {
  const MIN_PART = 6;      // これより小さいえらびは手足にしない(からだにもどす)
  const MAX_PER_TYPE = 4;  // 手・足それぞれ、最大4つまで
  const MIN_BODY = 12;     // からだに最低限必要なピクセル数
  const ATK_TOTAL = 26;    // 攻撃全体のフレーム数(サーバーと同じ)

  // 手足をえらんだマスク(0=なし 1=手 2=足)から、からだと手足のパーツに分ける
  function build(crop, mask) {
    const W = crop.width;
    const H = crop.height;
    const src = crop.getContext('2d').getImageData(0, 0, W, H).data;
    const n = W * H;

    // kind: 0=透明 1=からだ 2=手 3=足
    const kind = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (src[i * 4 + 3] < 128) continue;
      const m = mask ? mask[i] : 0;
      kind[i] = m === 1 ? 2 : m === 2 ? 3 : 1;
    }

    // つながっているえらびを1つのパーツにする(8方向)
    const comp = new Int32Array(n).fill(-1);
    const comps = [];
    for (let s = 0; s < n; s++) {
      if (kind[s] < 2 || comp[s] !== -1) continue;
      const k = kind[s];
      const id = comps.length;
      const px = [];
      const stack = [s];
      comp[s] = id;
      while (stack.length) {
        const i = stack.pop();
        px.push(i);
        const x = i % W;
        const y = (i / W) | 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const j = ny * W + nx;
            if (kind[j] === k && comp[j] === -1) { comp[j] = id; stack.push(j); }
          }
        }
      }
      comps.push({ k, px });
    }

    // 大きいものから最大4つまで残して、あとはからだにもどす
    const keep = [];
    for (const k of [2, 3]) {
      const list = comps.filter((c) => c.k === k).sort((a, b) => b.px.length - a.px.length);
      list.forEach((c, idx) => {
        if (idx < MAX_PER_TYPE && c.px.length >= MIN_PART) keep.push(c);
        else for (const i of c.px) kind[i] = 1;
      });
    }

    // からだ
    let bodyCount = 0;
    let bx = 0, by = 0;
    let bMinX = W, bMinY = H, bMaxX = -1, bMaxY = -1;
    const bodyCv = document.createElement('canvas');
    bodyCv.width = W;
    bodyCv.height = H;
    const bctx = bodyCv.getContext('2d');
    const bid = bctx.createImageData(W, H);
    for (let i = 0; i < n; i++) {
      if (kind[i] !== 1) continue;
      bodyCount++;
      const x = i % W;
      const y = (i / W) | 0;
      bx += x; by += y;
      if (x < bMinX) bMinX = x;
      if (x > bMaxX) bMaxX = x;
      if (y < bMinY) bMinY = y;
      if (y > bMaxY) bMaxY = y;
      bid.data[i * 4] = src[i * 4];
      bid.data[i * 4 + 1] = src[i * 4 + 1];
      bid.data[i * 4 + 2] = src[i * 4 + 2];
      bid.data[i * 4 + 3] = 255;
    }
    if (bodyCount < MIN_BODY) return null;
    bctx.putImageData(bid, 0, 0);
    bx /= bodyCount;
    by /= bodyCount;

    // 手足パーツ
    const parts = [];
    for (const c of keep) {
      let minX = W, minY = H, maxX = -1, maxY = -1, cx = 0, cy = 0;
      for (const i of c.px) {
        const x = i % W;
        const y = (i / W) | 0;
        cx += x; cy += y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      cx /= c.px.length;
      cy /= c.px.length;
      const w = maxX - minX + 1;
      const h = maxY - minY + 1;

      const cv = document.createElement('canvas');
      cv.width = w;
      cv.height = h;
      const cctx = cv.getContext('2d');
      const cid = cctx.createImageData(w, h);
      let tx = 0, ty = 0, tc = 0;           // からだとふれている点の平均
      let nearD = Infinity, nx0 = cx, ny0 = cy; // ふれていないとき用: からだの中心に一番近い点
      for (const i of c.px) {
        const x = i % W;
        const y = (i / W) | 0;
        const o = ((y - minY) * w + (x - minX)) * 4;
        cid.data[o] = src[i * 4];
        cid.data[o + 1] = src[i * 4 + 1];
        cid.data[o + 2] = src[i * 4 + 2];
        cid.data[o + 3] = 255;
        if (
          (x > 0 && kind[i - 1] === 1) || (x < W - 1 && kind[i + 1] === 1) ||
          (y > 0 && kind[i - W] === 1) || (y < H - 1 && kind[i + W] === 1)
        ) { tx += x; ty += y; tc++; }
        const d = (x - bx) ** 2 + (y - by) ** 2;
        if (d < nearD) { nearD = d; nx0 = x; ny0 = y; }
      }
      cctx.putImageData(cid, 0, 0);
      const pivX = (tc ? tx / tc : nx0) + 0.5; // 手足のつけ根
      const pivY = (tc ? ty / tc : ny0) + 0.5;
      const dx = cx + 0.5 - pivX;
      const dy = cy + 0.5 - pivY;
      const d0 = Math.hypot(dx, dy) < 0.5 ? Math.PI / 2 : Math.atan2(dy, dx); // つけ根から先へ向かう向き
      parts.push({
        k: c.k === 2 ? 'h' : 'f',
        img: cv, x: minX, y: minY, w, h,
        px: pivX - minX, py: pivY - minY,
        a: c.px.length, d0, cxp: cx, i: 0,
      });
    }
    // 左から順に番号をふる(歩くときに、左右で逆に振る)
    for (const k of ['h', 'f']) {
      parts.filter((p) => p.k === k).sort((a, b) => a.cxp - b.cxp).forEach((p, idx) => { p.i = idx; });
    }

    return { w: W, h: H, body: bodyCv, hb: [bMinX, bMinY, bMaxX - bMinX + 1, bMaxY - bMinY + 1], parts };
  }

  // 送るための形にする
  function serialize(rig) {
    return {
      w: rig.w,
      h: rig.h,
      body: rig.body.toDataURL('image/png'),
      hb: rig.hb,
      parts: rig.parts.map((p) => ({
        k: p.k,
        i: p.i,
        img: p.img.toDataURL('image/png'),
        x: p.x, y: p.y, w: p.w, h: p.h,
        px: +p.px.toFixed(1), py: +p.py.toFixed(1),
        a: p.a,
        d0: +p.d0.toFixed(3),
      })),
    };
  }

  // 届いたデータから、描ける形にする
  function load(json) {
    const mk = (src) => { const im = new Image(); im.src = src; return im; };
    return {
      w: json.w,
      h: json.h,
      body: mk(json.body),
      hb: json.hb,
      parts: json.parts.map((p) => Object.assign({}, p, { img: mk(p.img) })),
    };
  }

  // ---------- 動き ----------
  function newPose() {
    return { phase: 0, walk: 0, air: 0, hang: 0, vy: 0, t: 0, atk: 0, hurt: 0 };
  }

  // 速さ・空中・崖つかまりの状態から、動きのなめらかな度合いを更新する
  function updatePose(p, dt, s) {
    p.t += dt;
    const sp = Math.min(1, Math.abs(s.vx || 0) / 430);
    const moving = s.g && !s.hang;
    const k = 1 - Math.exp(-dt * 12);
    p.walk += ((moving ? sp : 0) - p.walk) * k;
    p.air += ((s.g || s.hang ? 0 : 1) - p.air) * k;
    p.hang += ((s.hang ? 1 : 0) - p.hang) * k;
    p.vy = s.vy || 0;
    if (moving) p.phase += dt * (6 + 8 * sp);
    // やられたとき(のけぞり)
    p.hurt += ((s.hs ? 1 : 0) - p.hurt) * (1 - Math.exp(-dt * 25));
    // 攻撃中(0〜1で進みぐあいを表す。サーバーのフレーム数と合わせる)
    if (s.at > 0) {
      const target = Math.min(1, s.at / ATK_TOTAL);
      p.atk = p.atk > 0 ? Math.max(Math.min(1, p.atk + (dt * 60) / ATK_TOTAL), target) : target;
    } else {
      p.atk = 0;
    }
  }

  // パンチの動き: 引く → つき出す → もどす (pは0〜1)
  function punchK(p) {
    if (p < 0.27) return -0.3 * (p / 0.27);
    if (p < 0.55) return -0.3 + 1.3 * ((p - 0.27) / 0.28);
    return 1 - (p - 0.55) / 0.45;
  }
  function punchExt(p) {
    if (p < 0.27) return 0;
    if (p < 0.55) return (p - 0.27) / 0.28;
    return 1 - (p - 0.55) / 0.45;
  }

  function delta(from, to) {
    let d = to - from;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
  }
  function clamp(v, m) { return Math.max(-m, Math.min(m, v)); }

  // 手足の角度(ラジアン)
  function angle(part, pose, fh) {
    const hand = part.k === 'h';
    const idx = part.i || 0;
    const idle = Math.sin(pose.t * 2.2 + idx * 1.7) * (hand ? 0.07 : 0.03);
    const walk = Math.sin(pose.phase + (hand ? Math.PI : 0) + idx * Math.PI) * (hand ? 0.8 : 0.85);
    const ground = idle * (1 - pose.walk) + walk * pose.walk;

    const alt = idx % 2 ? 1 : -1;
    const up = clamp(delta(part.d0, -Math.PI / 2), 1.3);
    const air = hand ? up * 0.55 : alt * (pose.vy < 0 ? 0.7 : 0.3);

    let a = ground * (1 - pose.air) + air * pose.air;
    if (pose.hang > 0.001) {
      const hangA = hand ? clamp(delta(part.d0, -Math.PI / 2), 1.6) * 0.95 : 0;
      a = a * (1 - pose.hang) + hangA * pose.hang;
    }
    // 攻撃: いちばん前(右)の手が、前につき出される
    if (pose.atk > 0 && hand && idx === fh) {
      a = clamp(delta(part.d0, 0), 1.6) * punchK(pose.atk);
    }
    // のけぞり: 手足をバタバタさせる
    if (pose.hurt > 0.001) {
      a = a * (1 - pose.hurt) + Math.sin(pose.t * 25 + idx * 2.1) * 0.9 * pose.hurt;
    }
    return a;
  }

  function ready(img) {
    return img instanceof HTMLCanvasElement || (img.complete && img.naturalWidth > 0);
  }

  function drawPart(ctx, p, pose, fh) {
    if (!ready(p.img)) return;
    ctx.save();
    ctx.translate(p.x + p.px, p.y + p.py);
    ctx.rotate(angle(p, pose, fh));
    if (pose.atk > 0 && p.k === 'h' && p.i === fh) {
      // パンチのとき、手がつけ根から先へのびる
      const ext = Math.max(p.w, p.h) * 0.5 * punchExt(pose.atk);
      ctx.translate(Math.cos(p.d0) * ext, Math.sin(p.d0) * ext);
    }
    ctx.drawImage(p.img, -p.px, -p.py);
    ctx.restore();
  }

  // 絵の左上を原点として描く(呼び出し側で位置・拡大・左右反転をすませておく)
  function draw(ctx, rig, pose) {
    const bob = -Math.abs(Math.sin(pose.phase)) * 2.5 * pose.walk * (1 - pose.air);
    const lunge = pose.atk > 0 ? Math.sin(Math.min(1, pose.atk) * Math.PI) * 5 : 0; // 攻撃で少し前へ
    let fh = -1; // いちばん前(右)の手の番号
    for (const p of rig.parts) if (p.k === 'h' && p.i > fh) fh = p.i;
    ctx.save();
    ctx.translate(lunge, bob);
    for (const p of rig.parts) if (p.k === 'f') drawPart(ctx, p, pose, fh);
    if (ready(rig.body)) ctx.drawImage(rig.body, 0, 0);
    for (const p of rig.parts) if (p.k === 'h') drawPart(ctx, p, pose, fh);
    ctx.restore();
  }

  window.Rig = { build, serialize, load, newPose, updatePose, draw };
})();
