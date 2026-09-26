/* ── 點擊特效（依天氣型別：落葉 / 雨滴 / 雪花 / 花瓣 / 預設魔法粒子） ── */
(function initClickSparks() {
  let _lastClick = 0, _activeFx = 0;

  /* ── 建立暫時 Canvas；超過 4 個並行特效時跳過 ── */
  function makeCanvas(cx, cy, size) {
    // ★ 2026-09-26 系統開了「減少動態」→ 不產生點擊特效（Apple：Reduce Motion 要少掉裝飾性動畫）
    try { if (matchMedia("(prefers-reduced-motion: reduce)").matches) return null; } catch (e) {}
    if (_activeFx >= 4) return null;
    _activeFx++;
    const cvs = document.createElement("canvas");
    /* ★ 2026-09-26 點擊特效改成**依螢幕像素密度作畫**。
       2026-09-25 那次「天氣全部畫到 4K 等級」只處理了天氣層，這幾個點擊特效的 canvas
       被漏掉了：原本 `cvs.width = size`（邏輯像素）而顯示寬度也是 size →
       在 2x/3x 螢幕上是把 240px 的圖拉大顯示 ＝ 糊掉（落葉邊緣、雨絲、雪花都看得出來）。
       ⚠ 上限 3x：再高只是多耗 GPU，肉眼看不出差別（同 weather.js 的做法）。
       ⚠ 縮放寫在這裡就好：各 spawn 函式後面自己呼叫的 `getContext("2d")` 拿到的是**同一個**
         context，transform 會留著，它們用邏輯座標畫圖完全不必改。 */
    const _dpr = Math.min(3, (window.devicePixelRatio || 1));
    cvs.width = Math.round(size * _dpr); cvs.height = Math.round(size * _dpr);
    try { cvs.getContext("2d").setTransform(_dpr, 0, 0, _dpr, 0, 0); } catch (e) {}
    cvs.style.cssText = `position:fixed;left:${cx-size/2}px;top:${cy-size/2}px;` +
                        `width:${size}px;height:${size}px;pointer-events:none;z-index:9999;`;
    document.body.appendChild(cvs);
    cvs._fxDone = () => { _activeFx--; cvs.remove(); };
    return cvs;
  }

  /* ── 落葉（邊緣橘棕發光） ── */
  function spawnLeaves(cx, cy) {
    const C = ["#8B4513","#CD853F","#D2691E","#A0522D","#6B8E23","#9ACD32","#DAA520","#FF8C00"];
    const SIZE = 240, N = 11;
    const cvs = makeCanvas(cx, cy, SIZE); if(!cvs) return;
    const ctx = cvs.getContext("2d");
    const ox = SIZE/2, oy = SIZE/2;
    const pts = Array.from({length:N}, () => {
      const a = Math.random()*Math.PI*2, spd = 1+Math.random()*2;
      return { x:ox, y:oy, vx:Math.cos(a)*spd, vy:Math.sin(a)*spd-0.6,
               g:0.08+Math.random()*.05, rot:Math.random()*Math.PI*2,
               rs:(Math.random()-.5)*.15, sw:3+Math.random()*3, sh:1.5+Math.random()*2,
               col:C[Math.floor(Math.random()*C.length)], life:1 };
    });
    function draw(lf) {
      ctx.save(); ctx.globalAlpha=lf.life*.9; ctx.translate(lf.x,lf.y); ctx.rotate(lf.rot);
      ctx.shadowColor="rgba(255,160,50,0.9)"; ctx.shadowBlur=10;
      ctx.beginPath(); ctx.ellipse(0,0,lf.sw,lf.sh,0,0,Math.PI*2);
      ctx.fillStyle=lf.col; ctx.fill();
      ctx.shadowBlur=0;
      ctx.beginPath(); ctx.moveTo(-lf.sw,0); ctx.lineTo(lf.sw,0);
      ctx.strokeStyle="rgba(0,0,0,.18)"; ctx.lineWidth=.8; ctx.stroke();
      ctx.restore();
    }
    let raf; function loop() {
      ctx.clearRect(0,0,SIZE,SIZE); let alive=false;
      for (const lf of pts) {
        lf.x+=lf.vx; lf.y+=lf.vy; lf.vy+=lf.g; lf.vx*=.98; lf.rot+=lf.rs; lf.life-=.013;
        if(lf.life>0){alive=true;draw(lf);}
      }
      if(alive) raf=requestAnimationFrame(loop); else{cancelAnimationFrame(raf);cvs._fxDone();}
    } loop();
  }

  /* ── 雨滴（藍白發光線條） ── */
  function spawnRain(cx, cy) {
    const SIZE = 240, N = 16;
    const cvs = makeCanvas(cx, cy, SIZE); if(!cvs) return;
    const ctx = cvs.getContext("2d");
    const ox = SIZE/2, oy = SIZE/2;
    const pts = Array.from({length:N}, (_,i) => {
      const a = (i/N)*Math.PI*2+(Math.random()-.5)*.5, spd=1.5+Math.random()*2;
      return { x:ox, y:oy, vx:Math.cos(a)*spd, vy:Math.sin(a)*spd, g:.08, len:3+Math.random()*4, life:1 };
    });
    let raf; function loop() {
      ctx.clearRect(0,0,SIZE,SIZE); let alive=false;
      for (const d of pts) {
        d.x+=d.vx; d.y+=d.vy; d.vy+=d.g; d.vx*=.97; d.life-=.02;
        if(d.life>0){
          alive=true;
          const spd=Math.hypot(d.vx,d.vy)||1, nx=d.vx/spd, ny=d.vy/spd;
          ctx.save(); ctx.globalAlpha=d.life*.85;
          ctx.shadowColor="rgba(120,200,255,0.95)"; ctx.shadowBlur=8;
          ctx.strokeStyle="rgba(180,225,255,1)"; ctx.lineWidth=2; ctx.lineCap="round";
          ctx.beginPath();
          ctx.moveTo(d.x-nx*d.len*.5,d.y-ny*d.len*.5); ctx.lineTo(d.x+nx*d.len*.5,d.y+ny*d.len*.5);
          ctx.stroke(); ctx.restore();
        }
      }
      if(alive) raf=requestAnimationFrame(loop); else{cancelAnimationFrame(raf);cvs._fxDone();}
    } loop();
  }

  /* ── 雪花（冰藍發光晶體） ── */
  function spawnSnow(cx, cy) {
    const SIZE = 240, N = 9;
    const cvs = makeCanvas(cx, cy, SIZE); if(!cvs) return;
    const ctx = cvs.getContext("2d");
    const ox = SIZE/2, oy = SIZE/2;
    const pts = Array.from({length:N}, () => {
      const a = Math.random()*Math.PI*2, spd=0.8+Math.random()*1.5;
      return { x:ox, y:oy, vx:Math.cos(a)*spd, vy:Math.sin(a)*spd-.3,
               g:.02, rot:Math.random()*Math.PI*2, rs:(Math.random()-.5)*.06,
               r:2.5+Math.random()*2.5, life:1 };
    });
    function drawFlake(f) {
      ctx.save(); ctx.globalAlpha=f.life*.9;
      ctx.shadowColor="rgba(180,225,255,1)"; ctx.shadowBlur=9;
      ctx.strokeStyle="rgba(220,242,255,1)"; ctx.lineWidth=Math.max(.8,f.r*.18); ctx.lineCap="round";
      ctx.translate(f.x,f.y); ctx.rotate(f.rot); ctx.beginPath();
      for(let i=0;i<6;i++){
        const a=(i/6)*Math.PI*2, ax=Math.cos(a)*f.r, ay=Math.sin(a)*f.r;
        ctx.moveTo(0,0); ctx.lineTo(ax,ay);
        [.45,.68].forEach(t=>{
          const bx=ax*t,by=ay*t,len=f.r*.3;
          [a+Math.PI/4,a-Math.PI/4].forEach(ba=>{
            ctx.moveTo(bx,by); ctx.lineTo(bx+Math.cos(ba)*len,by+Math.sin(ba)*len);
          });
        });
      }
      ctx.stroke(); ctx.restore();
    }
    let raf; function loop() {
      ctx.clearRect(0,0,SIZE,SIZE); let alive=false;
      for (const f of pts) {
        f.x+=f.vx; f.y+=f.vy; f.vy+=f.g; f.vx*=.99; f.rot+=f.rs; f.life-=.014;
        if(f.life>0){alive=true;drawFlake(f);}
      }
      if(alive) raf=requestAnimationFrame(loop); else{cancelAnimationFrame(raf);cvs._fxDone();}
    } loop();
  }

  /* ── 花瓣（粉紅螢光邊緣） ── */
  function spawnPetals(cx, cy) {
    const C = ["#FFB7C5","#FF91A4","#FFD1DC","#FF69B4","#FFC0CB","#FFFFFF","#FFE4E1"];
    const SIZE = 240, N = 13;
    const cvs = makeCanvas(cx, cy, SIZE); if(!cvs) return;
    const ctx = cvs.getContext("2d");
    const ox = SIZE/2, oy = SIZE/2;
    const pts = Array.from({length:N}, () => {
      const a = Math.random()*Math.PI*2, spd=0.9+Math.random()*1.5;
      return { x:ox, y:oy, vx:Math.cos(a)*spd, vy:Math.sin(a)*spd-0.5,
               g:.06, rot:Math.random()*Math.PI*2, rs:(Math.random()-.5)*.12,
               w:2.5+Math.random()*2.5, h:2+Math.random()*2, seed:Math.random()*100,
               col:C[Math.floor(Math.random()*C.length)], life:1 };
    });
    function drawPetal(p) {
      ctx.save(); ctx.globalAlpha=p.life*.9;
      ctx.translate(p.x,p.y); ctx.rotate(p.rot);
      ctx.shadowColor="rgba(255,100,160,0.9)"; ctx.shadowBlur=11;
      ctx.beginPath();
      ctx.moveTo(0,p.h*.5);
      ctx.bezierCurveTo( p.w,-p.h*.2, p.w,-p.h*.8, 0,-p.h*.5);
      ctx.bezierCurveTo(-p.w,-p.h*.8,-p.w,-p.h*.2, 0, p.h*.5);
      ctx.fillStyle=p.col; ctx.fill();
      ctx.shadowBlur=0;
      ctx.strokeStyle="rgba(255,100,150,.3)"; ctx.lineWidth=.5; ctx.stroke();
      ctx.restore();
    }
    let raf, t=0; function loop() {
      ctx.clearRect(0,0,SIZE,SIZE); let alive=false; t++;
      for (const p of pts) {
        p.x+=p.vx; p.y+=p.vy; p.vy+=p.g;
        p.vx+=Math.sin(t*.04+p.seed)*.025;
        p.rot+=p.rs; p.life-=.013;
        if(p.life>0){alive=true;drawPetal(p);}
      }
      if(alive) raf=requestAnimationFrame(loop); else{cancelAnimationFrame(raf);cvs._fxDone();}
    } loop();
  }

  /* ── 預設魔法粒子（非天氣模式） ── */
  const DEF_COLORS = ["#4ECDC4","#8B5CF6","#FCD34D","#A78BFA","#67E8F9","#F472B6","#FBBF24","#34D399","#FB923C"];
  function spawnEl(cls, x, y, extra) {
    const el = document.createElement("div");
    el.className = cls;
    el.style.cssText = `left:${x}px;top:${y}px;${extra}`;
    document.body.appendChild(el);
    return el;
  }
  /* ── 雷暴點擊：小閃電向外輻射 ── */
  function spawnLightning(cx, cy) {
    const SIZE = 150, N = 5;
    const cvs = makeCanvas(cx, cy, SIZE); if(!cvs) return;
    const ctx = cvs.getContext("2d");
    const ox = SIZE/2, oy = SIZE/2;
    function minibolt(x1,y1,x2,y2,d) {
      if (d===0) return [[x2,y2]];
      const mx=(x1+x2)/2+(Math.random()-.5)*8*(d/3);
      const my=(y1+y2)/2+(Math.random()-.5)*8*(d/3);
      return [...minibolt(x1,y1,mx,my,d-1),...minibolt(mx,my,x2,y2,d-1)];
    }
    const bolts = Array.from({length:N}, (_,i) => {
      const a = (i/N)*Math.PI*2+(Math.random()-.5)*.5;
      const len = 20+Math.random()*25;
      const ex = ox+Math.cos(a)*len, ey = oy+Math.sin(a)*len;
      return { path:[[ox,oy],...minibolt(ox,oy,ex,ey,3)], alpha:1, delay:Math.floor(Math.random()*3) };
    });
    let flashA = 0.7, frame = 0;
    let raf; function loop() {
      ctx.clearRect(0,0,SIZE,SIZE);
      if (flashA>0) {
        const g = ctx.createRadialGradient(ox,oy,0,ox,oy,14+flashA*10);
        g.addColorStop(0,`rgba(255,255,200,${flashA*.7})`);
        g.addColorStop(0.5,`rgba(180,220,255,${flashA*.3})`);
        g.addColorStop(1,"rgba(0,0,0,0)");
        ctx.fillStyle=g; ctx.fillRect(0,0,SIZE,SIZE);
        flashA=Math.max(0,flashA-.08);
      }
      let alive=false;
      for (const b of bolts) {
        if (frame<b.delay){alive=true;continue;}
        if (b.alpha<=0) continue;
        alive=true;
        ctx.save(); ctx.lineCap="round";
        ctx.shadowColor="rgba(180,220,255,1)"; ctx.shadowBlur=10;
        ctx.strokeStyle=`rgba(210,235,255,${b.alpha*.65})`; ctx.lineWidth=2;
        ctx.beginPath(); ctx.moveTo(b.path[0][0],b.path[0][1]);
        b.path.slice(1).forEach(([x,y])=>ctx.lineTo(x,y)); ctx.stroke();
        ctx.shadowBlur=4;
        ctx.strokeStyle=`rgba(255,255,255,${b.alpha*.9})`; ctx.lineWidth=0.8;
        ctx.beginPath(); ctx.moveTo(b.path[0][0],b.path[0][1]);
        b.path.slice(1).forEach(([x,y])=>ctx.lineTo(x,y)); ctx.stroke();
        ctx.restore();
        b.alpha-=.07;
      }
      frame++;
      if(alive||flashA>0) raf=requestAnimationFrame(loop); else{cancelAnimationFrame(raf);cvs._fxDone();}
    } loop();
  }

  /* ── 骰子點擊特效：三顆骰子滾動後顯示隨機點數 ── */
  const _DICE_DOTS = [
    null,
    [[0,0]],
    [[-.32,-.32],[.32,.32]],
    [[-.32,-.32],[0,0],[.32,.32]],
    [[-.32,-.32],[.32,-.32],[-.32,.32],[.32,.32]],
    [[-.32,-.32],[.32,-.32],[0,0],[-.32,.32],[.32,.32]],
    [[-.32,-.32],[.32,-.32],[-.32,0],[.32,0],[-.32,.32],[.32,.32]],
  ];
  function _drawDie(ctx, x, y, rot, face, alpha) {
    const S=13;
    ctx.save(); ctx.globalAlpha=alpha; ctx.translate(x,y); ctx.rotate(rot);
    const fw=S*1.85, dX=S*.68, dY=S*.38, r=3;
    /* center 3D bounding box at origin */
    const fx=-(fw+dX)/2, fy=-fw/2+dY/2;
    /* right face (shadow) — 本體 10% 透明 */
    ctx.fillStyle='rgba(184,160,112,.10)';
    ctx.beginPath(); ctx.moveTo(fx+fw,fy); ctx.lineTo(fx+fw+dX,fy-dY); ctx.lineTo(fx+fw+dX,fy+fw-dY); ctx.lineTo(fx+fw,fy+fw); ctx.closePath(); ctx.fill();
    ctx.strokeStyle='rgba(80,50,10,.28)'; ctx.lineWidth=.8; ctx.stroke();
    /* top face (highlight) */
    ctx.fillStyle='rgba(245,237,210,.10)';
    ctx.beginPath(); ctx.moveTo(fx,fy); ctx.lineTo(fx+fw,fy); ctx.lineTo(fx+fw+dX,fy-dY); ctx.lineTo(fx+dX,fy-dY); ctx.closePath(); ctx.fill();
    ctx.strokeStyle='rgba(80,50,10,.28)'; ctx.lineWidth=.8; ctx.stroke();
    /* front face */
    ctx.shadowColor='rgba(40,20,0,.35)'; ctx.shadowBlur=8; ctx.shadowOffsetX=1; ctx.shadowOffsetY=2;
    const bodyG=ctx.createLinearGradient(fx,fy,fx+fw,fy+fw);
    bodyG.addColorStop(0,'rgba(248,240,220,.10)'); bodyG.addColorStop(.45,'rgba(237,224,190,.10)'); bodyG.addColorStop(1,'rgba(216,200,152,.10)');
    function faceRect(){ctx.beginPath(); ctx.moveTo(fx+r,fy); ctx.lineTo(fx+fw-r,fy); ctx.arcTo(fx+fw,fy,fx+fw,fy+r,r); ctx.lineTo(fx+fw,fy+fw-r); ctx.arcTo(fx+fw,fy+fw,fx+fw-r,fy+fw,r); ctx.lineTo(fx+r,fy+fw); ctx.arcTo(fx,fy+fw,fx,fy+fw-r,r); ctx.lineTo(fx,fy+r); ctx.arcTo(fx,fy,fx+r,fy,r); ctx.closePath();}
    ctx.fillStyle=bodyG; faceRect(); ctx.fill();
    ctx.shadowBlur=0; ctx.shadowOffsetX=0; ctx.shadowOffsetY=0;
    ctx.strokeStyle='rgba(120,90,50,.30)'; ctx.lineWidth=1; faceRect(); ctx.stroke();
    const hlG=ctx.createLinearGradient(fx,fy,fx+fw*.6,fy+fw*.6);
    hlG.addColorStop(0,'rgba(255,255,255,.04)'); hlG.addColorStop(.5,'rgba(255,255,255,.01)'); hlG.addColorStop(1,'rgba(255,255,255,0)');
    ctx.fillStyle=hlG; faceRect(); ctx.fill();
    /* dots on front face */
    const dots=_DICE_DOTS[face], spread=fw*.42, R=2.0, cx=fx+fw/2, cy=fy+fw/2;
    ctx.shadowColor='rgba(0,0,0,.75)'; ctx.shadowBlur=3; ctx.shadowOffsetY=.8;
    ctx.fillStyle='rgba(255,252,238,.96)';
    dots.forEach(([ddx,ddy])=>{ctx.beginPath(); ctx.arc(cx+ddx*spread,cy+ddy*spread,R,0,Math.PI*2); ctx.fill();});
    ctx.restore();
  }
  function spawnDice(cx, cy) {
    const SIZE = 220;
    const cvs = makeCanvas(cx, cy, SIZE); if (!cvs) return;
    const c = cvs.getContext("2d");
    const OX = SIZE / 2, OY = SIZE / 2;
    const FLOOR = SIZE - 20;   // ground line inside canvas
    const GRAVITY = 0.32;

    /* 3 dice thrown in different directions with spread so they don't overlap */
    const dice = Array.from({length: 3}, (_, i) => {
      const ang = (i - 1) * 0.7 + (Math.random() - 0.5) * 0.3;  // -0.7, 0, +0.7 rad ± noise
      const spd = 1.4 + Math.random() * 0.8;
      return {
        x: OX + (i - 1) * 10,
        y: OY,
        vx: Math.sin(ang) * spd,
        vy: -(1.6 + Math.random() * 1.0),   // thrown upward
        rot: Math.random() * Math.PI * 2,
        rotSpd: (Math.random() < .5 ? 1 : -1) * (0.12 + Math.random() * 0.18),
        face: 1 + Math.floor(Math.random() * 6),
        bounces: 0,
        settled: false,
        settledAt: 0,
        alpha: 0.92
      };
    });

    let frame = 0, raf;
    function loop() {
      c.clearRect(0, 0, SIZE, SIZE);
      let alive = false;
      for (const d of dice) {
        if (d.alpha <= 0) continue;
        alive = true;
        if (!d.settled) {
          d.vy += GRAVITY;
          d.x  += d.vx;
          d.y  += d.vy;
          d.rot += d.rotSpd;
          // bounce off walls
          if (d.x < 18)        { d.x =  18; d.vx =  Math.abs(d.vx) * 0.6; }
          if (d.x > SIZE - 18) { d.x = SIZE - 18; d.vx = -Math.abs(d.vx) * 0.6; }
          // bounce off floor
          if (d.y >= FLOOR) {
            d.y = FLOOR;
            d.bounces++;
            d.vy  = -d.vy  * Math.max(0.10, 0.52 - d.bounces * 0.12);
            d.vx  *=  0.72;
            d.rotSpd *= 0.55;
            if (Math.abs(d.vy) < 0.6) { d.settled = true; d.settledAt = frame; }
          }
          _drawDie(c, d.x, d.y, d.rot, 1 + Math.floor(Math.random() * 6), d.alpha);
        } else {
          // resting: snap to nearest 90° and show final face, then fade
          if (frame - d.settledAt > 28) d.alpha = Math.max(0, d.alpha - 0.032);
          _drawDie(c, d.x, d.y, 0, d.face, d.alpha);
        }
      }
      frame++;
      if (alive) raf = requestAnimationFrame(loop);
      else { cancelAnimationFrame(raf); cvs._fxDone(); }
    }
    loop();
  }

  /* ★★ 2026-09-26 使用者：「我要煙火感」。
     前一版是 DOM+CSS 的星閃 —— 但煙火的三個特徵 **拋物線、尾跡、末段閃爍** 用 CSS 做不到
     （每顆粒子要各自受重力與空氣阻力、還要留下漸淡的尾巴）→ 改用 canvas 逐幀畫。
     ⚠ `makeCanvas` 已經處理 DPR（2026-09-26 補的），這裡用邏輯座標畫就好。
     ★ 煙火之所以像煙火，是這幾件事一起發生：
       ①**同一發只有一個主色**（±12° 色相變化）—— 每顆亂一個顏色會變成彩帶，不是煙火
       ②**速度分佈很散**（1.6~5.0）：有的衝很遠、有的近，炸開才有層次
       ③**重力 + 阻力**：先放射、再被拉成拋物線
       ④**尾跡**：留最近幾個位置畫成漸細的線
       ⑤**末段閃爍**：life < 0.35 之後隨機明滅，像火星要熄不熄
       ⑥**加法混色**（`lighter`）：重疊處變亮，才有炸開的光感
     ⚠ 起爆瞬間要有一團白光（不然只是粒子往外飛，沒有「炸開」的重量）。 */
  /* 煙火色盤（2026-09-26 使用者：「顏色庫太少了 多些」→ 6 色擴到 12 色）。
     繞色相環一圈鋪開，真實煙火常見的金／紅／綠／藍／紫都在：
     ⚠ 這裡只放**色相**，飽和度與亮度在粒子那邊統一（95% / 58~74%）——
       混進低飽和的顏色會在加法混色下變成一團白，看不出是哪一色。 */
  const _FW_HUES = [
    52,   // 檸檬黃
    38,   // 金
    18,   // 橘
    8,    // 朱紅
    345,  // 玫瑰紅
    330,  // 桃紅
    300,  // 洋紅
    275,  // 紫
    250,  // 藍紫
    214,  // 寶藍
    196,  // 青
    150,  // 翠綠
  ];
  /* ★ 2026-09-26 使用者：「煙火卡卡的，第二次像點兩下」。
     第一版把第二色做成「180ms 後在同一點再閃一次白光」→ 那正是**再點一下**的長相。
     改成雙層煙花彈的做法：第一色是**外層**（衝得遠）、第二色是**內層**（慢、範圍小），
     只晚 7 幀（約 115ms）＝ 看得出先後但仍是同一發；第二色不再有自己的起爆白光。 */
  const _FW_LAG = 7;
  function spawnFirework(cx, cy) {
    /* ★ 2026-09-27 使用者：「煙火都要更燦爛」之後量到**單發有一幀 50ms** —— 每一發都在現烤
     貼圖（起爆白光 + 兩張光暈 + 兩張星芒，共 5 張、含 8 次漸層填色）。
     色盤只有 12 色 → 依**色相**快取，整個工作階段最多烤 12 組，之後每發都是零成本。
     ★ 這是同一條教訓的第三次：會重複做的繪圖工作，先想「能不能烤起來重用」。 */
  const _FW_SPRITES = new Map();
  function _fwBake(px, stops) {
    const c = document.createElement("canvas");
    c.width = c.height = px;
    const g = c.getContext("2d");
    const rg = g.createRadialGradient(px / 2, px / 2, 0, px / 2, px / 2, px / 2);
    stops.forEach(([o, col]) => rg.addColorStop(o, col));
    g.fillStyle = rg; g.fillRect(0, 0, px, px);
    return c;
  }
  function _fwFlare(hue, deg) {
    /* 星芒（十字光芒）＝ 眼睛認得「這東西很亮」的訊號，加了之後同樣的粒子亮一個級距。
       ⚠ 烤**兩個角度**（0°/45°）交錯用：逐顆 rotate 要 save/restore，
         60 顆 × 4 發同時會把成本放大到看得見。 */
    const px = 64, c = document.createElement("canvas");
    c.width = c.height = px;
    const g = c.getContext("2d");
    g.translate(px / 2, px / 2); g.rotate(deg * Math.PI / 180);
    for (const [w, h, a] of [[px, 2.2, .55], [2.2, px, .55], [px * .55, 5, .3], [5, px * .55, .3]]) {
      const horiz = w > h;
      const lg = horiz ? g.createLinearGradient(-w / 2, 0, w / 2, 0)
                       : g.createLinearGradient(0, -h / 2, 0, h / 2);
      lg.addColorStop(0, `hsla(${hue},100%,85%,0)`);
      lg.addColorStop(.5, `hsla(${hue},100%,92%,${a})`);
      lg.addColorStop(1, `hsla(${hue},100%,85%,0)`);
      g.fillStyle = lg; g.fillRect(-w / 2, -h / 2, w, h);
    }
    return c;
  }
  function _fwSprites(hue) {
    const key = Math.round(hue);
    let sp = _FW_SPRITES.get(key);
    if (!sp) {
      sp = {
        flash: _fwBake(64, [[0, `hsla(${hue},100%,94%,.95)`], [.45, `hsla(${hue},100%,72%,.38)`], [1, `hsla(${hue},100%,60%,0)`]]),
        glow:  _fwBake(32, [[0, `hsla(${hue},100%,80%,.95)`], [.35, `hsla(${hue},100%,62%,.45)`], [1, `hsla(${hue},100%,55%,0)`]]),
        flare: _fwFlare(hue, (key % 2) ? 45 : 0),
      };
      _FW_SPRITES.set(key, sp);
    }
    return sp;
  }
  let _FW_HOT_C = null;
  const _FW_HOT = () => (_FW_HOT_C || (_FW_HOT_C = _fwBake(32,
    [[0, "rgba(255,255,255,.95)"], [.4, "rgba(255,246,222,.42)"], [1, "rgba(255,240,200,0)"]])));

  /* ★★ 2026-09-27：一發抽一種**彈型**，連點時才不會每次都長一樣（真實的煙火秀也是換著放）。
       全部都只是同一套粒子的參數組，沒有第二套繪圖程式：
         ・菊花彈 peony：標準球 + 尾跡（最常見）
         ・柳枝 willow：重力大、燒得久、尾巴長 → 炸開後像垂柳往下掛
         ・冠形 ring  ：速度帶極窄、粒子細 → 一圈很乾淨的環
         ・二段彈 double：第一段只飛幾顆彗星，飛到一半**各自再炸開**（真實的多重爆）
         ・超大一般 big：菊花彈整個放大
         ・超大二段 mega2：全場最稀有，彗星更多、飛更遠、每顆再炸 16 顆
       ⚠ 機率集中在下面這張權重表，改一個數字就好 —— 原本是三元運算子疊起來的，
         每加一種就要重算所有分界點，很容易算錯。
       ⚠ 權重刻意不平均：特殊彈每三次就來一次反而顯得亂。 */
    const _FW_KINDS = [["peony", 52], ["willow", 22], ["ring", 18],
                       ["double", 5], ["big", 2], ["mega2", 1]];   // 使用者指定：5% / 2% / 1%
    const TYPE = (() => {
      let r = Math.random() * _FW_KINDS.reduce((a, k) => a + k[1], 0);
      for (const [name, w] of _FW_KINDS) { if ((r -= w) < 0) return name; }
      return "peony";
    })();
    const TW = {
      //        球半徑     速度帶      壽命       重力     阻力       尾跡     金粉    亮點      粒子   畫布     子彈
      peony:  { r: 1,    spread: .22, decay: 1,   g: 1,    drag: .972, hist: 20, gl: 30, dot: 1.1,  n: 60, size: 1 },
      willow: { r: .82,  spread: .18, decay: .62, g: 1.75, drag: .963, hist: 30, gl: 36, dot: 1,    n: 56, size: 1 },
      ring:   { r: 1.12, spread: .07, decay: 1.1, g: .85,  drag: .977, hist: 16, gl: 20, dot: .95,  n: 56, size: 1 },
      double: { r: .92,  spread: .10, decay: .42, g: 1.1,  drag: .985, hist: 30, gl: 14, dot: 1.2,  n: 10, size: 1,   kids: 14, burst: 26 },
      /* 超大彈：粒子與半徑都放大，**畫布也要跟著放大** —— 畫布是以點擊處為中心的固定方框，
         不放大的話外圈直接被裁掉（那會比沒放大還難看）。 */
      big:    { r: 2.15, spread: .20, decay: .68, g: .88,  drag: .980, hist: 30, gl: 56, dot: 1.5,  n: 98, size: 2.1 },
      mega2:  { r: 1.85, spread: .10, decay: .30, g: 1,    drag: .990, hist: 42, gl: 26, dot: 1.55, n: 18, size: 2.3, kids: 20, burst: 38 },
    }[TYPE];
    const IS2 = TYPE === "double" || TYPE === "mega2";
    const SIZE = Math.round(340 * TW.size);   // 超大彈要更大的畫布，否則外圈被裁掉
    const cvs = makeCanvas(cx, cy, SIZE); if (!cvs) return;
    const ctx = cvs.getContext("2d");
    const ox = SIZE / 2, oy = SIZE / 2;
    /* ★ 2026-09-26 使用者：「按鈕煙火要一次隨機兩種配色出來」。
       同一發抽**兩個**主色（一定不同），每顆粒子各挑一個 → 炸開時兩色交錯。
       ⚠ 仍然只有兩個主色、各自 ±12° 變化 —— 每顆亂一個顏色會變回彩帶，那正是當初
         「一發一色」要避免的事；兩色是「有層次」與「還像同一發」的平衡點。 */
    const h0 = _FW_HUES[Math.floor(Math.random() * _FW_HUES.length)];
    /* ⚠ 兩色必須**看得出是兩色**：調色盤裡朱紅 8° 與橘 18° 只差 10°，隨機抽到那組時
       實測整發只驗得到一個色群（0~10° 佔 90%）＝ 等於沒做。→ 只從「色相差 ≥60°」的裡面抽。 */
    const _far = _FW_HUES.filter(h => { const d = Math.abs(h - h0) % 360; return Math.min(d, 360 - d) >= 60; });
    const h1 = (_far.length ? _far : _FW_HUES.filter(h => h !== h0))[Math.floor(Math.random() * (_far.length || (_FW_HUES.length - 1)))];
    const HUES = [h0, h1];
    const hue = HUES[0];                             // 起爆白光用第一色

    /* ★★ 2026-09-27 使用者：「煙火特效要更好更漂亮」。往「真的煙火」再靠一階的四件事：
       ①**球形**：速度收成窄帶（±11%）→ 外緣是一圈整齊的球（真實的菊花彈就是這樣），
         原本 2.4~5.2 均勻亂數會炸成一團糊。兩層各自一顆球，內層半徑約外層的 55%。
       ②**溫度變化**：真的星火是「白熱 → 主色 → 暗紅」燒過去的。每顆先算好三個顏色，
         依 life 取用 —— ⚠ 不可以每幀組 hsl() 字串（58 顆 × 60 幀＝三千多次配置）。
       ③**漸細尾跡**：尾巴分段畫，越舊越細越淡（原本整條同寬同淡，看起來像畫線）。
       ④**金粉**：另一批很小、閃得快、掉得慢的細星 —— 那是煙火「碎裂感」的來源。
       ⑤起爆瞬間加一圈擴散的細環（衝擊波），成本只有一次 stroke。
       ⚠ 貼圖一律預烤：這支的效能史就是「shadowBlur → 貼圖」「每幀漸層 → 貼圖」兩次教訓。 */
    const R0 = (3.2 + Math.random() * 1.5) * TW.r;   // 外層球的半徑速度
    const P = Array.from({ length: TW.n }, (_, i) => {
      // 二段彈：第一段全是第一色的彗星，第二色留給它們各自炸開的那一下
      const k = IS2 ? 0 : (i % 2);                   // 兩色各半（亂數分配會讓某些發偏向一色）
      const a = Math.random() * Math.PI * 2;
      const base = k === 0 ? R0 : R0 * .55;
      const spd = base * (1 - TW.spread / 2 + Math.random() * TW.spread);   // 窄帶＝球形
      const d = k === 0 ? 0 : Math.max(0, _FW_LAG + Math.round((Math.random() - .5) * 4));
      const h = HUES[k] + (Math.random() - .5) * 20;
      return {
        x: ox, y: oy, vx: Math.cos(a) * spd, vy: Math.sin(a) * spd, k, d,
        cols: [                                      // 白熱 → 主色 → 餘燼
          `hsl(${h.toFixed(0)}, 92%, 88%)`,
          `hsl(${h.toFixed(0)}, 96%, ${(60 + Math.random() * 12).toFixed(0)}%)`,
          `hsl(${(h - 8).toFixed(0)}, 90%, 46%)`,
        ],
        life: 1, decay: (.0095 + Math.random() * .011) * TW.decay, hist: [],
        // 二段彈：飛到這一幀就各自炸開（±3 幀錯開，一起炸會像一個大圈）
        burst: IS2 ? TW.burst + Math.round(Math.random() * 7) : 0,
      };
    });
    // 金粉：小、閃得快、掉得慢；散在兩層之間
    const GL = Array.from({ length: TW.gl }, () => {
      const a = Math.random() * Math.PI * 2;
      const spd = R0 * (0.35 + Math.random() * 0.75);
      return {
        x: ox, y: oy, vx: Math.cos(a) * spd, vy: Math.sin(a) * spd,
        d: Math.round(Math.random() * 10),
        col: `hsl(${(HUES[Math.random() < .5 ? 0 : 1] + (Math.random() - .5) * 30).toFixed(0)}, 90%, 78%)`,
        life: 1, decay: .006 + Math.random() * .008,
      };
    });

    const SP0 = _fwSprites(HUES[0]), SP1 = _fwSprites(HUES[1]);
    const FLASH = SP0.flash, GLOWS = [SP0.glow, SP1.glow], FLARES = [SP0.flare, SP1.flare], HOT = _FW_HOT();
    const G = .052 * TW.g, DRAG = TW.drag;
    let frame = 0;
    function loop() {
      ctx.clearRect(0, 0, SIZE, SIZE);
      // 起爆白光（只有第一色有；第二色另外畫一小團內焰，見下）
      if (frame < 10) {
        const k = 1 - frame / 10, r = 32 + frame * 4;
        ctx.globalAlpha = .68 * k;
        ctx.drawImage(FLASH, ox - r, oy - r, r * 2, r * 2);
        ctx.globalAlpha = 1;
      }
      ctx.globalCompositeOperation = "lighter";
      // 衝擊波細環：起爆那 9 幀往外擴一圈（一次 stroke，成本可忽略）
      if (frame < 9) {
        const k = 1 - frame / 9;
        ctx.beginPath();
        ctx.arc(ox, oy, 12 + frame * 10, 0, Math.PI * 2);
        ctx.strokeStyle = `hsla(${hue}, 100%, 86%, ${(.42 * k * k).toFixed(3)})`;
        ctx.lineWidth = 2.4 * k + .4;
        ctx.stroke();
      }
      /* 第二色只在自己起爆那幾幀畫一小團內焰 ——
         ⚠ 不可以給它第二次「整張白光」：那就是使用者說的「像點兩下」。 */
      const f2 = frame - _FW_LAG;
      if (f2 >= 0 && f2 < 6) {
        const k2 = 1 - f2 / 6, r2 = 18 + f2 * 5;
        ctx.globalAlpha = .55 * k2;
        ctx.drawImage(GLOWS[1], ox - r2, oy - r2, r2 * 2, r2 * 2);
        ctx.globalAlpha = 1;
      }
      ctx.lineCap = "round";
      let alive = false;
      const pending = [];
      for (const p of P) {
        if (p.life <= 0) continue;
        // ⚠ 還沒輪到它起爆：一定要算「還活著」，否則第二色還沒出場整發就被收掉了
        if (frame < p.d) { alive = true; continue; }
        p.hist.push(p.x, p.y); if (p.hist.length > TW.hist) p.hist.splice(0, 2);
        p.x += p.vx; p.y += p.vy;
        p.vy += G; p.vx *= DRAG; p.vy *= DRAG;
        p.life -= p.decay;
        if (p.life <= 0) continue;
        alive = true;
        /* ⚠ 白熱期要**短**：訂 .72 時實測前 320ms 整團是白的（看起來像閃光燈不是煙火）。
           真的星火只有剛炸開那一瞬間是白熱 → .88 ≈ 前 8 幀（約 130ms）。 */
        /* 二段彈的第二次爆炸：彗星在 burst 那一幀換成一朵小煙火。
           ⚠ 新粒子要先收在 pending、迴圈結束再併進 P —— 直接 push 會在**同一幀**就被走訪到
             （for...of 會看到新加的元素），小煙火會少畫一格、起點也偏掉。 */
        if (p.burst && frame >= p.burst) {
          p.life = 0;
          const NB = TW.kids;
          for (let q = 0; q < NB; q++) {
            const aa = (q / NB) * Math.PI * 2 + Math.random() * .4;
            const ss = .9 + Math.random() * 1.5;
            const hh = HUES[1] + (Math.random() - .5) * 20;
            pending.push({
              x: p.x, y: p.y,
              vx: p.vx * .22 + Math.cos(aa) * ss, vy: p.vy * .22 + Math.sin(aa) * ss,
              k: 1, d: 0, burst: 0, hist: [],
              cols: [`hsl(${hh.toFixed(0)},92%,88%)`, `hsl(${hh.toFixed(0)},96%,64%)`, `hsl(${(hh-8).toFixed(0)},90%,46%)`],
              life: 1, decay: .016 + Math.random() * .014,
            });
          }
          continue;
        }
        const hot = p.life > .88, cool = p.life < .3;
        const col = p.cols[hot ? 0 : (cool ? 2 : 1)];
        const tw = cool ? (.35 + Math.random() * .65) : 1;           // 末段閃爍
        // 漸細尾跡：越舊的那一段越細越淡（整條同寬會看起來像畫線）
        const hn = p.hist.length;
        if (hn >= 6) {
          for (let seg = 0; seg < 2; seg++) {
            const i0 = seg === 0 ? 0 : Math.floor(hn / 4) * 2;
            const i1 = seg === 0 ? Math.floor(hn / 4) * 2 : hn;
            if (i1 - i0 < 4) continue;
            ctx.beginPath(); ctx.moveTo(p.hist[i0], p.hist[i0 + 1]);
            for (let i = i0 + 2; i < i1; i += 2) ctx.lineTo(p.hist[i], p.hist[i + 1]);
            if (seg === 1) ctx.lineTo(p.x, p.y);
            ctx.strokeStyle = col;
            ctx.globalAlpha = p.life * (seg === 0 ? .12 : .34) * tw;
            ctx.lineWidth = seg === 0 ? .9 : 1.8;
            ctx.stroke();
          }
        }
        const _a = Math.min(1, p.life * 1.25) * tw;
        // 外暈：大一圈、很淡 —— 兩層疊起來才有「亮到暈開」的感覺（單層只會是一個點）
        ctx.globalAlpha = _a * .3;
        const br = (hot ? 9.5 : 8) * 2.1;
        ctx.drawImage(GLOWS[p.k], p.x - br, p.y - br, br * 2, br * 2);
        ctx.globalAlpha = _a * (hot ? 1 : .88);                      // 光暈（白熱期用白色那張）
        const gs = hot ? HOT : GLOWS[p.k], gr = hot ? 9.5 : 8;
        ctx.drawImage(gs, p.x - gr, p.y - gr, gr * 2, gr * 2);
        // 星芒：只給還亮著的那些（life > .5），兩個角度交錯，隨壽命縮短
        if (p.life > .5) {
          const fr = 13 + p.life * 9;
          ctx.globalAlpha = _a * .5;
          ctx.drawImage(FLARES[p.k], p.x - fr, p.y - fr, fr * 2, fr * 2);
        }
        /* 末段爆閃：快熄時有機率迸出兩顆小火星 —— 真實煙火的「劈啪」就是這個。
           ⚠ 要有總量上限（沒有的話會一路連鎖生下去，幀數跟著崩）。 */
        if (cool && GL.length < TW.gl + 24 + TW.n && Math.random() < .035) {
          for (let q = 0; q < 2; q++) {
            const aa = Math.random() * Math.PI * 2, ss = .5 + Math.random() * 1.1;
            GL.push({ x: p.x, y: p.y, vx: Math.cos(aa) * ss, vy: Math.sin(aa) * ss,
                      d: 0, col: p.cols[1], life: .8, decay: .022 + Math.random() * .02 });
          }
        }
        ctx.globalAlpha = _a;                                        // 中心亮點
        ctx.beginPath(); ctx.arc(p.x, p.y, (hot ? 1.9 : 1.4) * TW.dot, 0, Math.PI * 2);
        ctx.fillStyle = col; ctx.fill();
      }
      if (pending.length) { P.push(...pending); alive = true; }
      // 金粉：1px 的小星，閃爍快、掉得慢
      for (const g of GL) {
        if (g.life <= 0) continue;
        if (frame < g.d) { alive = true; continue; }
        g.x += g.vx; g.y += g.vy;
        g.vy += G * 1.15; g.vx *= .968; g.vy *= .968;
        g.life -= g.decay;
        if (g.life <= 0) continue;
        alive = true;
        ctx.globalAlpha = g.life * (.25 + Math.random() * .75);
        ctx.fillStyle = g.col;
        ctx.fillRect(g.x - .9, g.y - .9, 1.8, 1.8);
      }
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
      frame++;
      if (alive) requestAnimationFrame(loop); else cvs._fxDone();
    }
    loop();
  }

  /* ★★ 2026-09-26 使用者：「晚上有才是煙火感 白天做成噴射煙霧」。
     煙火在白天的天空下不成立（亮背景吃掉發光、加法混色也看不出來）→ 白天改成一股噴出來的煙。
     ★ 煙看起來像煙的關鍵跟煙火**完全相反**，四件事：
       ①**先衝後散**：初速大(2.0~5.4)但阻力很強(0.88) → 十幾幀內就幾乎停住＝「噴射」的爆發感
       ②**邊膨脹邊變淡**：每團從 r≈7 長到 30~48，透明度隨之衰減（煙的體積是守恆的稀釋）
       ③**往上飄**：停住之後每幀 vy −0.035，尾巴自己往上捲
       ④**正常混色**（`source-over`）不可用 `lighter`：加法混色會把重疊處疊成白光＝變成爆炸不是煙
     ★ 開頭 12 幀另外畫幾道細長的「氣流」線條，那是「噴」出來的那一瞬間；沒有它只是一團霧。
     ⚠ 貼圖是**兩段色**（白心 → 灰身）：使用者的主圖背景可能是深色也可能是淺色（有人設成白/紅），
       純白的煙在淺色背景上完全看不見。兩段色在兩種背景下都有東西看得到。
     ⚠ 同煙火：一張烤好的貼圖 + drawImage，不用 shadowBlur（那個實測 p90 40.3ms）。 */
  function spawnSmoke(cx, cy) {
    const SIZE = 300, N = 24;
    const cvs = makeCanvas(cx, cy, SIZE); if (!cvs) return;
    const ctx = cvs.getContext("2d");
    const ox = SIZE / 2, oy = SIZE / 2;

    // 烤一張煙團貼圖（64px，白心→灰身→透明）
    const PUFF = document.createElement("canvas");
    PUFF.width = PUFF.height = 64;
    (() => {
      const g2 = PUFF.getContext("2d");
      const rg = g2.createRadialGradient(32, 32, 0, 32, 32, 32);
      rg.addColorStop(0,   "rgba(255,255,255,.95)");
      rg.addColorStop(.30, "rgba(240,244,250,.62)");
      rg.addColorStop(.62, "rgba(190,200,214,.30)");
      rg.addColorStop(.86, "rgba(150,162,178,.12)");
      rg.addColorStop(1,   "rgba(140,152,168,0)");
      g2.fillStyle = rg; g2.fillRect(0, 0, 64, 64);
    })();

    const P = Array.from({ length: N }, () => {
      const a = Math.random() * Math.PI * 2;
      const spd = 1.4 + Math.random() * 4.0;           // 速度散開＝有的衝到外圈、有的留在核心
      return {
        x: ox, y: oy, vx: Math.cos(a) * spd, vy: Math.sin(a) * spd,
        r0: 5 + Math.random() * 5, grow: 30 + Math.random() * 26,
        sq: .78 + Math.random() * .5,                  // 壓扁比例，打破「每團都是正圓」
        op: .34 + Math.random() * .22,                 // 每團濃淡不同，疊起來才有體積
        life: 1, decay: .013 + Math.random() * .011,
      };
    });
    // 噴射的氣流線（只活前 16 幀）：從中心往外竄、越竄越細
    const JET = Array.from({ length: 9 }, () => ({
      a: Math.random() * Math.PI * 2, spd: 5.5 + Math.random() * 4.5,
      len: 18 + Math.random() * 20, w: 1.6 + Math.random() * 2.2,
    }));
    const DRAG = .88, RISE = .035;
    let frame = 0;
    function loop() {
      ctx.clearRect(0, 0, SIZE, SIZE);
      // 噴出瞬間：中心一小團亮白 + 幾道氣流
      if (frame < 16) {
        const k = 1 - frame / 16, r = 20 + frame * 3;
        // 同煙火：噴出瞬間的亮白也走烤好的貼圖，不要每幀現做漸層填滿整張畫布
        ctx.globalAlpha = .7 * k;
        ctx.drawImage(PUFF, ox - r, oy - r, r * 2, r * 2);
        ctx.globalAlpha = 1;
        ctx.lineCap = "round";
        for (const j of JET) {
          const d = 6 + frame * j.spd;                 // 線頭往外竄，尾巴留在後面＝拉出速度感
          const ca = Math.cos(j.a), sa = Math.sin(j.a);
          ctx.beginPath();
          ctx.moveTo(ox + ca * d, oy + sa * d);
          ctx.lineTo(ox + ca * (d + j.len), oy + sa * (d + j.len));
          ctx.strokeStyle = `rgba(248,251,255,${(.55 * k * k).toFixed(3)})`;
          ctx.lineWidth = j.w * k + .4; ctx.stroke();
        }
      }
      let alive = false;
      for (const p of P) {
        if (p.life <= 0) continue;
        p.x += p.vx; p.y += p.vy;
        p.vx *= DRAG; p.vy = p.vy * DRAG - RISE;      // 停下來之後自己往上飄
        p.life -= p.decay;
        if (p.life <= 0) continue;
        alive = true;
        const prog = 1 - p.life;                       // 0 → 1
        const r = p.r0 + prog * p.grow;
        const fadeIn = Math.min(1, prog / .1);         // 噴出來的瞬間不要憑空出現
        ctx.globalAlpha = fadeIn * Math.pow(p.life, 1.25) * p.op;
        ctx.drawImage(PUFF, p.x - r, p.y - r * p.sq, r * 2, r * 2 * p.sq);
      }
      ctx.globalAlpha = 1;
      frame++;
      if (alive) requestAnimationFrame(loop); else cvs._fxDone();
    }
    loop();
  }

  /* 白天噴射煙霧、夜晚煙火。
     ⚠ 日夜的權威來源是 weather.js 的 `window._wxIsDay()`（後端 `is_day`，2026-09-26 才修好
       那個「0 被當成沒給值」的 bug）。weather.js 是**動態載入**的，使用者點得比它載入還早時
       退回本機時鐘（6~18 點算白天）——那是唯一不依賴任何模組的判準。 */
  function _isDaytime() {
    try {
      const f = window._wxIsDay;
      if (typeof f === "function") { const v = f(); if (v != null) return !!v; }
    } catch (e) {}
    const h = new Date().getHours();
    return h >= 6 && h < 18;
  }
  function spawnDefault(cx, cy) {
    if (_isDaytime()) spawnSmoke(cx, cy); else spawnFirework(cx, cy);
  }

  document.addEventListener("click", e => {
    const now = Date.now();
    if (now - _lastClick < 80) return;
    _lastClick = now;
    /* ★ 2026-08-11 點在「控制項」上不放特效（使用者：點天氣鈕也會出現圓形特效）。
       這個點擊特效是給圖表/空白處用的小驚喜；落在按鈕、輸入框、圖例、行情列上時
       只會蓋住 UI、看起來像 bug。→ 只在非互動元素上觸發。
       ⚠ 與 btn-ripple-wave 是**兩套不同機制**：那個是插一個 <span> 進按鈕（已全域關閉），
         這個是在點擊座標灑粒子。使用者連續回報「還是有」正是因為我只修了前者。 */
    if (e.target && e.target.closest &&
        e.target.closest("button,a,input,select,textarea,label,.tf-btn,.leg-item," +
                         ".tk-row,.tk-seg-btn,.tk-mkt-btn,.ind-sp-row,.m-tab,.topbar,.ticker-panel,#trdDock"))
      return;
    const cx = e.clientX, cy = e.clientY;
    const wt = window._getWeatherType ? window._getWeatherType() : null;
    if (wt === "off") return;  // 「無」模式：跳過點擊特效
    if      (wt === "leaves")                 spawnLeaves(cx, cy);
    else if (wt === "rain" || wt === "storm") spawnRain(cx, cy);
    else if (wt === "snow")                   spawnSnow(cx, cy);
    else if (wt === "spring")                 spawnPetals(cx, cy);
    else if (wt === "thunder")                spawnLightning(cx, cy);
    else if (wt === "mahjong")                spawnDice(cx, cy);
    else                                      spawnDefault(cx, cy);
  });
})();

