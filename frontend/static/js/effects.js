/* ── 點擊特效（依天氣型別：落葉 / 雨滴 / 雪花 / 花瓣 / 預設魔法粒子） ── */
(function initClickSparks() {
  let _lastClick = 0, _activeFx = 0;

  /* ── 建立暫時 Canvas；超過 4 個並行特效時跳過 ── */
  function makeCanvas(cx, cy, size) {
    if (_activeFx >= 4) return null;
    _activeFx++;
    const cvs = document.createElement("canvas");
    cvs.width = size; cvs.height = size;
    cvs.style.cssText = `position:fixed;left:${cx-size/2}px;top:${cy-size/2}px;pointer-events:none;z-index:9999;`;
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

  function spawnDefault(cx, cy) {
    const BIG=6;
    for(let i=0;i<BIG;i++){
      const a=(i/BIG)*Math.PI*2, dist=25+Math.random()*20;
      const w=8+Math.random()*8, h=w*(.35+Math.random()*.55);
      const col=DEF_COLORS[Math.floor(Math.random()*DEF_COLORS.length)];
      const el=spawnEl("spark-big",cx,cy,
        `width:${w}px;height:${h}px;background:${col};`+
        `--sx:${(Math.cos(a)*dist).toFixed(1)}px;--sy:${(Math.sin(a)*dist).toFixed(1)}px;`+
        `animation-delay:${i*20}ms;`);
      setTimeout(()=>el.remove(),1250);
    }
    const DUST=8;
    for(let i=0;i<DUST;i++){
      const a=Math.random()*Math.PI*2, dist=30+Math.random()*30;
      const sz=3+Math.random()*5, delay=40+Math.random()*100;
      const col=DEF_COLORS[Math.floor(Math.random()*DEF_COLORS.length)];
      const el=spawnEl("spark-dust",cx,cy,
        `width:${sz}px;height:${sz}px;background:${col};`+
        `--sx:${(Math.cos(a)*dist).toFixed(1)}px;--sy:${(Math.sin(a)*dist).toFixed(1)}px;`+
        `animation-delay:${delay.toFixed(0)}ms;`);
      setTimeout(()=>el.remove(),1500);
    }
  }

  document.addEventListener("click", e => {
    const now = Date.now();
    if (now - _lastClick < 80) return;
    _lastClick = now;
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
    el.style.bottom = state==='full'?'5px':'-300px';
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
  // 天氣預報台詞（說人話版：在地幽默 + 帶雨具/防午後雷雨建議）。資料來自 weather.js 的 _getForecast()
  function _forecastLine() {
    const f = (typeof window._getForecast === "function") ? window._getForecast() : null;
    if (!f || !f.today) return null;
    const t = f.today, m = f.tomorrow, a = t.afternoon || {};
    const pool = [];
    // 今日午後雷雨（逐小時 13–18 時真的偵測到才講）
    if (a.thunder) pool.push(`今天午後${(a.pop != null && a.pop >= 30) ? `雷雨機率 ${a.pop}%` : "有雷雨機會"}。出門帶把傘、別在外面躲，雷雨來得快、走得也快——跟你的獲利一樣。`);
    else if (a.shower) pool.push(`今天午後${a.pop != null ? `有 ${a.pop}% 機率` : "可能"}下陣雨，雨具塞包包當避險，成本很低。`);
    // 今日整天降雨 / 帶雨具
    if (t.pop != null && t.pop >= 60) pool.push(`今日降雨機率 ${t.pop}%。雨具帶著，淋濕的滋味跟被套牢一樣難受。`);
    else if (t.pop != null && t.pop >= 30) pool.push(`今天有 ${t.pop}% 機率下雨，出門帶傘，淋雨事小、感冒事大。`);
    // 溫度提醒
    if (t.tmax != null && t.tmax >= 33) pool.push(`今天高溫 ${t.tmax}°，熱到融化。多喝水，別像我盯盤盯到脫水。`);
    if (t.tmin != null && t.tmin <= 14) pool.push(`今晚最低 ${t.tmin}°，記得加件外套。保暖跟風控一樣，平常嫌煩、出事才後悔。`);
    // 明日預報
    if (m) {
      if (m.cond && m.cond.includes("雷")) pool.push(`明天${m.tmin}~${m.tmax}°、有雷雨。雨具先備好，預防午後那場。`);
      else if (m.pop != null && m.pop >= 50) pool.push(`明天降雨 ${m.pop}%、${m.tmin}~${m.tmax}°。出門記得帶傘，我負責預報、不負責幫你曬乾。`);
    }
    // ── 當前體感/空品/問候（資料來自 f.now、f.aqi）──
    const now = f.now || {}, aqi = f.aqi || {};
    // 紫外線 / 防曬
    if (t.uv != null && t.uv >= 8) pool.push(`今天紫外線爆表（UV ${t.uv}）。防曬乳記得補，曬傷跟爆倉一樣——當下沒感覺，事後很痛。`);
    else if (t.uv != null && t.uv >= 6) pool.push(`紫外線偏強（UV ${t.uv}），出門擦個防曬、戴頂帽子。`);
    // 體感悶熱（體感明顯高於實際）
    if (now.feels != null && now.temp != null && now.feels - now.temp >= 4 && now.feels >= 32)
      pool.push(`實際 ${now.temp}°、體感卻 ${now.feels}°，濕熱黏 TT。多補水、少在外面久待。`);
    // 濕度悶熱
    if (now.humidity != null && now.humidity >= 80 && (now.temp == null || now.temp >= 26))
      pool.push(`濕度 ${now.humidity}%，悶熱黏膩，出門像走進蒸籠。`);
    // 風大
    if (now.wind != null && now.wind >= 40) pool.push(`風很大（${now.wind} km/h），帽子壓好、輕的東西收好，騎車小心。`);
    else if (now.wind != null && now.wind >= 25) pool.push(`今天風有點大（${now.wind} km/h），出門注意。`);
    // 空氣品質
    if (aqi.us_aqi != null && aqi.us_aqi >= 150) pool.push(`空氣品質差（AQI ${aqi.us_aqi}）。戴口罩、少出門、別做劇烈運動。`);
    else if (aqi.us_aqi != null && aqi.us_aqi >= 100) pool.push(`空氣品質中等偏差（AQI ${aqi.us_aqi}），敏感族群、過敏的人注意一下。`);
    // 適合出門綜合判斷（天氣好、低降雨、空品佳、不極端）
    const _comfy = (t.pop == null || t.pop < 30) && !a.thunder && !a.shower
      && (aqi.us_aqi == null || aqi.us_aqi < 100)
      && (t.tmax == null || t.tmax < 33) && (t.tmin == null || t.tmin > 14)
      && (t.uv == null || t.uv < 8);
    if (_comfy) pool.push(`今天天氣不錯、適合出門走走——但別走進交易所，那裡的天氣永遠是你看不懂的盤整。`);
    // 時段問候（依瀏覽器當地時間）+ 一句今日重點
    const hr = new Date().getHours();
    const _focus = (t.pop != null && t.pop >= 50) ? `今天降雨 ${t.pop}%，帶把傘`
      : (t.tmax != null) ? `今天 ${t.tmin ?? "?"}~${t.tmax}°`
      : `今天${t.cond}`;
    if (hr >= 5 && hr < 11) pool.push(`早安 ☀️ ${_focus}。新的一天，先別急著看帳戶，喝口水比較實在。`);
    else if (hr >= 11 && hr < 14) pool.push(`午安 🍱 ${_focus}。吃飽再盯盤，餓著做決策容易衝動。`);
    else if (hr >= 18 && hr < 23) pool.push(`晚安 🌙 ${_focus}。今天就到這，收盤了就放過自己。`);
    else if (hr >= 23 || hr < 5) pool.push(`夜深了 🌌 ${_focus}。別熬夜盯盤，睡眠是最便宜的風控。`);
    // 都沒特別狀況 → 給個普通今日預報
    if (!pool.length) pool.push(`今天${t.cond}、${t.tmin}~${t.tmax}°，降雨機率 ${t.pop != null ? t.pop : 0}%。`);
    return "🐻 " + pool[Math.floor(Math.random() * pool.length)];
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
  let _bearTransitioning = false;
  let _bearTransTimer = null;

  function showBubble() {
    if (!bubble) return;
    bubble.textContent = _nextLine();
    bubble.classList.add("visible");
    clearTimeout(_bubbleTimer);
    _bubbleTimer = setTimeout(() => { if (!_bearHover) bubble.classList.remove("visible"); }, 5500);
  }

  function _startHideBubble() {
    clearTimeout(_bubbleTimer);
    _bubbleTimer = setTimeout(() => bubble?.classList.remove("visible"), 3000);
  }

  setTimeout(() => { bear.classList.add("peeking"); window._syncWeatherCard('peeking'); }, 2800);

  function _onEnter() {
    _bearHover = true;
    clearTimeout(_bearTransTimer);
    _bearTransitioning = true;
    bear.classList.add('peek-full');
    _bearTransTimer = setTimeout(() => { _bearTransitioning = false; }, 520);
    clearTimeout(_bubbleTimer);
    if (!bubble?.classList.contains("visible")) showBubble();
    window._syncWeatherCard('full');
  }
  function _onLeave(e) {
    if (_bearTransitioning) return;   // ignore during slide-up animation
    const to = e.relatedTarget;
    if (bear.contains(to) || bubble?.contains(to)) return;
    _bearHover = false;
    bear.classList.remove('peek-full');
    _startHideBubble();
    window._syncWeatherCard('peeking');
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
    bubble.textContent = _forecastLine() || _nextLine();
    bubble.classList.add("visible");
    clearTimeout(_bubbleTimer);
    _bubbleTimer = setTimeout(() => { if (!_bearHover) bubble.classList.remove("visible"); }, 6500);
  }
  /* 對齊時鐘整 10 分刻度（9:00 / 9:10 / 9:20…）冒出全身播天氣預報 */
  function _doForecastVisit() {
    if (!bear.classList.contains("peeking")) return;   // 使用者正在互動(full)→ 這次跳過、不打斷
    bear.classList.add("peek-visit");
    window._syncWeatherCard('full');
    showForecastBubble();
    const stay = 5000;   // 預報停留久一點好讀
    setTimeout(() => {
      bear.classList.remove("peek-visit");
      window._syncWeatherCard('peeking');
    }, stay);
  }
  function _msToNext10min() {   // 到下一個整 10 分刻度的毫秒數
    const now = new Date();
    const into = now.getMinutes() % 10 * 60000 + now.getSeconds() * 1000 + now.getMilliseconds();
    return 600000 - into;
  }
  function scheduleVisit() {
    setTimeout(() => {
      _doForecastVisit();
      setInterval(_doForecastVisit, 600000);   // 之後每 10 分鐘整點刻度
    }, _msToNext10min());
  }
  scheduleVisit();
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
    const items = [...container.querySelectorAll(".ticker-item")];
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
    const nextIdx = e.key === "ArrowDown"
      ? (activeIdx < 0 ? 0 : (activeIdx + 1) % items.length)
      : (activeIdx <= 0 ? items.length - 1 : activeIdx - 1);
    const next = items[nextIdx];

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
  const TARGETS = "button,.tf-btn,.rp-btn,.dt-btn,.tk-seg-btn,.sym-tab";
  document.addEventListener("pointerdown", e => {
    // 手機/觸控：整個關掉漣漪（矮寬按鈕上會外溢成半圓放大動畫，使用者不要）
    if (window.matchMedia && (matchMedia("(max-width: 768px)").matches || matchMedia("(pointer: coarse)").matches)) return;
    const btn = e.target.closest(TARGETS);
    if (!btn) return;
    // 交易面板（桌面嵌入合約行情底部 / 手機交易分頁）：矮寬按鈕漣漪會外溢成半圓動畫，使用者不要 → 整面板關閉
    if (btn.closest("#tradePopup")) return;
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

