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
  let _shuffled = [], _shufflePos = 0;
  function _nextLine() {
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

  /* 定時隨機冒出全身並說話 */
  function scheduleVisit() {
    const wait = 600000; // 10 分鐘後出現
    setTimeout(() => {
      if (!bear.classList.contains("peeking")) { scheduleVisit(); return; }
      bear.classList.add("peek-visit");
      window._syncWeatherCard('full');
      showBubble();
      const stay = 2800 + Math.random() * 2200; // 停留 2.8~5 秒
      setTimeout(() => {
        bear.classList.remove("peek-visit");
        window._syncWeatherCard('peeking');
        scheduleVisit();
      }, stay);
    }, wait);
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
      } else if (first.dataset.wlIdx !== undefined) {
        first.click();
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
    } else if (next.dataset.wlIdx !== undefined) {
      next.click();
    }
  });
})();

/* ══════════════════════════════════════════
   按鈕漣漪效果
══════════════════════════════════════════ */
(function initButtonRipple() {
  const TARGETS = "button,.tf-btn,.rp-btn,.dt-btn,.music-theme-btn,.tk-seg-btn,.sym-tab";
  document.addEventListener("pointerdown", e => {
    const btn = e.target.closest(TARGETS);
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 2.2;
    const x    = e.clientX - rect.left  - size / 2;
    const y    = e.clientY - rect.top   - size / 2;
    const wave = document.createElement("span");
    wave.className = "btn-ripple-wave";
    wave.style.cssText = `width:${size}px;height:${size}px;left:${x}px;top:${y}px`;
    btn.appendChild(wave);
    wave.addEventListener("animationend", () => wave.remove(), { once: true });
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

/* ══════════════════════════════════════════
   背景音樂播放器
══════════════════════════════════════════ */
(function initMusicPlayer() {
  let _ctx = null, _masterGain = null, _musicGain = null;
  let _schedulerTimer = null, _autoTimer = null;
  let _nextNoteTime  = 0;
  let _step          = 0;
  let _activeTheme   = "off";
  let _autoActual    = "lofi";

  /* ── 音符頻率 ── */
  const N = {
    A2:110.0, Bb2:116.5, B2:123.5,
    C3:130.8, D3:146.8, Eb3:155.6, E3:164.8, F3:174.6, G3:196.0, Ab3:207.7, Bb3:233.1,
    B3:246.9, A3:220.0,
    C4:261.6, D4:293.7, Eb4:311.1, E4:329.6, F4:349.2, G4:392.0, Ab4:415.3,
    A4:440.0, Bb4:466.2, B4:493.9,
    C5:523.3, D5:587.3, E5:659.3, F5:698.5, G5:784.0, A5:880.0,
  };

  /* ── 主題定義 ──
     每個 step: { n:[freqs], b:beats, v:vol }  n=[] → 休止符 */
  const THEMES = {
    lofi: {
      bpm: 72, wave: "sine", fType: "lowpass", fFreq: 760, fQ: 0.8,
      steps: [
        // ── Cm  ──
        {n:[N.C3,N.Eb4,N.G4],  b:1,   v:0.055},
        {n:[N.Bb4],             b:0.5, v:0.028},
        {n:[N.G4],              b:0.5, v:0.025},
        {n:[N.C3,N.Eb4],        b:1,   v:0.04 },
        // ── Bb  ──
        {n:[N.Bb3,N.F4,N.Bb4], b:1,   v:0.052},
        {n:[N.G4],              b:0.5, v:0.026},
        {n:[N.F4],              b:0.5, v:0.024},
        {n:[N.Bb3,N.Eb4],       b:1,   v:0.038},
        // ── Ab  ──
        {n:[N.Ab3,N.C4,N.Eb4], b:1,   v:0.05 },
        {n:[N.G4],              b:0.5, v:0.028},
        {n:[N.Bb4],             b:0.5, v:0.025},
        {n:[N.Ab3,N.C4],        b:1,   v:0.04 },
        // ── G dominant  ──
        {n:[N.G3,N.G4,N.Bb4],  b:1,   v:0.052},
        {n:[N.G4],              b:0.5, v:0.026},
        {n:[N.Eb4],             b:0.5, v:0.024},
        {n:[N.G3,N.D4],         b:1,   v:0.038},
      ],
    },
    bull: {
      bpm: 128, wave: "triangle", fType: "highpass", fFreq: 220, fQ: 0.7,
      steps: [
        {n:[N.C4],       b:0.5, v:0.075},
        {n:[N.E4],       b:0.5, v:0.075},
        {n:[N.G4],       b:0.5, v:0.075},
        {n:[N.C5],       b:0.5, v:0.08 },
        {n:[N.G4],       b:0.5, v:0.07 },
        {n:[N.E4],       b:0.5, v:0.065},
        {n:[N.G4],       b:0.5, v:0.07 },
        {n:[N.C5,N.E5],  b:1.0, v:0.085},
        {n:[N.A4],       b:0.5, v:0.07 },
        {n:[N.C5],       b:0.5, v:0.075},
        {n:[N.E5],       b:0.5, v:0.08 },
        {n:[N.G5],       b:0.5, v:0.085},
        {n:[N.E5],       b:0.5, v:0.075},
        {n:[N.C5],       b:0.5, v:0.07 },
        {n:[N.G4],       b:0.5, v:0.065},
        {n:[N.C5,N.E5],  b:1.0, v:0.085},
      ],
    },
    bear: {
      bpm: 58, wave: "sine", fType: "lowpass", fFreq: 520, fQ: 1.2,
      steps: [
        {n:[N.D4,N.F4],  b:2,   v:0.06 },
        {n:[],           b:1,   v:0    },
        {n:[N.C4],       b:1,   v:0.05 },
        {n:[N.D3,N.A4],  b:2,   v:0.055},
        {n:[],           b:2,   v:0    },
        {n:[N.Bb3,N.F4], b:2,   v:0.055},
        {n:[N.Eb4],      b:1,   v:0.045},
        {n:[],           b:1,   v:0    },
        {n:[N.D4,N.Ab4], b:1.5, v:0.05 },
        {n:[N.C4],       b:1.5, v:0.045},
        {n:[],           b:1,   v:0    },
      ],
    },
    scalp: {
      bpm: 162, wave: "square", fType: "bandpass", fFreq: 900, fQ: 2.5,
      steps: [
        {n:[N.A4],  b:0.25, v:0.055},
        {n:[],      b:0.25, v:0    },
        {n:[N.A4],  b:0.25, v:0.055},
        {n:[N.C5],  b:0.25, v:0.065},
        {n:[N.A4],  b:0.25, v:0.055},
        {n:[],      b:0.25, v:0    },
        {n:[N.G4],  b:0.25, v:0.05 },
        {n:[N.A4],  b:0.25, v:0.06 },
        {n:[N.A4],  b:0.25, v:0.055},
        {n:[],      b:0.25, v:0    },
        {n:[N.A4],  b:0.25, v:0.055},
        {n:[N.E5],  b:0.5,  v:0.07 },
        {n:[N.D5],  b:0.25, v:0.06 },
        {n:[N.C5],  b:0.25, v:0.055},
        {n:[N.A4],  b:0.25, v:0.055},
        {n:[],      b:0.25, v:0    },
      ],
    },
    ghibli: {
      /* 宮崎風鋼琴：F大調，64 BPM，三角波模擬鋼琴音色 */
      bpm: 64, wave: "triangle", fType: "lowpass", fFreq: 2400, fQ: 0.5,
      steps: [
        // ── Bar 1：F major ──
        {n:[N.F3, N.C5, N.F5],       b:1,   v:0.065},
        {n:[N.C4, N.E5],              b:1,   v:0.052},
        {n:[N.A3, N.D5],              b:1,   v:0.050},
        {n:[N.F3, N.C5],              b:1,   v:0.048},
        // ── Bar 2：Dm ──
        {n:[N.D3, N.D5],              b:1,   v:0.062},
        {n:[N.A2, N.C5],              b:1,   v:0.050},
        {n:[N.F3, N.A4],              b:1,   v:0.048},
        {n:[N.D3, N.F4],              b:1.5, v:0.050},
        {n:[N.A4],                    b:0.5, v:0.036},
        // ── Bar 3：Bb ──
        {n:[N.Bb2, N.D5],             b:1.5, v:0.062},
        {n:[N.C5],                    b:0.5, v:0.050},
        {n:[N.Bb3, N.Bb4],            b:1,   v:0.050},
        {n:[N.G3, N.A4],              b:1,   v:0.044},
        // ── Bar 4：C dominant ──
        {n:[N.C3, N.E3, N.C5],        b:1,   v:0.065},
        {n:[N.G3, N.G4],              b:1,   v:0.050},
        {n:[N.E3, N.A4],              b:1,   v:0.050},
        {n:[N.C3, N.E4, N.G4],        b:1,   v:0.055},
        // ── Bar 5：F resolve ──
        {n:[N.F3, N.F4, N.A4, N.C5], b:2.5, v:0.060},
        {n:[N.D5],                    b:0.5, v:0.048},
        {n:[N.C5],                    b:0.5, v:0.044},
        {n:[N.A4],                    b:0.5, v:0.040},
      ],
    },
    merry: {
      /* 人生のメリーゴーランド — Howl's Moving Castle, waltz 3/4, C major */
      bpm: 100, wave: "triangle", fType: "lowpass", fFreq: 2200, fQ: 0.5,
      steps: [
        {n:[N.C3,N.E4],         b:1,   v:0.068},
        {n:[N.G3,N.D4],         b:1,   v:0.050},
        {n:[N.G3,N.C4],         b:1,   v:0.045},
        {n:[N.G3,N.B3],         b:1,   v:0.065},
        {n:[N.D3,N.A3],         b:1,   v:0.048},
        {n:[N.D3,N.B3],         b:1,   v:0.045},
        {n:[N.C3,N.C4],         b:1,   v:0.068},
        {n:[N.G3,N.E4],         b:1,   v:0.055},
        {n:[N.G3,N.D4],         b:1,   v:0.050},
        {n:[N.C3,N.G4],         b:1,   v:0.072},
        {n:[N.F3,N.F4],         b:1,   v:0.060},
        {n:[N.F3,N.E4],         b:1,   v:0.055},
        {n:[N.G3,N.D4],         b:1,   v:0.060},
        {n:[N.G3,N.E4],         b:0.5, v:0.050},
        {n:[N.G3,N.D4],         b:0.5, v:0.048},
        {n:[N.G3,N.B3],         b:1,   v:0.055},
        {n:[N.C3,N.E4,N.G4],    b:2,   v:0.072},
        {n:[N.C3,N.C4],         b:1,   v:0.058},
      ],
    },
    inochi: {
      /* いのちの名前 — Spirited Away, Am→F→C→G, gentle 4/4 */
      bpm: 58, wave: "sine", fType: "lowpass", fFreq: 1800, fQ: 0.5,
      steps: [
        {n:[N.A3,N.A4],         b:1.5, v:0.058},
        {n:[N.A3,N.C5],         b:1,   v:0.052},
        {n:[N.A3,N.B4],         b:1.5, v:0.048},
        {n:[N.F3,N.A4],         b:1.5, v:0.055},
        {n:[N.F3,N.G4],         b:1,   v:0.048},
        {n:[N.F3,N.F4],         b:1.5, v:0.044},
        {n:[N.C3,N.G4],         b:1,   v:0.052},
        {n:[N.C3,N.A4],         b:1,   v:0.055},
        {n:[N.G3,N.C5],         b:1.5, v:0.062},
        {n:[N.G3,N.B4],         b:1,   v:0.052},
        {n:[N.G3,N.A4],         b:1,   v:0.048},
        {n:[N.G3,N.G4],         b:1,   v:0.044},
        {n:[N.A3,N.A4],         b:2,   v:0.058},
        {n:[N.F3,N.C5],         b:1.5, v:0.062},
        {n:[N.C3,N.B4],         b:1,   v:0.052},
        {n:[N.C3,N.G4],         b:1.5, v:0.045},
        {n:[N.A3,N.A4,N.C5],    b:2,   v:0.062},
      ],
    },
    totoro: {
      /* となりのトトロ — My Neighbor Totoro, C major, cheerful */
      bpm: 88, wave: "triangle", fType: "lowpass", fFreq: 2600, fQ: 0.4,
      steps: [
        {n:[N.C3,N.E4],         b:0.5, v:0.065},
        {n:[N.C3,N.E4],         b:0.5, v:0.060},
        {n:[N.C3,N.F4],         b:0.5, v:0.068},
        {n:[N.C3,N.G4],         b:0.5, v:0.072},
        {n:[N.G3,N.G4],         b:0.5, v:0.068},
        {n:[N.G3,N.F4],         b:0.5, v:0.062},
        {n:[N.G3,N.E4],         b:0.5, v:0.058},
        {n:[N.G3,N.D4],         b:0.5, v:0.055},
        {n:[N.C3,N.C4],         b:1.5, v:0.065},
        {n:[N.C3,N.D4],         b:0.5, v:0.055},
        {n:[N.F3,N.E4],         b:1.5, v:0.062},
        {n:[N.F3,N.D4],         b:0.5, v:0.050},
        {n:[N.G3,N.G4],         b:0.5, v:0.068},
        {n:[N.G3,N.A4],         b:0.5, v:0.072},
        {n:[N.G3,N.Bb4],        b:1,   v:0.068},
        {n:[N.C3,N.G4],         b:1,   v:0.060},
        {n:[N.C3,N.E4,N.G4],    b:2,   v:0.072},
      ],
    },
    mononoke: {
      /* もののけ姫 — Princess Mononoke, Dm, epic & solemn */
      bpm: 78, wave: "sine", fType: "lowpass", fFreq: 1600, fQ: 0.8,
      steps: [
        {n:[N.D3,N.D4],         b:0.5, v:0.060},
        {n:[N.D3,N.F4],         b:0.5, v:0.065},
        {n:[N.D3,N.A4],         b:0.5, v:0.068},
        {n:[N.D3,N.D5],         b:1,   v:0.075},
        {n:[N.Bb2,N.C5],        b:0.5, v:0.065},
        {n:[N.Bb2,N.A4],        b:0.5, v:0.060},
        {n:[N.Bb2,N.G4],        b:0.5, v:0.055},
        {n:[N.Bb2,N.F4],        b:0.5, v:0.050},
        {n:[N.A2,N.E4],         b:0.5, v:0.052},
        {n:[N.A2,N.G4],         b:0.5, v:0.055},
        {n:[N.A2,N.A4],         b:1,   v:0.058},
        {n:[N.F3,N.F4],         b:2,   v:0.065},
        {n:[N.D3,N.D4],         b:0.5, v:0.058},
        {n:[N.D3,N.F4],         b:0.5, v:0.062},
        {n:[N.D3,N.G4],         b:0.5, v:0.062},
        {n:[N.D3,N.Bb4],        b:0.5, v:0.065},
        {n:[N.C3,N.A4],         b:0.5, v:0.060},
        {n:[N.C3,N.G4],         b:0.5, v:0.055},
        {n:[N.C3,N.F4],         b:0.5, v:0.050},
        {n:[N.C3,N.E4],         b:0.5, v:0.048},
        {n:[N.D3,N.A3,N.D4],    b:2,   v:0.068},
      ],
    },
    sanpo: {
      /* さんぽ — My Neighbor Totoro, C major march, upbeat */
      bpm: 132, wave: "triangle", fType: "highpass", fFreq: 200, fQ: 0.5,
      steps: [
        {n:[N.C3,N.G4],         b:0.5, v:0.068},
        {n:[N.C3,N.G4],         b:0.5, v:0.062},
        {n:[N.C3,N.A4],         b:0.5, v:0.070},
        {n:[N.C3,N.G4],         b:0.5, v:0.065},
        {n:[N.F3,N.F4],         b:0.5, v:0.060},
        {n:[N.F3,N.E4],         b:0.5, v:0.058},
        {n:[N.G3,N.D4],         b:0.5, v:0.055},
        {n:[N.C3,N.C4],         b:1,   v:0.068},
        {n:[N.C3,N.G4],         b:0.5, v:0.068},
        {n:[N.C3,N.G4],         b:0.5, v:0.062},
        {n:[N.C3,N.A4],         b:0.5, v:0.070},
        {n:[N.C3,N.G4],         b:0.5, v:0.065},
        {n:[N.Bb2,N.Bb4],       b:0.5, v:0.072},
        {n:[N.Bb2,N.A4],        b:1.5, v:0.068},
        {n:[N.C3,N.C5],         b:0.5, v:0.075},
        {n:[N.C3,N.C5],         b:0.5, v:0.072},
        {n:[N.C3,N.D5],         b:0.5, v:0.075},
        {n:[N.C3,N.C5],         b:0.5, v:0.072},
        {n:[N.Bb2,N.Bb4],       b:0.5, v:0.068},
        {n:[N.F3,N.A4],         b:0.5, v:0.062},
        {n:[N.G3,N.G4],         b:0.5, v:0.060},
        {n:[N.F3,N.F4],         b:0.5, v:0.055},
        {n:[N.C3,N.E4,N.G4],    b:2,   v:0.072},
      ],
    },
  };

  function _getCtx() {
    if (!_ctx) {
      _ctx = new (window.AudioContext || window.webkitAudioContext)();
      _masterGain = _ctx.createGain(); _masterGain.gain.value = 1;
      _masterGain.connect(_ctx.destination);
      _musicGain  = _ctx.createGain(); _musicGain.gain.value = 0.25;
      _musicGain.connect(_masterGain);
    }
    if (_ctx.state === "suspended") _ctx.resume();
    return _ctx;
  }

  function _playNote(freq, startT, dur, vol, wave, fType, fFreq, fQ) {
    const ctx  = _getCtx();
    const osc  = ctx.createOscillator();
    const filt = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    osc.type         = wave;
    osc.frequency.value = freq;
    filt.type        = fType;
    filt.frequency.value = fFreq;
    filt.Q.value     = fQ;
    osc.connect(filt); filt.connect(gain); gain.connect(_musicGain);
    gain.gain.setValueAtTime(0, startT);
    gain.gain.linearRampToValueAtTime(vol, startT + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.001, startT + dur * 0.88);
    osc.start(startT);
    osc.stop(startT + dur + 0.01);
  }

  function _scheduleChunk(themeKey) {
    const theme = THEMES[themeKey];
    if (!theme) return;
    const ctx       = _getCtx();
    const beatSec   = 60 / theme.bpm;
    const LOOK_AHEAD = 2.2;
    if (_nextNoteTime < ctx.currentTime) _nextNoteTime = ctx.currentTime;

    while (_nextNoteTime < ctx.currentTime + LOOK_AHEAD) {
      const step    = theme.steps[_step % theme.steps.length];
      const stepDur = step.b * beatSec;
      if (step.n.length > 0 && step.v > 0) {
        step.n.forEach(f =>
          _playNote(f, _nextNoteTime, stepDur * 0.82, step.v,
                    theme.wave, theme.fType, theme.fFreq, theme.fQ)
        );
      }
      _nextNoteTime += stepDur;
      _step++;
    }
  }

  function _reset() { _nextNoteTime = 0; _step = 0; }

  function _stopAll() {
    clearInterval(_schedulerTimer); _schedulerTimer = null;
    clearInterval(_autoTimer);      _autoTimer      = null;
    const ytF = document.getElementById("ytFrame");
    if (ytF) ytF.innerHTML = "";   // 停止 YouTube 播放
  }

  function _startTheme(key) {
    _stopAll(); _reset();
    _activeTheme = key;
    if (key === "off") return;

    const actual = key === "auto" ? _autoActual : key;
    _scheduleChunk(actual);
    _schedulerTimer = setInterval(() => {
      const run = _activeTheme === "auto" ? _autoActual : _activeTheme;
      _scheduleChunk(run);
    }, 500);

    if (key === "auto") {
      _autoTimer = setInterval(_updateAutoTheme, 5000);
    }
  }

  function _updateAutoTheme() {
    const chgEl   = document.getElementById("symChg");
    const txt     = chgEl?.textContent || "";
    const m       = txt.match(/([-+]?\d+\.?\d*)/);
    const chg     = m ? parseFloat(m[1]) : 0;
    let next;
    if      (chg >=  3.5) next = "bull";
    else if (chg <= -3.5) next = "bear";
    else if (Math.abs(chg) >= 1.5) next = "scalp";
    else                  next = "lofi";
    if (next !== _autoActual) {
      _autoActual = next; _reset();
    }
  }

  /* ── 音量控制 ── */
  function _setVol(v) {
    if (_musicGain) _musicGain.gain.value = v * 0.5;
  }

  /* ── 建立面板邏輯 ── */
  const panel     = document.getElementById("musicPanel");
  const toggleBtn = document.getElementById("musicToggleBtn");
  const volSlider = document.getElementById("musicVol");
  const volLabel  = document.getElementById("musicVolLabel");

  if (!panel || !toggleBtn) return;

  toggleBtn.addEventListener("click", e => {
    e.stopPropagation();
    const willOpen = panel.classList.contains("hidden");
    if (willOpen) window._closeAllFloatPanels?.("music");
    panel.classList.toggle("hidden");
  });
  document.addEventListener("click", e => {
    if (!panel.contains(e.target) && e.target !== toggleBtn)
      panel.classList.add("hidden");
  });

  panel.querySelectorAll(".music-theme-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      panel.querySelectorAll(".music-theme-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const key = btn.dataset.theme;
      _startTheme(key);
      /* 按鈕 icon 狀態 */
      toggleBtn.classList.toggle("playing", key !== "off");
    });
  });

  volSlider?.addEventListener("input", () => {
    const pct = parseInt(volSlider.value, 10);
    _setVol(pct / 100);
    if (volLabel) volLabel.textContent = pct + "%";
  });

  /* ── YouTube 播放器 ── */
  const ytInput = document.getElementById("ytUrlInput");
  const ytBtn   = document.getElementById("ytPlayBtn");
  const ytFrame = document.getElementById("ytFrame");

  function _parseYT(url) {
    const vM = url.match(/[?&]v=([A-Za-z0-9_-]{11})/);
    const sM = url.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
    const lM = url.match(/[?&]list=([A-Za-z0-9_-]+)/);
    return { vid: (vM || sM)?.[1], lid: lM?.[1] };
  }

  ytBtn?.addEventListener("click", () => {
    const { vid, lid } = _parseYT(ytInput?.value?.trim() || "");
    if (!vid && !lid) { ytInput?.focus(); return; }

    /* 停合成音樂 */
    _stopAll();
    _activeTheme = "yt";
    panel.querySelectorAll(".music-theme-btn").forEach(b => b.classList.remove("active"));
    toggleBtn.classList.add("playing");

    /* 建立 iframe src（只允許 youtube.com embed，防 XSS） */
    let src;
    if (lid && vid) src = `https://www.youtube.com/embed/${encodeURIComponent(vid)}?list=${encodeURIComponent(lid)}&autoplay=1&loop=1`;
    else if (lid)   src = `https://www.youtube.com/embed/videoseries?list=${encodeURIComponent(lid)}&autoplay=1&loop=1`;
    else            src = `https://www.youtube.com/embed/${encodeURIComponent(vid)}?autoplay=1&loop=1`;

    if (ytFrame) {
      const iframe = document.createElement("iframe");
      iframe.width  = "100%";
      iframe.height = "112";
      iframe.src    = src;
      iframe.setAttribute("frameborder", "0");
      iframe.setAttribute("allow", "autoplay; encrypted-media");
      iframe.setAttribute("allowfullscreen", "");
      ytFrame.innerHTML = "";
      ytFrame.appendChild(iframe);
    }
  });

  /* Enter 鍵也可觸發播放 */
  ytInput?.addEventListener("keydown", e => { if (e.key === "Enter") ytBtn?.click(); });
})();

/* ── 天氣背景動畫（華麗版）── */
(function initWeatherBg() {
  const canvas = document.getElementById("weatherBg");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  let W = 0, H = 0, type = "sunny", rafId = null, _gc = {}, _lastFrameTs = 0;

  /* shared state */
  let sunAngle = 0, moonGlow = 0;
  let flashAlpha = 0, lightningTimer = 80, lightningPath = [];
  let shootTimer = 200, shootX = 0, shootY = 0, shootDX = 0, shootDY = 0, shootLen = 0;
  let stars = [], sparks = [], rainP = [], ripples = [], snowP = [], cloudP = [], leafP = [], petalP = [], mahjongP = [];
  let thunderBolts = [], thunderFlashes = [], thunderTimer = 15;

  /* ── 麻將牌預渲染快取 ── */
  const _TILE_SYMS = [
    '一萬','二萬','三萬','四萬','五萬','六萬','七萬','八萬','九萬',
    '一筒','二筒','三筒','四筒','五筒','六筒','七筒','八筒','九筒',
    '一條','二條','三條','四條','五條','六條','七條','八條','九條',
    '東','南','西','北','中','發','白',
  ];
  const _TILE_CACHE = {};
  const _TILE_RANKS = {'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9};
  function _tileRR(c,x,y,w,h,r){
    c.beginPath();
    c.moveTo(x+r,y); c.lineTo(x+w-r,y); c.arcTo(x+w,y,x+w,y+r,r);
    c.lineTo(x+w,y+h-r); c.arcTo(x+w,y+h,x+w-r,y+h,r);
    c.lineTo(x+r,y+h); c.arcTo(x,y+h,x,y+h-r,r);
    c.lineTo(x,y+r); c.arcTo(x,y,x+r,y,r); c.closePath();
  }
  /* 筒子：彩色外環 + 米白內圓 + 5瓣花 + 中心圓；綠紅配色依位置 */
  function _drawTong(c,n,TW,TH) {
    const POS={
      1:[[.5,.5]],
      2:[[.5,.26],[.5,.74]],
      3:[[.72,.18],[.5,.5],[.28,.82]],
      4:[[.29,.26],[.71,.26],[.29,.74],[.71,.74]],
      5:[[.29,.2],[.71,.2],[.5,.5],[.29,.8],[.71,.8]],
      6:[[.29,.18],[.71,.18],[.29,.5],[.71,.5],[.29,.82],[.71,.82]],
      7:[[.22,.16],[.5,.16],[.78,.16],[.30,.48],[.70,.48],[.30,.80],[.70,.80]],
      8:[[.3,.1],[.7,.1],[.3,.36],[.7,.36],[.3,.62],[.7,.62],[.3,.88],[.7,.88]],
      9:[[.22,.15],[.5,.15],[.78,.15],[.22,.5],[.5,.5],[.78,.5],[.22,.85],[.5,.85],[.78,.85]],
    };
    const Gn='#006633',Rd='#CC0000';
    const CLRS={
      1:[Rd],
      2:[Gn,Rd],
      3:[Rd,Gn,Rd],
      4:[Gn,Rd,Rd,Gn],
      5:[Gn,Rd,Gn,Rd,Gn],
      6:[Gn,Rd,Gn,Rd,Gn,Rd],
      7:[Gn,Gn,Gn,Rd,Rd,Rd,Rd],
      8:[Gn,Gn,Rd,Rd,Rd,Rd,Gn,Gn],
      9:[Rd,Gn,Rd,Gn,Gn,Gn,Rd,Gn,Rd],
    };
    const bg='#FDF6E3';
    const pos=POS[n]||[], clrs=CLRS[n]||[];
    const Rv=n===1?11.5:n<=4?6.8:n<=6?6:n===7?4.0:4.5;
    pos.forEach(([fx,fy],i)=>{
      const x=fx*TW, y=3+fy*(TH-6), clr=clrs[i]||Gn;
      c.fillStyle=clr; c.beginPath(); c.arc(x,y,Rv,0,Math.PI*2); c.fill();
      c.fillStyle=bg; c.beginPath(); c.arc(x,y,Rv*.68,0,Math.PI*2); c.fill();
      const pr=Rv*.36, rp=Rv*.22; c.fillStyle=clr;
      for(let k=0;k<5;k++){const a=k*Math.PI*2/5+Math.PI/2; c.beginPath(); c.arc(x+Math.cos(a)*pr,y+Math.sin(a)*pr,rp,0,Math.PI*2); c.fill();}
      c.fillStyle=clr; c.beginPath(); c.arc(x,y,Rv*.18,0,Math.PI*2); c.fill();
    });
  }
  /* 條子：竹節方塊 + 紅節點；1條是鳥 */
  function _drawTiao(c,n,TW,TH) {
    if(n===1){
      const bx=TW*.38,by=TH*.46;
      c.fillStyle='#1A6B00'; c.beginPath(); c.ellipse(bx,by+1,8,6,-.2,0,Math.PI*2); c.fill();
      c.fillStyle='#CC3300'; c.beginPath(); c.arc(bx+7,by-4,4.5,0,Math.PI*2); c.fill();
      c.fillStyle='#FF8800'; c.beginPath(); c.moveTo(bx+10.5,by-4); c.lineTo(bx+16,by-2.5); c.lineTo(bx+10.5,by-.5); c.closePath(); c.fill();
      c.fillStyle='#0A4400'; c.beginPath(); c.moveTo(bx-7,by-1); c.lineTo(bx-13,by-5); c.lineTo(bx-11,by+3); c.closePath(); c.fill();
      c.fillStyle='#000'; c.beginPath(); c.arc(bx+8.5,by-5,1.2,0,Math.PI*2); c.fill();
      const sx=TW*.63,sy=TH*.07,sw=TW*.11,sh=TH*.84;
      c.fillStyle='#2B8000'; _tileRR(c,sx,sy,sw,sh,sw*.3); c.fill();
      c.strokeStyle='#1A5000'; c.lineWidth=.6; _tileRR(c,sx,sy,sw,sh,sw*.3); c.stroke();
      c.fillStyle='#CC2200'; c.beginPath(); c.ellipse(sx+sw/2,sy+sh/2,sw*.32,sh*.05,0,0,Math.PI*2); c.fill();
      return;
    }
    /* 竹節形竹子：橢圓帽＋窄身＋中節，五條第3根紅色 */
    const GRIDS={2:{c:2,r:1},3:{c:3,r:1},4:{c:2,r:2},5:{c:2,r:3},
                 6:{c:2,r:3},7:{c:2,r:4},8:{c:2,r:4},9:{c:3,r:3}};
    const {c:cols,r:rows}=GRIDS[n]||{c:2,r:4};
    const pad=3, cw=(TW-pad*2)/cols, rh=(TH-pad*2)/rows;
    const sw=cw*.76, sh=rh*.90;
    let drawn=0;
    for(let r=0;r<rows;r++){
      for(let col=0;col<cols&&drawn<n;col++,drawn++){
        const centred=(n===5&&drawn===4)||(n===7&&drawn===6);
        const cx=pad+(centred?cols/2:col+.5)*cw, cy=pad+(r+.5)*rh;
        const isRed=n===5&&drawn===2;
        const mainC=isRed?'#CC2200':'#1E7800';
        const darkC=isRed?'#8B0A00':'#0C4400';
        const capRX=sw/2;
        const capRY=Math.max(1.8,Math.min(capRX*.68,sh*.23));
        const bW=sw*.68;
        c.fillStyle=mainC;
        c.fillRect(cx-bW/2,cy-sh/2+capRY*.8,bW,sh-capRY*1.6);
        c.beginPath();c.ellipse(cx,cy-sh/2+capRY,capRX,capRY,0,0,Math.PI*2);c.fill();
        c.beginPath();c.ellipse(cx,cy+sh/2-capRY,capRX,capRY,0,0,Math.PI*2);c.fill();
        if(sh>=16){
          c.fillStyle=darkC;
          c.beginPath();c.ellipse(cx,cy,capRX*.85,capRY*.72,0,0,Math.PI*2);c.fill();
        }
      }
    }
  }
  function _getTileImg(sym) {
    if (_TILE_CACHE[sym]) return _TILE_CACHE[sym];
    const TW=38, TH=50;
    const oc=document.createElement('canvas'); oc.width=TW; oc.height=TH;
    const c=oc.getContext('2d');
    /* body */
    c.shadowBlur=5; c.shadowOffsetY=2; c.shadowColor='rgba(0,0,0,.28)';
    const bg=c.createLinearGradient(0,0,0,TH);
    bg.addColorStop(0,'#FFFCEE'); bg.addColorStop(1,'#EEE5C0');
    c.fillStyle=bg; _tileRR(c,1,1,TW-2,TH-2,5); c.fill();
    c.shadowBlur=0; c.shadowOffsetY=0;
    c.strokeStyle='#C0A050'; c.lineWidth=1; _tileRR(c,1,1,TW-2,TH-2,5); c.stroke();
    c.strokeStyle='rgba(160,130,55,.22)'; c.lineWidth=.6; _tileRR(c,3.5,3.5,TW-7,TH-7,3); c.stroke();
    /* content */
    const n=_TILE_RANKS[sym[0]]||0, suit=sym.length>1?sym[1]:null;
    c.textAlign='center'; c.textBaseline='middle';
    if (suit==='萬') {
      c.fillStyle=sym[0]==='五'?'#CC0000':'#111'; c.font='bold 17px serif'; c.fillText(sym[0],TW/2,TH/2-9);
      c.fillStyle='#CC0000'; c.font='bold 15px serif'; c.fillText('萬',TW/2,TH/2+9);
    } else if (suit==='筒') {
      _drawTong(c,n,TW,TH);
    } else if (suit==='條') {
      _drawTiao(c,n,TW,TH);
    } else if (sym==='中') {
      c.fillStyle='#CC0000'; c.font='bold 26px serif'; c.fillText('中',TW/2,TH/2);
    } else if (sym==='發') {
      c.fillStyle='#006600'; c.font='bold 23px serif'; c.fillText('發',TW/2,TH/2);
    } else if (sym==='白') {
      c.strokeStyle='#444'; c.lineWidth=1.5; c.strokeRect(6,8,TW-12,TH-16);
      c.strokeStyle='#444'; c.lineWidth=.7; c.strokeRect(9,11,TW-18,TH-22);
    } else {
      c.fillStyle='#111'; c.font='bold 24px serif'; c.fillText(sym,TW/2,TH/2);
    }
    _TILE_CACHE[sym]=oc; return oc;
  }
  function _newMahjong() {
    return { x:Math.random()*W, y:-44-Math.random()*220,
             vx:(Math.random()-.5)*.9, vy:.5+Math.random()*1.3,
             rot:Math.random()*Math.PI*2, rotV:(Math.random()-.5)*.022,
             swing:Math.random()*Math.PI*2, swingSpd:.012+Math.random()*.018,
             sym:_TILE_SYMS[Math.floor(Math.random()*_TILE_SYMS.length)],
             a:.60+Math.random()*.38 };
  }
  let _autoType = "sunny";
  let _wxLat = 25.04, _wxLon = 121.51, _wxTimer = null;
  const _wd = { code:0, temp:null, precip:0, cloudCover:50, windSpeed:0, visibility:10000, isDay:true, city:null, updatedAt:null, intensity:0.5, desc:null, source:null,
               sunRiseMin:360, sunSetMin:1080, moonPhase:0, moonRiseMin:1080, moonSetMin:360 };
  const WMO_DESC = {
    0:'晴天',1:'晴時多雲',2:'局部多雲',3:'陰天',
    45:'霧',48:'霧凇',
    51:'毛毛雨',53:'毛毛雨',55:'濃毛毛雨',56:'凍毛毛雨',57:'濃凍毛毛雨',
    61:'小雨',63:'中雨',65:'大雨',66:'凍雨',67:'大凍雨',
    71:'小雪',73:'中雪',75:'大雪',77:'雪粒',
    80:'陣雨',81:'中陣雨',82:'暴雨',85:'小陣雪',86:'大陣雪',
    95:'雷暴',96:'冰雹雷暴',99:'冰雹雷暴'
  };
  const _TZ_CITY = {
    'Taipei':'台北','Hong_Kong':'香港','Tokyo':'東京','Seoul':'首爾',
    'Shanghai':'上海','Beijing':'北京','Singapore':'新加坡',
    'Bangkok':'曼谷','New_York':'紐約','Los_Angeles':'洛杉磯',
    'Chicago':'芝加哥','London':'倫敦','Paris':'巴黎','Dubai':'杜拜',
    'Sydney':'雪梨','Melbourne':'墨爾本','Auckland':'奧克蘭',
  };

  function wmoType(c, d) {
    if (c <= 1)                                    return d ? "sunny" : "night";
    if (c <= 3)                                    return "cloudy";
    if (c >= 45 && c <= 48)                        return "fog";
    if (c >= 51 && c <= 57)                        return "rain";
    if (c >= 61 && c <= 67)                        return c >= 65 ? "storm" : "rain";
    if ((c >= 71 && c <= 77) || c===85 || c===86)  return "snow";
    if (c >= 80 && c <= 82)                        return c === 82 ? "storm" : "rain";
    if (c === 95 || c === 96 || c === 99)           return "thunder";
    return "storm";
  }

  function resize() {
    W = canvas.width  = window.innerWidth  || 1200;
    H = canvas.height = window.innerHeight || 700;
    _buildGradCache();
    _init();
  }

  function _sunArcPos() {
    const nowMin = (new Date()).getHours()*60 + (new Date()).getMinutes();
    const rise = _wd.sunRiseMin, set = _wd.sunSetMin;
    const prog = (rise === set) ? 0.5 : Math.max(0, Math.min(1, (nowMin-rise)/(set-rise)));
    return { x: W*0.04 + prog*W*0.92, y: H*0.88 - (H*0.88-H*0.08)*Math.sin(prog*Math.PI) };
  }
  function _newSpark() {
    const {x,y} = _sunArcPos();
    const a = Math.random()*Math.PI*2, d = 28 + Math.random()*Math.min(W,H)*.32;
    return { x: x+Math.cos(a)*d, y: y+Math.sin(a)*d, r: .8+Math.random()*2.2, life: 0, maxLife: 50+Math.random()*80 };
  }

  /* pre-build all gradients that are constant between resizes */
  function _buildGradCache() {
    const sx=W*.85, sy=H*.08;
    function rg(x0,y0,r0,x1,y1,r1,...stops){const g=ctx.createRadialGradient(x0,y0,r0,x1,y1,r1);stops.forEach(([p,c])=>g.addColorStop(p,c));return g;}
    function lg(x0,y0,x1,y1,...stops){const g=ctx.createLinearGradient(x0,y0,x1,y1);stops.forEach(([p,c])=>g.addColorStop(p,c));return g;}
    _gc.sunBg    = rg(sx,sy,0,sx,sy,W*.85,[0,"rgba(255,240,110,.38)"],[.45,"rgba(255,165,30,.11)"],[1,"rgba(0,0,0,0)"]);
    _gc.sunDisc  = rg(sx,sy,0,sx,sy,28,[0,"#FFFCD0"],[1,"#FFD700"]);
    _gc.nebula   = [rg(W*.38,H*.28,0,W*.38,H*.28,W*.55,[0,"rgba(75,25,115,.09)"],[1,"rgba(0,0,0,0)"]),
                    rg(W*.72,H*.55,0,W*.72,H*.55,W*.45,[0,"rgba(18,52,118,.07)"],[1,"rgba(0,0,0,0)"])];
    _gc.stormVg  = rg(W/2,H/2,H*.15,W/2,H/2,W*.88,[0,"rgba(0,0,0,0)"],[1,"rgba(12,12,32,.20)"]);
    _gc.thunderVg= rg(W/2,H/2,H*.06,W/2,H/2,W*.95,[0,"rgba(6,6,22,.52)"],[1,"rgba(2,2,10,.78)"]);
    _gc.fogVg    = rg(W/2,H/2,H*.22,W/2,H/2,W*.8,[0,"rgba(0,0,0,0)"],[1,"rgba(150,175,205,.08)"]);
    _gc.rainSky  = lg(0,0,0,H,[0,"rgba(28,42,66,.26)"],[1,"rgba(8,18,38,.06)"]);
    _gc.rainGnd  = lg(0,H*.88,0,H,[0,"rgba(100,160,220,0)"],[1,"rgba(80,130,200,.09)"]);
    _gc.rainMist = lg(0,H*.62,0,H,[0,"rgba(140,195,245,0)"],[.55,"rgba(140,195,245,.035)"],[1,"rgba(140,195,245,.10)"]);
    _gc.snowAtm  = lg(0,0,0,H*.35,[0,"rgba(200,218,240,.07)"],[1,"rgba(0,0,0,0)"]);
    _gc.leafAmb  = rg(W*.82,0,0,W*.82,0,H*.78,[0,"rgba(255,148,28,.09)"],[1,"rgba(0,0,0,0)"]);
    _gc.leafGnd  = lg(0,H*.82,0,H,[0,"rgba(0,0,0,0)"],[1,"rgba(55,28,8,.06)"]);
    _gc.springSky= lg(0,0,0,H*.7,[0,"rgba(255,210,232,.07)"],[1,"rgba(255,240,248,.02)"]);
  }

  /* ── 太陽 / 月亮弧線 ── */
  function _drawMoonPhase(cx, cy, R, phase) {
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI*2); ctx.clip();
    // dark background inside clip
    ctx.fillStyle = 'rgba(10,14,32,0.96)';
    ctx.fillRect(cx-R, cy-R, R*2, R*2);
    ctx.fillStyle = '#d8e6f5';
    const eRx = R * Math.abs(Math.cos(2 * Math.PI * phase));
    if (phase < 0.5) {
      // waxing: right half lit
      ctx.beginPath(); ctx.arc(cx, cy, R, -Math.PI/2, Math.PI/2); ctx.closePath(); ctx.fill();
      if (phase < 0.25) {
        // crescent → dark ellipse covers right portion
        ctx.fillStyle = 'rgba(10,14,32,0.96)';
        ctx.beginPath(); ctx.ellipse(cx, cy, eRx, R, 0, -Math.PI/2, Math.PI/2); ctx.closePath(); ctx.fill();
      } else {
        // gibbous → lit ellipse extends left
        ctx.beginPath(); ctx.ellipse(cx, cy, eRx, R, 0, Math.PI/2, -Math.PI/2); ctx.closePath(); ctx.fill();
      }
    } else {
      // waning: left half lit
      ctx.beginPath(); ctx.arc(cx, cy, R, Math.PI/2, -Math.PI/2); ctx.closePath(); ctx.fill();
      const p2 = phase - 0.5;
      if (p2 < 0.25) {
        // gibbous → lit ellipse extends right
        ctx.beginPath(); ctx.ellipse(cx, cy, eRx, R, 0, -Math.PI/2, Math.PI/2); ctx.closePath(); ctx.fill();
      } else {
        // crescent → dark ellipse covers left
        ctx.fillStyle = 'rgba(10,14,32,0.96)';
        ctx.beginPath(); ctx.ellipse(cx, cy, eRx, R, 0, Math.PI/2, -Math.PI/2); ctx.closePath(); ctx.fill();
      }
    }
    ctx.restore();
  }

  function _drawAstro(t) {
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
    const lx = W * 0.04, rx = W * 0.96;
    const horizonY = H * 0.88, peakY = H * 0.08;

    if (_wd.isDay) {
      if (type === 'thunder' || type === 'sunny') return; // dSunny handles arc for sunny
      const rise = _wd.sunRiseMin, set = _wd.sunSetMin;
      if (nowMin < rise || nowMin > set) return;
      const prog = (nowMin - rise) / (set - rise);
      const sx = lx + prog * (rx - lx);
      const sy = horizonY - (horizonY - peakY) * Math.sin(prog * Math.PI);
      // horizon warmth near sunrise/sunset
      const edgeFade = Math.min(prog, 1 - prog) * 6; // 0 at edges → 1 past 1/6 of day
      // arc guide
      ctx.save();
      ctx.beginPath();
      for (let p = 0; p <= 1; p += 0.025) {
        const ax = lx + p * (rx - lx);
        const ay = horizonY - (horizonY - peakY) * Math.sin(p * Math.PI);
        p === 0 ? ctx.moveTo(ax, ay) : ctx.lineTo(ax, ay);
      }
      ctx.strokeStyle = 'rgba(255,200,60,0.07)';
      ctx.lineWidth = 1; ctx.setLineDash([3, 9]); ctx.stroke(); ctx.setLineDash([]);
      // opacity by weather, boosted near horizon
      let al = 1.0;
      if (type==='storm') al=0.15; else if (type==='rain') al=0.35;
      else if (type==='fog') al=0.50; else if (type==='cloudy') al=0.62;
      al = Math.max(al, edgeFade < 1 ? 0.80 : 0); // sunrise/sunset always bright
      ctx.globalAlpha = al;
      // horizon glow at low prog (sunrise) or high prog (sunset)
      if (edgeFade < 1) {
        const hg = ctx.createRadialGradient(sx, horizonY, 0, sx, horizonY, W * 0.35);
        hg.addColorStop(0, 'rgba(255,160,40,0.22)'); hg.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = hg; ctx.fillRect(0, 0, W, H);
      }
      // glow
      const glow = ctx.createRadialGradient(sx,sy,0,sx,sy,62);
      glow.addColorStop(0,'rgba(255,240,100,0.45)'); glow.addColorStop(0.42,'rgba(255,160,30,0.15)'); glow.addColorStop(1,'rgba(0,0,0,0)');
      ctx.fillStyle=glow; ctx.beginPath(); ctx.arc(sx,sy,62,0,Math.PI*2); ctx.fill();
      // disc
      const disc = ctx.createRadialGradient(sx,sy,0,sx,sy,17);
      disc.addColorStop(0,'#FFFCD0'); disc.addColorStop(1,'#FFD700');
      ctx.fillStyle=disc; ctx.beginPath(); ctx.arc(sx,sy,17,0,Math.PI*2); ctx.fill();
      // cute face (scaled for R=17 disc)
      ctx.save(); ctx.globalAlpha=1;
      ctx.fillStyle='rgba(255,130,80,.22)';
      ctx.beginPath(); ctx.ellipse(sx-7,sy+3,4,2.2,0,0,Math.PI*2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(sx+7,sy+3,4,2.2,0,0,Math.PI*2); ctx.fill();
      ctx.fillStyle='rgba(110,50,0,.80)';
      ctx.beginPath(); ctx.arc(sx-5,sy-4,1.9,0,Math.PI*2); ctx.fill();
      ctx.beginPath(); ctx.arc(sx+5,sy-4,1.9,0,Math.PI*2); ctx.fill();
      ctx.fillStyle='rgba(255,255,255,.92)';
      ctx.beginPath(); ctx.arc(sx-4.3,sy-4.9,.7,0,Math.PI*2); ctx.fill();
      ctx.beginPath(); ctx.arc(sx+5.7,sy-4.9,.7,0,Math.PI*2); ctx.fill();
      ctx.strokeStyle='rgba(110,50,0,.68)'; ctx.lineWidth=1.5; ctx.lineCap='round';
      ctx.beginPath(); ctx.arc(sx,sy+.5,5.5,.15*Math.PI,.85*Math.PI); ctx.stroke();
      ctx.restore();
      // corona pulse
      const pls = 0.5+0.5*Math.sin(t*1.4);
      ctx.strokeStyle=`rgba(255,210,55,${0.13+0.07*pls})`; ctx.lineWidth=1.5;
      ctx.beginPath(); ctx.arc(sx,sy,23+pls*3,0,Math.PI*2); ctx.stroke();
      ctx.globalAlpha=1; ctx.restore();
    } else {
      if (type === 'thunder' || type === 'night') return; // dNight handles its own moon
      const rise = _wd.moonRiseMin, set = _wd.moonSetMin;
      const phase = _wd.moonPhase;
      const vis = Math.sin(phase * Math.PI);
      if (vis < 0.02) return; // true new moon, skip
      // only draw moon when actually above the horizon
      let prog;
      if (rise < set) {
        if (nowMin < rise || nowMin > set) return;
        prog = (nowMin - rise) / (set - rise);
      } else {
        const dur = (1440 - rise) + set;
        if (nowMin >= rise)       prog = (nowMin - rise) / dur;
        else if (nowMin <= set)   prog = (1440 - rise + nowMin) / dur;
        else return;
      }
      const mx = lx + prog * (rx - lx);
      const my = horizonY - (horizonY - peakY) * Math.sin(prog * Math.PI);
      let al = Math.max(0.18, vis) * 0.92; // floor so near-new-moon still faintly shows
      if (type==='storm') al*=0.2; else if (type==='rain') al*=0.45; else if (type==='fog') al*=0.55;
      ctx.save(); ctx.globalAlpha = al;
      const mglow = ctx.createRadialGradient(mx,my,0,mx,my,65);
      mglow.addColorStop(0,'rgba(180,210,255,0.22)'); mglow.addColorStop(1,'rgba(0,0,0,0)');
      ctx.fillStyle=mglow; ctx.beginPath(); ctx.arc(mx,my,65,0,Math.PI*2); ctx.fill();
      _drawMoonPhase(mx, my, 18, phase); // bigger radius for visibility
      ctx.globalAlpha=1; ctx.restore();
    }
  }

  function _init() {
    const ri = Math.max(0.3, _wd.intensity);          /* precip intensity 0.3-1 */
    const ci = Math.min(1, _wd.cloudCover / 100);      /* cloud cover 0-1 */
    stars  = Array.from({length:100}, () => ({ x:Math.random()*W, y:Math.random()*H*.88, r:.3+Math.random()*1.8, ph:Math.random()*Math.PI*2, sp:.8+Math.random()*1.5 }));
    sparks = Array.from({length:14}, _newSpark);
    const nFine=Math.round(40+80*ri), nHeavy=Math.round(15+50*ri);
    rainP = [
      ...Array.from({length:nFine},  () => ({ x:Math.random()*W, y:Math.random()*H, spd:3+Math.random()*2.5,  len:6+Math.random()*8,  a:.09+Math.random()*.13 })),
      ...Array.from({length:nHeavy}, () => ({ x:Math.random()*W, y:Math.random()*H, spd:9+Math.random()*6,    len:14+Math.random()*16, a:.34+Math.random()*.44 })),
    ];
    ripples = [];
    const nSnow = Math.round(18+30*ri);
    snowP  = Array.from({length:nSnow}, () => ({ x:Math.random()*W, y:Math.random()*H, r:2+Math.random()*5, spd:.4+Math.random()*1.2, drift:(Math.random()-.5)*.6, rot:Math.random()*Math.PI/3, rotSpd:(Math.random()-.5)*.022, a:.5+Math.random()*.5 }));
    const nCloud=Math.max(2, Math.round(2+5*ci));
    const alBase=0.15+ci*.30, scBase=0.11+ci*.08;
    const wf = 1 + Math.min(4, _wd.windSpeed / 12); // wind speed factor: calm=1×, 50km/h=5×
    cloudP = Array.from({length:nCloud}, (_, i) => ({ x:Math.random()*W, y:H*(.05+i*(0.88/nCloud)), sc:scBase+Math.random()*.10, al:alBase+Math.random()*.12, sp:(.04+Math.random()*.12)*wf }));
    leafP  = Array.from({length:42}, () => { const lf=_newLeaf(); lf.y=Math.random()*H; return lf; });
    petalP  = Array.from({length:38}, () => { const p=_newPetal(); p.y=Math.random()*H; return p; });
    mahjongP= Array.from({length:28}, () => { const p=_newMahjong(); p.y=Math.random()*H; return p; });
    shootTimer = 200+Math.floor(Math.random()*250);
  }

  /* ── smooth bezier cloud ── */
  function _cloud(cx, cy, w, alpha) {
    ctx.save(); ctx.globalAlpha = alpha;
    const h = w * 0.44;
    /* organic silhouette traced with bezier curves */
    ctx.beginPath();
    ctx.moveTo(cx - w*.40, cy + h*.55);
    ctx.bezierCurveTo(cx - w*.40, cy + h*.92, cx + w*.40, cy + h*.92, cx + w*.40, cy + h*.55); /* flat bottom */
    ctx.bezierCurveTo(cx + w*.60, cy + h*.55, cx + w*.62, cy + h*.06, cx + w*.36, cy - h*.04); /* right up */
    ctx.bezierCurveTo(cx + w*.30, cy - h*.52, cx + w*.08, cy - h*.56, cx + w*.04, cy - h*.08); /* top-right puff */
    ctx.bezierCurveTo(cx + w*.06, cy - h*.90, cx - w*.20, cy - h*.94, cx - w*.16, cy - h*.08); /* tallest center puff */
    ctx.bezierCurveTo(cx - w*.20, cy - h*.58, cx - w*.50, cy - h*.50, cx - w*.44, cy - h*.04); /* top-left puff */
    ctx.bezierCurveTo(cx - w*.62, cy + h*.06, cx - w*.60, cy + h*.55, cx - w*.40, cy + h*.55); /* left down */
    ctx.closePath();
    /* volumetric gradient: bright white top → blue-grey bottom */
    const g = ctx.createRadialGradient(cx - w*.07, cy - h*.18, 0, cx, cy + h*.30, w*.72);
    g.addColorStop(0.00, "rgba(250,253,255,.96)");
    g.addColorStop(0.38, "rgba(232,243,252,.92)");
    g.addColorStop(0.75, "rgba(200,222,242,.82)");
    g.addColorStop(1.00, "rgba(168,198,226,.60)");
    ctx.fillStyle = g; ctx.fill();
    /* subtle bright edge highlight */
    ctx.strokeStyle = "rgba(255,255,255,.22)"; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.restore();
  }

  /* ── 6-arm snowflake crystal (optimised: single path per flake, no shadowBlur) ── */
  function _snowflake(x, y, r, angle, alpha) {
    ctx.save(); ctx.globalAlpha = alpha;
    ctx.strokeStyle = "rgba(210,232,255,1)";
    ctx.lineWidth = Math.max(.5, r*.2); ctx.lineCap = "round";
    ctx.translate(x, y); ctx.rotate(angle);
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a=(i/6)*Math.PI*2, ax=Math.cos(a)*r, ay=Math.sin(a)*r;
      ctx.moveTo(0,0); ctx.lineTo(ax,ay);
      [.45,.68].forEach(t => {
        const bx=ax*t, by=ay*t, len=r*.3;
        [a+Math.PI/4, a-Math.PI/4].forEach(ba => {
          ctx.moveTo(bx,by); ctx.lineTo(bx+Math.cos(ba)*len, by+Math.sin(ba)*len);
        });
      });
    }
    ctx.stroke();
    ctx.restore();
  }

  /* ── recursive midpoint-displacement lightning ── */
  function _bolt(x1,y1,x2,y2,d) {
    if (d === 0) return [[x2,y2]];
    const mx=(x1+x2)/2+(Math.random()-.5)*55*(d/5), my=(y1+y2)/2;
    return [..._bolt(x1,y1,mx,my,d-1), ..._bolt(mx,my,x2,y2,d-1)];
  }

  /* ── branching lightning: main bolt + side branches ── */
  function _boltWithBranches(x1,y1,x2,y2,depth) {
    const main=[[x1,y1],..._bolt(x1,y1,x2,y2,depth)];
    const branches=[];
    const nb=3+Math.floor(Math.random()*3);   /* 3–5 branches */
    for (let i=0;i<nb;i++) {
      const si=2+Math.floor(Math.random()*(main.length-4));
      const [bx,by]=main[si];
      const baseAng=Math.atan2(y2-y1,x2-x1);
      const ang=baseAng+(Math.random()-.5)*Math.PI*1.0;
      const blen=H*(.12+Math.random()*.28);     /* longer branches */
      const ex=bx+Math.cos(ang)*blen, ey=by+Math.abs(Math.sin(ang))*blen+blen*.25;
      const subDepth=depth-1+(Math.random()<.3?1:0);  /* occasional deep branch */
      branches.push({ path:[[bx,by],..._bolt(bx,by,ex,ey,subDepth)], alpha:.40+Math.random()*.45 });
    }
    return {main,branches};
  }

  /* ═══════════════ per-weather draw ═══════════════ */

  function dSunny(t) {
    /* arc position: left=east/rise → right=west/set */
    const nowMin = (new Date()).getHours()*60 + (new Date()).getMinutes() + (new Date()).getSeconds()/60;
    const rise = _wd.sunRiseMin, set = _wd.sunSetMin;
    const prog = (rise === set) ? 0.5 : Math.max(0, Math.min(1, (nowMin-rise)/(set-rise)));
    const sx = W*0.04 + prog*(W*0.92);
    const sy = H*0.88 - (H*0.88-H*0.08)*Math.sin(prog*Math.PI);
    sunAngle += .0035;
    /* background warm glow */
    const bg = ctx.createRadialGradient(sx,sy,0,sx,sy,W*.85);
    bg.addColorStop(0,'rgba(255,240,110,.38)'); bg.addColorStop(.45,'rgba(255,165,30,.11)'); bg.addColorStop(1,'rgba(0,0,0,0)');
    ctx.fillStyle=bg; ctx.fillRect(0,0,W,H);
    /* 10 rotating rays */
    ctx.save(); ctx.translate(sx,sy); ctx.lineCap="round";
    for (let i=0;i<10;i++) {
      const a=sunAngle+(i/10)*Math.PI*2, even=i%2===0;
      const len=W*(.28+.05*Math.sin(t*.7+i));
      ctx.strokeStyle=even?`rgba(255,230,80,.14)`:`rgba(255,200,50,.07)`;
      ctx.lineWidth=even?2.5:1.2;
      ctx.beginPath(); ctx.moveTo(Math.cos(a)*32,Math.sin(a)*32); ctx.lineTo(Math.cos(a)*len,Math.sin(a)*len); ctx.stroke();
    }
    ctx.restore();
    /* pulsing halo rings */
    [55,85,120].forEach((r,i) => {
      ctx.strokeStyle=`rgba(255,220,80,${.20-i*.05})`; ctx.lineWidth=i===0?2.5:2;
      ctx.beginPath(); ctx.arc(sx,sy,r+Math.sin(t*1.1+i)*7,0,Math.PI*2); ctx.stroke();
    });
    /* sun disc */
    const disc = ctx.createRadialGradient(sx,sy,0,sx,sy,28);
    disc.addColorStop(0,'#FFFCD0'); disc.addColorStop(1,'#FFD700');
    ctx.shadowBlur=30; ctx.shadowColor="rgba(255,200,0,1)";
    ctx.fillStyle=disc; ctx.beginPath(); ctx.arc(sx,sy,28,0,Math.PI*2); ctx.fill();
    ctx.shadowBlur=0;
    /* cute face */
    ctx.save();
    ctx.fillStyle='rgba(255,130,80,.24)'; // blush
    ctx.beginPath(); ctx.ellipse(sx-12,sy+5,6,3.5,0,0,Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(sx+12,sy+5,6,3.5,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='rgba(110,50,0,.82)'; // eyes
    ctx.beginPath(); ctx.arc(sx-8,sy-7,3,0,Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(sx+8,sy-7,3,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='rgba(255,255,255,.95)'; // eye shine
    ctx.beginPath(); ctx.arc(sx-7,sy-8.5,1.1,0,Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(sx+9,sy-8.5,1.1,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle='rgba(110,50,0,.72)'; ctx.lineWidth=2.2; ctx.lineCap='round'; // smile
    ctx.beginPath(); ctx.arc(sx,sy+1,9,.15*Math.PI,.85*Math.PI); ctx.stroke();
    ctx.restore();
    /* sparkles — keep near sun */
    sparks.forEach((p,i) => {
      p.life++;
      if (p.life>p.maxLife) { sparks[i]=_newSpark(); return; }
      const a=Math.sin((p.life/p.maxLife)*Math.PI)*.88;
      if (a>.75) { ctx.shadowBlur=5; ctx.shadowColor="rgba(255,220,0,.9)"; }
      ctx.fillStyle=`rgba(255,242,120,${a})`;
      ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,Math.PI*2); ctx.fill(); ctx.shadowBlur=0;
    });
  }

  function dNight(t) {
    moonGlow = Math.sin(t*.5)*.12+.5;
    /* nebula blobs (cached gradients) */
    _gc.nebula.forEach(g => { ctx.fillStyle=g; ctx.fillRect(0,0,W,H); });
    /* twinkling stars */
    stars.forEach(p => {
      const a=.15+.75*Math.sin(t*p.sp+p.ph);
      if (a>.88) { ctx.shadowBlur=5; ctx.shadowColor="rgba(200,220,255,.9)"; }
      ctx.fillStyle=`rgba(222,232,255,${a})`;
      ctx.beginPath(); ctx.arc(p.x,p.y,a>.6?p.r*1.3:p.r,0,Math.PI*2); ctx.fill(); ctx.shadowBlur=0;
    });
    /* shooting star */
    shootTimer--;
    if (shootTimer<=0) {
      shootTimer=160+Math.floor(Math.random()*280);
      shootX=Math.random()*W*.75; shootY=Math.random()*H*.35;
      const ang=Math.PI/5+(Math.random()-.5)*.4;
      shootDX=Math.cos(ang)*13; shootDY=Math.sin(ang)*13; shootLen=90+Math.random()*120;
    }
    if (shootLen>0) {
      const tl=ctx.createLinearGradient(shootX,shootY,shootX-shootDX*7,shootY-shootDY*7);
      tl.addColorStop(0,"rgba(255,255,255,.93)"); tl.addColorStop(1,"rgba(255,255,255,0)");
      ctx.strokeStyle=tl; ctx.lineWidth=1.8; ctx.shadowBlur=10; ctx.shadowColor="white";
      ctx.beginPath(); ctx.moveTo(shootX,shootY); ctx.lineTo(shootX-shootDX*6,shootY-shootDY*6); ctx.stroke();
      ctx.shadowBlur=0;
      shootX+=shootDX; shootY+=shootDY; shootLen-=Math.hypot(shootDX,shootDY);
    }
    /* moon — proper phase rendering */
    const _mx=W*.82, _my=H*.09, _mr=22;
    ctx.save();
    const _mglow=ctx.createRadialGradient(_mx,_my,0,_mx,_my,_mr*2.8);
    _mglow.addColorStop(0,`rgba(190,220,255,${moonGlow*.26})`); _mglow.addColorStop(1,'rgba(0,0,0,0)');
    ctx.fillStyle=_mglow; ctx.beginPath(); ctx.arc(_mx,_my,_mr*2.8,0,Math.PI*2); ctx.fill();
    ctx.shadowBlur=32; ctx.shadowColor=`rgba(200,230,255,${moonGlow*.70})`;
    _drawMoonPhase(_mx, _my, _mr, _wd.moonPhase);
    ctx.shadowBlur=0; ctx.restore();
  }

  function dCloudy(t) {
    cloudP.forEach((c, i) => {
      c.x += c.sp;
      if (c.x - W*c.sc > W) c.x = -W*c.sc*1.5;
      _cloud(c.x, c.y + Math.sin(t*.18 + i*1.3)*3.5, W*c.sc, c.al);
    });
  }

  function dFog(t) {
    /* flat bands – no per-band gradient allocation */
    for (let i=0;i<8;i++) {
      const y=H*(.10+i*.12)+Math.sin(t*(.2+i*.04)+i)*H*.04;
      const dn=.05+(i===3||i===4?.04:0);
      ctx.fillStyle=`rgba(180,200,228,${(dn*.55).toFixed(3)})`;
      ctx.fillRect(0,Math.round(y-65),W,130);
    }
    ctx.fillStyle=_gc.fogVg; ctx.fillRect(0,0,W,H);
  }

  function dRain() {
    /* stormy sky overlay (cached gradient) */
    ctx.fillStyle=_gc.rainSky; ctx.fillRect(0,0,W,H);

    ctx.lineCap="round";
    const near=p=>p.a>0.3;
    const _wd_drift=_wd.windSpeed*.016; // wind-driven horizontal shift per frame
    rainP.forEach(p => {
      const n=near(p);
      ctx.strokeStyle=n?`rgba(185,225,255,${p.a})`:`rgba(130,175,225,${p.a})`;
      ctx.lineWidth=n?1.1:.55;
      ctx.beginPath(); ctx.moveTo(p.x,p.y); ctx.lineTo(p.x-p.len*.13-_wd_drift*p.len*.08,p.y+p.len); ctx.stroke();
      p.y+=p.spd; p.x-=p.spd*.13+_wd_drift;
      if (p.y>H+p.len) {
        if (n && ripples.length<45)
          ripples.push({x:p.x, y:H*.968, r:0, maxR:7+Math.random()*13, a:.42});
        p.y=-p.len; p.x=Math.random()*(W+60)-30;
      }
    });

    /* puddle ripple rings */
    for (let i=ripples.length-1;i>=0;i--) {
      const rp=ripples[i];
      ctx.strokeStyle=`rgba(165,215,255,${rp.a})`; ctx.lineWidth=.8;
      ctx.beginPath(); ctx.ellipse(rp.x,rp.y,rp.r,rp.r*.28,0,0,Math.PI*2); ctx.stroke();
      rp.r+=.85; rp.a-=.026;
      if (rp.a<=0) ripples.splice(i,1);
    }

    /* wet ground sheen (cached) */
    ctx.fillStyle=_gc.rainGnd; ctx.fillRect(0,H*.88,W,H*.12);
    /* bottom mist (cached) */
    ctx.fillStyle=_gc.rainMist; ctx.fillRect(0,H*.62,W,H*.38);
  }

  function dSnow(t) {
    snowP.forEach(p => {
      _snowflake(p.x,p.y,p.r,p.rot,p.a);
      p.y+=p.spd; p.x+=p.drift+Math.sin(t*.5+p.x*.01)*.3+_wd.windSpeed*.007; p.rot+=p.rotSpd;
      if (p.y>H+p.r*2) { p.y=-p.r*2; p.x=Math.random()*W; }
      if (p.x<-10) p.x=W+10; if (p.x>W+10) p.x=-10;
    });
    ctx.fillStyle=_gc.snowAtm; ctx.fillRect(0,0,W,H*.35);
  }

  function dStorm() {
    /* heavy angled rain */
    rainP.forEach(p => {
      ctx.strokeStyle=`rgba(130,180,255,${p.a*.75})`; ctx.lineWidth=1;
      ctx.beginPath(); ctx.moveTo(p.x,p.y); ctx.lineTo(p.x-5,p.y+p.len*1.3); ctx.stroke();
      p.y+=p.spd*1.6; p.x-=2.2+_wd.windSpeed*.012;
      if (p.y>H+p.len) { p.y=-p.len; p.x=Math.random()*W; }
    });
    /* lightning */
    lightningTimer--;
    if (lightningTimer<=0) {
      lightningTimer=45+Math.floor(Math.random()*90);
      flashAlpha=.24;
      const lx=W*.1+Math.random()*W*.8;
      lightningPath=[[lx,0], ..._bolt(lx,0,lx+(Math.random()-.5)*W*.35,H*.82,5)];
    }
    if (lightningPath.length>1) {
      ctx.shadowBlur=24; ctx.shadowColor="rgba(255,255,200,1)";
      ctx.strokeStyle="rgba(255,255,235,.95)"; ctx.lineWidth=3;
      ctx.beginPath(); ctx.moveTo(lightningPath[0][0],lightningPath[0][1]);
      lightningPath.slice(1).forEach(([x,y]) => ctx.lineTo(x,y)); ctx.stroke();
      /* inner bright core */
      ctx.strokeStyle="rgba(255,255,255,.7)"; ctx.lineWidth=1.2;
      ctx.beginPath(); ctx.moveTo(lightningPath[0][0],lightningPath[0][1]);
      lightningPath.slice(1).forEach(([x,y]) => ctx.lineTo(x,y)); ctx.stroke();
      ctx.shadowBlur=0;
    }
    if (flashAlpha>0) {
      ctx.fillStyle=`rgba(210,225,255,${flashAlpha})`; ctx.fillRect(0,0,W,H);
      flashAlpha=Math.max(0,flashAlpha-.024);
      if (flashAlpha<=0) lightningPath=[];
    }
    /* dark storm vignette (cached) */
    ctx.fillStyle=_gc.stormVg; ctx.fillRect(0,0,W,H);
  }

  /* ── 超強雷暴：傾盆大雨 + 頻繁多叉閃電 + 雷聲 ── */
  function dThunder() {
    /* very heavy angled rain */
    rainP.forEach(p => {
      ctx.strokeStyle=`rgba(160,215,255,${p.a*.85})`; ctx.lineWidth=p.a>.38?1.8:1.1;
      ctx.beginPath(); ctx.moveTo(p.x,p.y); ctx.lineTo(p.x-p.len*.6,p.y+p.len*2.0); ctx.stroke();
      p.y+=p.spd*2.4; p.x-=p.len*.32;
      if (p.y>H+p.len){p.y=-p.len; p.x=Math.random()*W;}
    });
    /* spawn new bolt(s) — slower cadence, softer flash */
    thunderTimer--;
    if (thunderTimer<=0) {
      thunderTimer=90+Math.floor(Math.random()*120);   /* ~1.5–3.5 s between strikes */
      const nb=1+(Math.random()<.25?1:0);              /* usually 1, occasionally 2 */
      for (let i=0;i<nb;i++) {
        const lx=W*.04+Math.random()*W*.92;
        const ex=lx+(Math.random()-.5)*W*.50;
        const {main,branches}=_boltWithBranches(lx,0,ex,H*(.60+Math.random()*.38),5);
        thunderBolts.push({main,branches,alpha:1});
        thunderFlashes.push({alpha:.07+Math.random()*.06, decay:.010+Math.random()*.008}); /* much dimmer */
      }
      /* no thunder sound */
    }
    /* draw bolts — 3-pass rendering for realism */
    for (let i=thunderBolts.length-1;i>=0;i--) {
      const b=thunderBolts[i];
      if (b.alpha<=0){thunderBolts.splice(i,1);continue;}
      ctx.save(); ctx.lineCap="round"; ctx.lineJoin="round";
      /* pass 1: wide diffuse corona */
      ctx.shadowColor="rgba(140,190,255,1)"; ctx.shadowBlur=60;
      ctx.strokeStyle=`rgba(160,210,255,${b.alpha*.30})`; ctx.lineWidth=12;
      ctx.beginPath(); ctx.moveTo(b.main[0][0],b.main[0][1]);
      b.main.slice(1).forEach(([x,y])=>ctx.lineTo(x,y)); ctx.stroke();
      /* pass 2: mid glow */
      ctx.shadowBlur=28; ctx.shadowColor="rgba(200,228,255,1)";
      ctx.strokeStyle=`rgba(210,235,255,${b.alpha*.60})`; ctx.lineWidth=5;
      ctx.beginPath(); ctx.moveTo(b.main[0][0],b.main[0][1]);
      b.main.slice(1).forEach(([x,y])=>ctx.lineTo(x,y)); ctx.stroke();
      /* pass 3: bright white core */
      ctx.shadowBlur=8; ctx.shadowColor="rgba(255,255,255,1)";
      ctx.strokeStyle=`rgba(255,255,255,${b.alpha*.98})`; ctx.lineWidth=2;
      ctx.beginPath(); ctx.moveTo(b.main[0][0],b.main[0][1]);
      b.main.slice(1).forEach(([x,y])=>ctx.lineTo(x,y)); ctx.stroke();
      /* branches */
      b.branches.forEach(br=>{
        ctx.shadowBlur=22; ctx.shadowColor="rgba(180,220,255,1)";
        ctx.strokeStyle=`rgba(200,232,255,${b.alpha*br.alpha*.60})`; ctx.lineWidth=3.5;
        ctx.beginPath(); ctx.moveTo(br.path[0][0],br.path[0][1]);
        br.path.slice(1).forEach(([x,y])=>ctx.lineTo(x,y)); ctx.stroke();
        ctx.shadowBlur=6;
        ctx.strokeStyle=`rgba(255,255,255,${b.alpha*br.alpha*.85})`; ctx.lineWidth=1;
        ctx.beginPath(); ctx.moveTo(br.path[0][0],br.path[0][1]);
        br.path.slice(1).forEach(([x,y])=>ctx.lineTo(x,y)); ctx.stroke();
      });
      ctx.restore();
      b.alpha-=.030;   /* slower fade = bolt lingers longer */
    }
    /* screen flash */
    for (let i=thunderFlashes.length-1;i>=0;i--) {
      const fl=thunderFlashes[i];
      if (fl.alpha<=0){thunderFlashes.splice(i,1);continue;}
      ctx.fillStyle=`rgba(215,230,255,${fl.alpha})`; ctx.fillRect(0,0,W,H);
      fl.alpha=Math.max(0,fl.alpha-fl.decay);
    }
    /* heavy dark vignette (cached) */
    ctx.fillStyle=_gc.thunderVg; ctx.fillRect(0,0,W,H);
  }

  /* ── 麻將牌飄落 ── */
  function dMahjong() {
    mahjongP.forEach((p, i) => {
      p.swing += p.swingSpd;
      p.x += p.vx + Math.sin(p.swing) * .55;
      p.y += p.vy;
      p.rot += p.rotV;
      if (p.y > H+55 || p.x < -60 || p.x > W+60) { mahjongP[i]=_newMahjong(); return; }
      const img = _getTileImg(p.sym);
      ctx.save();
      ctx.globalAlpha = p.a;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      if      (p.sym==='中') { ctx.shadowColor='rgba(255,60,60,.85)';   ctx.shadowBlur=12; }
      else if (p.sym==='發') { ctx.shadowColor='rgba(50,210,80,.85)';   ctx.shadowBlur=12; }
      else if (p.sym==='白') { ctx.shadowColor='rgba(200,220,255,.70)'; ctx.shadowBlur=8;  }
      ctx.drawImage(img, -19, -25);
      ctx.restore();
    });
  }

  /* ── falling leaves ── */
  const LCOLS = ["#C0392B","#E74C3C","#E67E22","#D35400","#F39C12","#D4AC0D","#8B4513","#A04000","#CB4335","#922B21"];
  function _newLeaf() {
    return { x:(Math.random()-.05)*(W+80)-40, y:-20-Math.random()*100,
             vx:(Math.random()-.5)*1.0, vy:.5+Math.random()*1.4,
             rot:Math.random()*Math.PI*2, rotV:(Math.random()-.5)*.04,
             swing:Math.random()*Math.PI*2, swingSpd:.016+Math.random()*.022,
             swingAmp:.8+Math.random()*2.2, sz:7+Math.random()*13,
             col:LCOLS[Math.floor(Math.random()*LCOLS.length)],
             a:.6+Math.random()*.4 };
  }
  function _drawLeaf(lf) {
    const {x,y,rot,sz,col,a}=lf;
    ctx.save(); ctx.globalAlpha=a; ctx.translate(x,y); ctx.rotate(rot);
    /* leaf body */
    ctx.fillStyle=col;
    ctx.beginPath();
    ctx.moveTo(0,-sz);
    ctx.bezierCurveTo( sz*.72,-sz*.5,  sz*.68, sz*.5,  0, sz);
    ctx.bezierCurveTo(-sz*.68, sz*.5, -sz*.72,-sz*.5,  0,-sz);
    ctx.closePath(); ctx.fill();
    /* midrib */
    ctx.strokeStyle="rgba(0,0,0,.20)"; ctx.lineWidth=Math.max(.5,sz*.08); ctx.lineCap="round";
    ctx.beginPath(); ctx.moveTo(0,-sz*.88); ctx.quadraticCurveTo(sz*.07,0,0,sz*.9); ctx.stroke();
    /* side veins (3 pairs) */
    ctx.lineWidth=Math.max(.3,sz*.032); ctx.strokeStyle="rgba(0,0,0,.12)";
    [[-0.45,.44],[-0.05,.38],[0.32,.30]].forEach(([ty,sp]) => {
      const by=ty*sz;
      for (const s of [1,-1]) {
        ctx.beginPath(); ctx.moveTo(0,by);
        ctx.quadraticCurveTo(s*sz*sp*.6,by-sz*.07,s*sz*sp,by-sz*.14); ctx.stroke();
      }
    });
    /* stem */
    ctx.strokeStyle="rgba(80,40,10,.7)"; ctx.lineWidth=Math.max(.5,sz*.065);
    ctx.beginPath(); ctx.moveTo(0,sz*.88); ctx.quadraticCurveTo(sz*.04,sz*1.05,0,sz*1.18); ctx.stroke();
    ctx.restore();
  }
  function dLeaves(t) {
    /* warm autumn ambient (cached gradients) */
    ctx.fillStyle=_gc.leafAmb; ctx.fillRect(0,0,W,H);
    ctx.fillStyle=_gc.leafGnd; ctx.fillRect(0,H*.82,W,H*.18);
    /* wind: multiple sine waves for gust feel */
    const wind=Math.sin(t*.28)*1.5+Math.sin(t*.73)*.7+Math.sin(t*1.6)*.22;
    leafP.forEach((lf,i) => {
      lf.swing+=lf.swingSpd;
      lf.x+=lf.vx+Math.sin(lf.swing)*lf.swingAmp+wind*.35;
      lf.y+=lf.vy+Math.sin(lf.swing*.5)*.14;
      lf.rot+=lf.rotV+Math.cos(lf.swing*.9)*.008;
      if (lf.y>H*.85) { lf.vy=Math.max(0,lf.vy-.04); lf.a=Math.max(0,lf.a-.008); }
      if (lf.y>H+30||lf.x<-90||lf.x>W+90||lf.a<=0) leafP[i]=_newLeaf();
      else _drawLeaf(lf);
    });
  }

  /* ── spring cherry blossom ── */
  function _newPetal() {
    return { x:(Math.random()-.05)*(W+80)-40, y:-10-Math.random()*60,
             vx:(Math.random()-.5)*.7, vy:.35+Math.random()*.9,
             rot:Math.random()*Math.PI*2, rotV:(Math.random()-.5)*.03,
             swing:Math.random()*Math.PI*2, swingSpd:.013+Math.random()*.018,
             swingAmp:.7+Math.random()*2.0, sz:4+Math.random()*7,
             a:.55+Math.random()*.45 };
  }
  function _petal(x, y, sz, rot, alpha) {
    ctx.save(); ctx.globalAlpha=alpha; ctx.translate(x,y); ctx.rotate(rot);
    /* sakura petal: heart-notched wide end, tapered bottom tip */
    ctx.beginPath();
    ctx.moveTo(0, sz*.80);
    ctx.bezierCurveTo(-sz*.60, sz*.30, -sz*.70,-sz*.40, -sz*.30,-sz*.60);
    ctx.bezierCurveTo(-sz*.12,-sz*.92,  0,-sz*.76,  0,-sz*.56);
    ctx.bezierCurveTo(  0,-sz*.76,  sz*.12,-sz*.92, sz*.30,-sz*.60);
    ctx.bezierCurveTo( sz*.70,-sz*.40,  sz*.60, sz*.30,  0, sz*.80);
    ctx.closePath();
    ctx.fillStyle="rgba(255,195,218,.90)"; ctx.fill();
    ctx.strokeStyle="rgba(255,130,170,.20)"; ctx.lineWidth=.5;
    ctx.beginPath(); ctx.moveTo(0,sz*.72); ctx.quadraticCurveTo(sz*.04,-sz*.05,0,-sz*.52); ctx.stroke();
    ctx.restore();
  }
  function dSpring(t) {
    ctx.fillStyle=_gc.springSky; ctx.fillRect(0,0,W,H*.7);
    const wind=Math.sin(t*.22)*1.0+Math.sin(t*.61)*.4;
    petalP.forEach((p,i)=>{
      p.swing+=p.swingSpd;
      p.x+=p.vx+Math.sin(p.swing)*p.swingAmp+wind*.28;
      p.y+=p.vy+Math.sin(p.swing*.5)*.12;
      p.rot+=p.rotV+Math.cos(p.swing*.7)*.006;
      if (p.y>H*.86) { p.vy=Math.max(0,p.vy-.025); p.a=Math.max(0,p.a-.009); }
      if (p.y>H+20||p.x<-80||p.x>W+80||p.a<=0) petalP[i]=_newPetal();
      else _petal(p.x,p.y,p.sz,p.rot,p.a);
    });
  }

  /* ── main loop ── */
  function draw() {
    ctx.clearRect(0,0,W,H);
    const t=Date.now()*.001;
    ({sunny:dSunny,night:dNight,cloudy:dCloudy,fog:dFog,rain:dRain,snow:dSnow,storm:dStorm,thunder:dThunder,mahjong:dMahjong,leaves:dLeaves,spring:dSpring})[type]?.(t);
    _drawAstro(t);
  }
  function loop(ts) { rafId=requestAnimationFrame(loop); if(document.hidden||ts-_lastFrameTs<33)return; _lastFrameTs=ts; draw(); }
  function start(wt) { type=wt; _init(); _lastFrameTs=0; if(!rafId) requestAnimationFrame(loop); }

  function _renderWeatherCard() {
    if (_wd.temp == null) return;
    let el = document.getElementById('_wxCard');
    if (!el) {
      el = document.createElement('div'); el.id = '_wxCard';
      const bs = window._bearCurrentState || 'hidden';
      const initB = bs==='full'?'5px':'-300px';
      el.style.cssText =
        'position:fixed;bottom:'+initB+';right:175px;z-index:9989;'+
        'transition:bottom 0.45s cubic-bezier(0.34,1.56,0.64,1);'+
        'background:rgba(10,12,20,.72);backdrop-filter:blur(10px);'+
        'border:1px solid rgba(255,255,255,.12);border-radius:10px;'+
        'padding:7px 12px;color:#dde2ee;font-size:11.5px;line-height:1.72;'+
        'font-family:-apple-system,BlinkMacSystemFont,sans-serif;'+
        'pointer-events:none;user-select:none;min-width:190px;';
      document.body.appendChild(el);
    }
    const desc = _wd.desc || WMO_DESC[_wd.code] || '未知';
    const city = _wd.city ? _wd.city + '　' : '';
    const hm   = _wd.updatedAt
      ? String(_wd.updatedAt.getHours()).padStart(2,'0')+':'+
        String(_wd.updatedAt.getMinutes()).padStart(2,'0')
      : '';
    const vis  = _wd.visibility >= 1000
      ? (_wd.visibility/1000).toFixed(1)+' km' : _wd.visibility+' m';
    el.innerHTML =
      '<div style="font-size:13px;font-weight:600;letter-spacing:.3px">'+city+_wd.temp+'°C　'+desc+'</div>'+
      '<div style="opacity:.68">風速 '+_wd.windSpeed+' km/h　雲量 '+_wd.cloudCover+'%</div>'+
      '<div style="opacity:.68">降雨 '+_wd.precip+' mm　能見度 '+vis+'</div>'+
      '<div style="opacity:.38;font-size:10px">'+hm+' 更新　'+(_wd.source==='cwa'?'中央氣象署':'Open-Meteo')+'</div>';
  }

  function fetchWeather(lat, lon) {
    _wxLat = lat; _wxLon = lon;
    if (!_wxTimer) _wxTimer = setInterval(() => fetchWeather(_wxLat, _wxLon), 30*60*1000);
    fetch('/api/weather?lat='+lat+'&lon='+lon)
      .then(r => r.json())
      .then(d => {
        _wd.source      = d.source || null;
        _wd.temp        = d.temperature;
        _wd.isDay       = d.is_day;
        _wd.precip      = d.precipitation;
        _wd.cloudCover  = d.cloud_cover;
        _wd.windSpeed   = d.wind_speed;
        _wd.visibility  = d.visibility;
        _wd.desc        = d.description || null;
        _wd.city        = d.location || d.station || null;
        _wd.updatedAt   = new Date();
        _wd.sunRiseMin  = d.sun_rise_min  ?? 360;
        _wd.sunSetMin   = d.sun_set_min   ?? 1080;
        _wd.moonPhase   = d.moon_phase    ?? 0;
        _wd.moonRiseMin = d.moon_rise_min ?? 1080;
        _wd.moonSetMin  = d.moon_set_min  ?? 360;
        const pInt = Math.min(1, (d.precipitation || 0) / 20);
        const cInt = (d.cloud_cover || 0) / 100;
        _wd.intensity  = Math.max(0.3, pInt * 0.7 + cInt * 0.3);
        _autoType = d.weather_type || 'sunny';
        const manualOn = ['leaf','rain','snow','spring','thunder','mahjong'].some(
          w => document.getElementById(w+'ToggleBtn')?.classList.contains(w+'-active')
        );
        if (!manualOn) start(_autoType);
        _renderWeatherCard();
      })
      .catch(() => {
        _autoType = 'sunny'; _wd.intensity = 0.5;
        const manualOn = ['leaf','rain','snow','spring','thunder','mahjong'].some(
          w => document.getElementById(w+'ToggleBtn')?.classList.contains(w+'-active')
        );
        if (!manualOn) start('sunny');
      });
  }
  function _clearWeatherBtns() {
    document.getElementById("leafToggleBtn")    ?.classList.remove("leaf-active");
    document.getElementById("rainToggleBtn")    ?.classList.remove("rain-active");
    document.getElementById("snowToggleBtn")    ?.classList.remove("snow-active");
    document.getElementById("springToggleBtn")  ?.classList.remove("spring-active");
    document.getElementById("thunderToggleBtn") ?.classList.remove("thunder-active");
    document.getElementById("mahjongToggleBtn") ?.classList.remove("mahjong-active");
  }
  window._getWeatherType = () => type;

  window._leafToggle = function() {
    const btn=document.getElementById("leafToggleBtn");
    if (type==="leaves") { start(_autoType); _clearWeatherBtns(); }
    else { _clearWeatherBtns(); start("leaves"); btn&&btn.classList.add("leaf-active"); }
  };
  window._rainToggle = function() {
    const btn=document.getElementById("rainToggleBtn");
    if (type==="rain") { start(_autoType); _clearWeatherBtns(); }
    else { _clearWeatherBtns(); start("rain"); btn&&btn.classList.add("rain-active"); }
  };
  window._snowToggle = function() {
    const btn=document.getElementById("snowToggleBtn");
    if (type==="snow") { start(_autoType); _clearWeatherBtns(); }
    else { _clearWeatherBtns(); start("snow"); btn&&btn.classList.add("snow-active"); }
  };
  window._springToggle = function() {
    const btn=document.getElementById("springToggleBtn");
    if (type==="spring") { start(_autoType); _clearWeatherBtns(); }
    else { _clearWeatherBtns(); start("spring"); btn&&btn.classList.add("spring-active"); }
  };
  window._mahjongToggle = function() {
    const btn=document.getElementById("mahjongToggleBtn");
    if (type==="mahjong") { start(_autoType); _clearWeatherBtns(); }
    else { _clearWeatherBtns(); start("mahjong"); btn?.classList.add("mahjong-active"); }
  };
  window._thunderToggle = function() {
    const btn=document.getElementById("thunderToggleBtn");
    if (type==="thunder") { start(_autoType); _clearWeatherBtns(); }
    else {
      _clearWeatherBtns(); thunderBolts=[]; thunderFlashes=[]; thunderTimer=10;
      start("thunder"); btn&&btn.classList.add("thunder-active");
    }
  };

  window.addEventListener("resize", resize);
  resize();
  start("sunny");

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      p=>fetchWeather(p.coords.latitude,p.coords.longitude),
      ()=>fetchWeather(25.04,121.51)
    );
  } else {
    fetchWeather(25.04,121.51);
  }
})();