/* ── 右下角橘子熊偷看 ── */
(function initPeekBear() {
  const bear   = document.getElementById("peekBear");
  const bubble = document.getElementById("bearBubble");
  if (!bear) return;

  window._bearCurrentState = 'hidden';
  window._syncWeatherCard = function(state) {
    window._bearCurrentState = state;
    const el = document.getElementById('_wxCard');
    if (!el) return;
    // 動 transform 不動 bottom(毛玻璃卡每幀重排+重算模糊會頓)；與 weather.js 建卡時的檔位一致
    const out = (state === 'full');
    // 收回跟熊同步「立刻」：出來保留回彈(0.45s)，收回改短促 0.2s（見 style.css .peek-bear.retracting）
    el.style.transitionTimingFunction = out ? 'cubic-bezier(0.34,1.56,0.64,1)' : 'cubic-bezier(0.4,0,0.6,1)';
    el.style.transitionDuration = out ? '0.45s' : '0.2s';
    el.style.transform = out ? 'translateY(0)' : 'translateY(305px)';
  };

  const LINES = [
    "我設了停損。它跌到停損前一點點，我說快反彈了，手動取消。它沒有反彈。這不叫運氣差，這叫親手拔掉救生圈。",
    "回測顯示這個策略勝率 78%。實盤我遇到的全是那 22%。我懷疑回測認識我。",
    "別人說順勢操作。我很順勢——漲的時候買，跌的時候也買，叫加倉。這個勢就是一直往下。",
    "我跟自己說這次只看不買。看了五分鐘，買了。我現在把看的時間縮短到兩分鐘，效率提升 60%。",
    "比特幣跌了 30%，我說抄底。又跌 30%，我說再抄底。再跌 20%，我說⋯⋯我需要重新定義底在哪裡。",
    "我做了詳細的進場計畫：目標、停損、倉位。進場後五分鐘，計畫完全作廢。我繼續持有，理由是已經進去了。",
    "有人說不要把雞蛋放在同一個籃子。我放了十個籃子，結果整個市場一起跌，十個籃子同時掉了。這不叫分散，這叫同步沉沒。",
    "我媽問我最近在幹嘛。我說在投資。她說投資什麼。我說加密貨幣。她安靜了一下。我以為她理解了。她是在替我禱告。",
    "技術分析說這裡是支撐，我買了。它跌破了。技術分析說那裡才是真正的支撐，我又買了。它又跌破了。技術分析的支撐，是會移動的。",
    "我問朋友這個幣怎麼看。他說強烈看多。我買了，跌了。我去問他，他說他沒買。給建議的人是不買的，這是市場的基本規律。",
    "消息說某幣要大漲，我追進去了。消息出來的那一刻，它開始跌。我後來才知道，消息出來，就是莊家要出貨的時候。",
    "我的停利設在 20%。漲到 18% 的時候我說再等一下。漲到 22% 我說再等一下。現在回到 5%，我說⋯⋯我說我是長期投資者。",
    "我說這次要理性操作，不帶情緒。結果帳戶一虧，理性就不見了。情緒倒是非常準時出現，而且帶了它的朋友：衝動。",
    "看對了方向，但倉位只開 10%。看錯了方向，倉位開了 80%。這不是能力的問題，這是我對自己信心分配的問題。",
    "空手的時候，每一根都是機會。有倉的時候，每一根都是威脅。市場沒有變，是我的視角在切換。",
    "我說要早點睡。設了十一點的提醒。提醒響了，我拿起手機關掉，然後繼續滑。提醒的功能，是讓我更有效率地忽略它。",
    "我列了今天的待辦清單，第一條是「列清單」。這樣不管發生什麼，我今天至少完成了一件事。",
    "我買了一本筆記本說要記錄靈感。現在裡面寫了三行，前兩行在測試筆有沒有水。靈感還沒來，但筆是好的。",
    "我說要少看手機，下載了一個追蹤使用時間的 app。那個 app 通知我今天已經看了四小時。我點開通知，又多看了十分鐘。這個 app 讓我使用更多手機。",
    "人家說要走出舒適圈。我走出去了，外面不舒服。我回來了。舒適圈的意義，就是讓你知道外面有多難待。",
  ];
  /* Fisher-Yates shuffle, reshuffles when exhausted */
  function _hrZh(h) {   // 24h → 口語時段（凌晨/上午/下午/晚上 X 點）
    const ap = h < 6 ? "凌晨" : h < 12 ? "上午" : h < 18 ? "下午" : "晚上";
    const h12 = (h % 12 === 0) ? 12 : h % 12;
    return `${ap} ${h12} 點`;
  }
  // 外面熱/冷一句（體感優先，退回實際溫度/今日高溫）。給天氣報告收尾用。
  function _tempLine() {
    const f = (typeof window._getForecast === "function") ? window._getForecast() : null;
    if (!f) return null;
    const t = f.today || {}, now = f.now || {};
    const useFeels = (now.feels != null);
    const ft = useFeels ? now.feels : (now.temp != null ? now.temp : t.tmax);
    const tw = useFeels ? "體感 " : "";
    if (ft == null) return null;
    if (ft >= 35) return `🥵 外面超熱（${tw}${ft}°），多喝水`;
    if (ft >= 31) return `🥵 外面很熱（${tw}${ft}°）`;
    if (ft <= 10) return `🥶 外面很冷（${ft}°），多穿點`;
    if (ft <= 16) return `🧥 外面有點涼（${ft}°）`;
    return `😊 外面溫度舒適（${ft}°）`;
  }
  // 天氣預報（精簡版：只講「何時下雨」+「外面熱/冷」）。無附近雨區資料時的退路。
  function _forecastLine() {
    const f = (typeof window._getForecast === "function") ? window._getForecast() : null;
    if (!f || !f.today) return null;
    const t = f.today, r = f.rain || {};
    const lines = [];
    if (r.raining_now) lines.push("☔ 現在正在下雨，記得帶傘");
    else if (r.from_hour != null) lines.push(`☔ ${_hrZh(r.from_hour)}左右會下雨${r.from_pop != null ? `（${r.from_pop}%）` : ""}，記得帶傘`);
    else if (f.wx_src && t.pop != null && t.pop >= 50) lines.push(`☔ 今天可能會下雨（${t.pop}%），帶把傘`);
    else lines.push("☀️ 今天大致不會下雨");
    const tl = _tempLine();
    if (tl) lines.push(tl);
    return lines.join("\n");
  }
  // 完整天氣報告（小啊每 10 分鐘自動播 + 「天氣如何？」按鈕）：附近雨區「多情況」詳細 + 外面熱冷。
  function _weatherReport() {
    let nb = null;
    try { nb = (typeof window._getNearbyDetail === "function") ? window._getNearbyDetail() : null; } catch (e) {}
    if (!nb) return _forecastLine();                 // 還沒定位/附近資料 → 退回精簡預報
    const tl = _tempLine();
    return tl ? (nb + "\n" + tl) : nb;
  }

  let _shuffled = [], _shufflePos = 0;
  function _nextLine() {   // 互動(滑過/點)＝純笑話；天氣預報走每 10 分鐘自動定時(見 scheduleVisit)
    if (_shufflePos >= _shuffled.length) {
      _shuffled = [...LINES];
      for (let i = _shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [_shuffled[i], _shuffled[j]] = [_shuffled[j], _shuffled[i]];
      }
      _shufflePos = 0;
    }
    return _shuffled[_shufflePos++];
  }

  let _bubbleTimer = null;
  let _bearHover = false;
  let _bearTransTimer = null;

  function showBubble() {
    if (!bubble) return;
    bubble.textContent = _nextLine();
    bubble.classList.add("visible");
    clearTimeout(_bubbleTimer);
    _bubbleTimer = setTimeout(() => { if (!_bearHover) bubble.classList.remove("visible"); }, 5500);
  }

  setTimeout(() => { bear.classList.add("peeking"); window._syncWeatherCard('peeking'); }, 2800);

  /* ★ 2026-09-11 使用者：「有時候跳出來有點打擾看盤，改成我滑鼠移到那再跳出來」
       ＋「滑鼠移開就立刻收回」。
     → 整隻跳出來**只由滑鼠觸發**（原本還有每 10 分鐘自動跳出來播天氣，已移除，見下方）。
     ⚠ 天氣播報沒有被丟掉：那條自動跳出來的唯一用途就是每 10 分鐘講一次天氣 ——
       改成「距上次講超過 10 分鐘，這次滑過去就講天氣、否則講笑話」。
       資訊照樣是每 10 分鐘一輪，只是等你去看它，而不是它來打斷你。 */
  const _WX_EVERY = 600000;        // 天氣輪替間隔，與原本每 10 分鐘自動播報一致
  let _lastWxBubbleTs = 0;

  function _onEnter() {
    _bearHover = true;
    bear.classList.remove('retracting');
    bear.classList.add('peek-full');
    clearTimeout(_bubbleTimer);
    if (!bubble?.classList.contains("visible")) {
      // ⚠ 只有「真的講得出天氣」才算用掉這一輪：剛開站還沒定位時 _weatherReport() 是空的，
      //   若照樣把時間戳推掉，使用者這 10 分鐘內就再也等不到天氣了（靜靜地少一次資訊）。
      const wx = (Date.now() - _lastWxBubbleTs >= _WX_EVERY) ? _weatherReport() : null;
      if (wx) { _lastWxBubbleTs = Date.now(); showForecastBubble(); }
      else showBubble();
    }
    window._syncWeatherCard('full');
  }
  function _onLeave(e) {
    /* ⚠ 這裡原本有一道 `if (_bearTransitioning) return;`（跳出來的 520ms 內忽略 mouseleave）——
       那正是「移開了卻不收回」的來源：滑開得夠快就整個被吃掉，熊留在外面。
       它當初是為了擋一種假 mouseleave：熊往上滑 85px 時，貼在畫面最底那 5px 的游標
       會落到元素外。→ 改成用 `.peek-bear::before` 把命中區往下補一段（見 style.css），
       幾何上不再有那個縫，就不需要用「忽略事件」去掩蓋它了。 */
    const to = e.relatedTarget;
    if (bear.contains(to) || bubble?.contains(to)) return;
    _bearHover = false;
    bear.classList.add('retracting');            // 收回用短促曲線，不走跳出來那條回彈
    bear.classList.remove('peek-full');
    clearTimeout(_bubbleTimer);
    bubble?.classList.remove("visible");         // 泡泡也立刻收（原本還要再留 3 秒）
    window._syncWeatherCard('peeking');
    clearTimeout(_bearTransTimer);
    _bearTransTimer = setTimeout(() => bear.classList.remove('retracting'), 300);
  }

  bear.addEventListener("mouseenter", _onEnter);
  bear.addEventListener("mouseleave", _onLeave);
  bubble?.addEventListener("mouseenter", _onEnter);
  bubble?.addEventListener("mouseleave", _onLeave);

  bear.addEventListener("click", e => {
    e.stopPropagation();
    bear.classList.remove("wave");
    void bear.offsetWidth;
    bear.classList.add("wave");
    showBubble();
  });

  /* 顯示天氣預報氣泡（沒預報資料時退回笑話，避免空白） */
  function showForecastBubble() {
    if (!bubble) return;
    bubble.textContent = _weatherReport() || _nextLine();   // 附近雨區多情況詳細 + 外面熱冷
    bubble.classList.add("visible");
    clearTimeout(_bubbleTimer);
    _bubbleTimer = setTimeout(() => { if (!_bearHover) bubble.classList.remove("visible"); }, 8500);
  }
  window._bearWeatherReport = _weatherReport;   // 手機版小啊(xiaoa.js)共用同一份完整報告

  /* 小啊頭上「天氣如何？」按鈕：先講現有(至多5分前)、再抓最新回來更新一次 */
  let _bearWxPending = false;
  document.getElementById("bearWxBtn")?.addEventListener("click", e => {
    e.stopPropagation();
    bear.classList.remove("wave"); void bear.offsetWidth; bear.classList.add("wave");
    showForecastBubble();
    _lastWxBubbleTs = Date.now();   // 剛親自問過天氣 → 下次滑過去先講笑話，別重複播同一份
    _bearWxPending = true;
    if (typeof window._wxRefreshNow === "function") window._wxRefreshNow();
  });
  window.addEventListener("wx:updated", () => {
    if (_bearWxPending) { _bearWxPending = false; showForecastBubble(); }   // 最新資料到 → 重講
  });
  /* ⛔ 原本這裡有「對齊時鐘整 10 分刻度自動冒出全身播天氣」(_doForecastVisit / scheduleVisit)。
     2026-09-11 移除：使用者看盤時被它彈出來打斷（整隻熊 + 毛玻璃天氣卡一起滑上來、停 8 秒）。
     它唯一的功能是「每 10 分鐘講一次天氣」，已改由 _onEnter 承接（見上方 _WX_EVERY）：
     滑過去時若距上次超過 10 分鐘就講天氣，資訊一樣不漏，但由使用者決定什麼時候看。 */

  // 暴露給手機版「設定頁小啊」(xiaoa.js)共用同一批笑話與天氣預報 → 手機/桌面一致
  window._bearNextLine = _nextLine;
  window._bearForecastLine = _forecastLine;
})();

/* ── 合約行情鍵盤快捷鍵（↓/↑ 切換標的） ── */
(function initTickerKeyNav() {
  document.addEventListener("keydown", e => {
    const tag = document.activeElement?.tagName?.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    if (document.activeElement?.isContentEditable) return;
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== " ") return;

    const container = document.getElementById("tickerList");
    if (!container) return;
    let items = [...container.querySelectorAll(".ticker-item")];
    if (!items.length) return;

    e.preventDefault();
    // 凍結 ticker 清單排序 3 秒，避免每 2 秒重排讓 ↑↓ 跳到不預期的位置
    if (typeof window._markKbNav === "function") window._markKbNav();

    /* 空白鍵：直接跳到列表第一個標的 */
    if (e.key === " ") {
      const first = items[0];
      items.forEach(x => x.classList.remove("tk-active"));
      first.classList.add("tk-active");
      first.scrollIntoView({ block: "nearest", behavior: "smooth" });
      if (first.dataset.display) {
        document.getElementById("symbolInput").value = first.dataset.display;
        const exchEl = document.getElementById("exchangeSelect");
        if (exchEl && !["pionex", "binance"].includes(exchEl.value)) exchEl.value = "pionex";
        loadData(false);
      } else {
        first.click();   // 自選列等無 data-display 的 row → 走 row 自己的 click（會處理市場切換）
      }
      return;
    }

    const activeIdx = items.findIndex(el => el.classList.contains("tk-active"));
    // ⚠ 不繞回：原本 (activeIdx+1) % items.length 到底就跳回第 0 個；配合報價列漸進渲染(只渲染前 N 列)，
    //   會在第 N 列就「突然跳回第一個」。改為：到底時若還有更多(cap 未載完)→ 載一批再往下；否則停住不繞。
    if (e.key === "ArrowDown" && activeIdx >= 0 && activeIdx >= items.length - 1) {
      if (window._tkGrowMore && window._tkGrowMore()) {
        items = [...container.querySelectorAll(".ticker-item")];   // 載入後重取
      } else {
        return;   // 已到全清單底 → 停住，不繞回第一個
      }
    }
    const nextIdx = e.key === "ArrowDown"
      ? (activeIdx < 0 ? 0 : Math.min(activeIdx + 1, items.length - 1))
      : (activeIdx <= 0 ? 0 : activeIdx - 1);   // 到頂停在第一個，不繞到最後
    const next = items[nextIdx];
    if (!next) return;

    items.forEach(x => x.classList.remove("tk-active"));
    next.classList.add("tk-active");
    next.scrollIntoView({ block: "nearest", behavior: "smooth" });

    /* 載入標的 */
    if (next.dataset.display) {
      document.getElementById("symbolInput").value = next.dataset.display;
      const exchEl = document.getElementById("exchangeSelect");
      if (exchEl && !["pionex", "binance"].includes(exchEl.value)) exchEl.value = "pionex";
      loadData(false);
    } else {
      next.click();   // 自選列等無 data-display 的 row → 走 row 自己的 click
    }
  });
})();

/* ══════════════════════════════════════════
   按鈕漣漪效果
══════════════════════════════════════════ */
(function initButtonRipple() {
  /* ★ 2026-08-11 全域關閉按鈕漣漪（使用者要求）。
     歷程：原本就已經在「手機/觸控」「極簡模式」「交易面板」關掉（矮寬按鈕上漣漪會外溢成半圓）；
     這次使用者又連續指出三處不要 —— 橘子熊牆紙鈕、行情面板的合約/台股分頁與排序鈕、
     上方的快捷繪圖工具。與其一個一個排除（打地鼠），直接整個關掉。
     ⚠ 要復原只要把下面這行 return 拿掉：底下的實作、CSS(.btn-ripple-wave) 與各處排除條件都保留著，
       不是刪掉重寫。 */
  const RIPPLE_ON = false;
  const TARGETS = "button,.tf-btn,.rp-btn,.dt-btn,.tk-seg-btn,.sym-tab";
  document.addEventListener("pointerdown", e => {
    if (!RIPPLE_ON) return;
    // 手機/觸控：整個關掉漣漪（矮寬按鈕上會外溢成半圓放大動畫，使用者不要）
    if (window.matchMedia && (matchMedia("(max-width: 768px)").matches || matchMedia("(pointer: coarse)").matches)) return;
    const btn = e.target.closest(TARGETS);
    if (!btn) return;
    // 交易面板（桌面嵌入合約行情底部 / 手機交易分頁）：矮寬按鈕漣漪會外溢成半圓動畫，使用者不要 → 整面板關閉
    if (btn.closest("#tradePopup")) return;
    // 橘子熊牆紙鈕（時框列上那顆）：漣漪在這顆小方鈕上會脹成一個圓圈蓋住熊
    //   → 使用者：「點熊圖示會出現圓形特效，不要那個」。
    //   ⚠ 我一開始以為是焦點環／點擊高亮／按壓底色，改了 CSS 全都沒用；
    //     實際在頁面上量才發現是這裡插進去的 <span class="btn-ripple-wave">（DOM 3685→3686）。
    //     教訓：這種「看得到的東西」要直接量 DOM 差異，不要靠猜 CSS。
    if (btn.id === "bearWallToggleBtn") return;
    // 行情面板（合約／台股分頁、漲跌量♥🎯 排序鈕…）：使用者「點合約台股也會出現」，
    //   同交易面板的處理 —— 整面板關閉漣漪。這些都是矮扁小鈕，漣漪脹起來會蓋住文字。
    if (btn.closest(".ticker-panel")) return;
    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 2.2;
    const x    = e.clientX - rect.left  - size / 2;
    const y    = e.clientY - rect.top   - size / 2;
    const wave = document.createElement("span");
    wave.className = "btn-ripple-wave";
    wave.style.cssText = `width:${size}px;height:${size}px;left:${x}px;top:${y}px`;
    btn.appendChild(wave);
    // animationend 正常移除；但若按鈕所在面板隨即 display:none（動畫暫停、animationend 不觸發）
    // 漣漪會卡住、下次開面板又出現 → 用 setTimeout 保險移除（涵蓋動畫時長）
    wave.addEventListener("animationend", () => wave.remove(), { once: true });
    setTimeout(() => wave.remove(), 900);
  });
})();

/* ══════════════════════════════════════════
   音效引擎 (Web Audio API)
══════════════════════════════════════════ */
const SFX = (() => {
  let _ctx = null, _master = null;

  function _getCtx() {
    if (!_ctx) {
      _ctx    = new (window.AudioContext || window.webkitAudioContext)();
      _master = _ctx.createGain();
      _master.gain.value = 0.22;
      _master.connect(_ctx.destination);
    }
    if (_ctx.state === "suspended") _ctx.resume();
    return _ctx;
  }

  function _tone(freq, type, vol, dur, delay = 0, detune = 0) {
    const ctx  = _getCtx();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(_master);
    osc.type = type;
    osc.frequency.value = freq;
    osc.detune.value    = detune;
    const t = ctx.currentTime + delay;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(vol, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.start(t);
    osc.stop(t + dur + 0.01);
  }

  return {
    /* 按鈕輕點 */
    click()   { _tone(1100, "sine",   0.18, 0.055); },
    /* 載入資料 */
    load()    {
      [523.3, 659.3, 784.0].forEach((f, i) => _tone(f, "sine", 0.14, 0.14, i * 0.09));
    },
    /* 載入成功 */
    success() {
      [523.3, 659.3, 784.0, 1046.5].forEach((f, i) => _tone(f, "sine", 0.13, 0.18, i * 0.07));
    },
    /* 載入失敗 */
    error()   {
      [400, 320, 240].forEach((f, i) => _tone(f, "square", 0.1, 0.12, i * 0.10));
    },
    /* 重播步進 tick */
    tick()    { _tone(880,  "sine",   0.10, 0.04); },
    /* 橘子熊波動音 */
    boop()    { _tone(660,  "sine",   0.15, 0.08); _tone(880, "sine", 0.10, 0.06, 0.06); },
    /* 切換音效 */
    switch_()  { _tone(740,  "triangle", 0.12, 0.08); },
    /* 雷聲：高頻爆裂 + 低頻轟鳴 */
    thunder() {
      const ctx = _getCtx();
      const sr = ctx.sampleRate;
      /* crack */
      const cBuf = ctx.createBuffer(1, Math.floor(sr*.07), sr);
      const cDat = cBuf.getChannelData(0);
      for (let i=0;i<cDat.length;i++) cDat[i]=(Math.random()*2-1)*(1-i/cDat.length);
      const cSrc=ctx.createBufferSource(); cSrc.buffer=cBuf;
      const hpf=ctx.createBiquadFilter(); hpf.type="highpass"; hpf.frequency.value=1800;
      const cG=ctx.createGain(); const t0=ctx.currentTime;
      cG.gain.setValueAtTime(1.1,t0); cG.gain.exponentialRampToValueAtTime(.001,t0+.09);
      cSrc.connect(hpf); hpf.connect(cG); cG.connect(_master);
      cSrc.start(t0); cSrc.stop(t0+.1);
      /* rumble */
      const delay=.08+Math.random()*.35;
      const rBuf=ctx.createBuffer(1,Math.floor(sr*2.6),sr);
      const rDat=rBuf.getChannelData(0);
      for (let i=0;i<rDat.length;i++) rDat[i]=(Math.random()*2-1);
      const rSrc=ctx.createBufferSource(); rSrc.buffer=rBuf;
      const lpf=ctx.createBiquadFilter(); lpf.type="lowpass"; lpf.frequency.value=90;
      const rG=ctx.createGain(); const t1=t0+delay;
      rG.gain.setValueAtTime(0,t1); rG.gain.linearRampToValueAtTime(.55,t1+.07);
      rG.gain.exponentialRampToValueAtTime(.001,t1+2.3);
      rSrc.connect(lpf); lpf.connect(rG); rG.connect(_master);
      rSrc.start(t1); rSrc.stop(t1+2.5);
    },
  };
})();

/* 把音效掛上常用按鈕 */
(function wireSFX() {
  /* TF / 圖表類型 切換 */
  document.querySelectorAll(".tf-btn").forEach(b =>
    b.addEventListener("click", () => SFX.switch_(), { capture: true })
  );
  /* 重播控制欄 step tick */
  ["replayStepB","replayStepF"].forEach(id =>
    document.getElementById(id)?.addEventListener("click", () => SFX.tick(), { capture: true })
  );
  /* 橘子熊點擊音 */
  document.getElementById("peekBear")?.addEventListener("click", () => SFX.boop(), { capture: true });

  /* 攔截 loadData 完成後的音效（monkey-patch fetch） */
  const _origFetch = window.fetch;
  let _loadPending = false;
  window.fetch = async function(...args) {
    const res = await _origFetch.apply(this, args);
    const url = typeof args[0] === "string" ? args[0] : (args[0]?.url || "");
    if (_loadPending && url.includes("/api/ohlcv")) {
      _loadPending = false;
      if (res.ok) setTimeout(() => SFX.success(), 180);
      else        setTimeout(() => SFX.error(),   180);
    }
    return res;
  };
})();

/* ── FX 面板開關 ── */
(function initFxPanel() {
  const panel = document.getElementById("fxPanel");
  const btn   = document.getElementById("fxToggleBtn");
  if (!panel || !btn) return;
  btn.addEventListener("click", e => {
    e.stopPropagation();
    const willOpen = panel.classList.contains("hidden");
    if (willOpen) window._closeAllFloatPanels?.("fx");
    const open = panel.classList.toggle("hidden");
    btn.classList.toggle("fx-open", !open);
  });
  document.addEventListener("click", e => {
    if (!panel.contains(e.target) && e.target !== btn) {
      panel.classList.add("hidden");
      btn.classList.remove("fx-open");
    }
  });
})();

