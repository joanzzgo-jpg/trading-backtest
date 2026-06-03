/* ── 天氣背景動畫（華麗版）── */
(function initWeatherBg() {
  const canvas = document.getElementById("weatherBg");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  // 低效能裝置降載：手機(小螢幕/觸控+低記憶體) → 減少粒子數、關 shadowBlur、簡化光束
  const _lowFx = (() => {
    try {
      const small  = Math.min(window.innerWidth, window.innerHeight) < 640;
      const coarse = matchMedia('(pointer: coarse)').matches;
      const lowMem = (navigator.deviceMemory || 8) <= 4;
      return small || (coarse && lowMem);
    } catch(e) { return false; }
  })();
  const _fxN = _lowFx ? 0.55 : 1;          // 粒子數倍率
  const _frameMin = _lowFx ? 50 : 33;      // 幀間隔下限：手機 ~20fps（省 GPU/主執行緒）、桌面 ~30fps
  let W = 0, H = 0, type = "sunny", rafId = null, _gc = {}, _lastFrameTs = 0;
  // 手機：手指觸控/平移圖表時暫停天氣重繪 → 主執行緒全讓給圖表，平移/縮放更順（消除「卡」感）
  let _touchT = 0;
  if (_lowFx) {
    const _mark = () => { _touchT = (performance.now ? performance.now() : Date.now()); };
    window.addEventListener('touchstart', _mark, { passive: true });
    window.addEventListener('touchmove',  _mark, { passive: true });
  }
  let _paX = 0, _paY = 0, _paTX = 0, _paTY = 0, _paOn = false;   // 視差深度：平滑值/目標值(-1~1)，滑鼠或陀螺儀驅動

  /* shared state */
  let sunAngle = 0, moonGlow = 0;
  let flashAlpha = 0, lightningTimer = 80, lightningPath = [];
  let shootTimer = 200, shootX = 0, shootY = 0, shootDX = 0, shootDY = 0, shootLen = 0;
  let stars = [], sparks = [], rainP = [], ripples = [], snowP = [], cloudP = [], leafP = [], petalP = [], mahjongP = [], windStreaks = [];
  let glassDrops = [], splashes = [];   // 雨：前景玻璃水珠 / 地面濺起水花
  let snowAccum = 0, fogBlobs = [];     // 雪：底部積雪厚度 / 霧：體積霧團
  let _rainRamp = 0;                     // 雨勢漸起：0→1 緩升（下雨開始時歸零）
  let auroraBands = [], meteors = [], meteorTimer = 0;   // 極光帶 / 流星雨
  let thunderBolts = [], thunderFlashes = [], thunderTimer = 15;
  // 天然災害（手動特效）：冰雹 / 龍卷風 / 地震
  let hailP = [], hailSplash = [], qCracks = [], qDust = [], tDebris = [], tornadoX = 0, quakeT = 0;

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
  /* 筒子：彩色外環 + 米白內圓 + 5瓣花 + 中心圓；三色（綠/紅/黑） */
  function _drawTong(c,n,TW,TH) {
    const POS={
      1:[[.5,.5]],
      2:[[.5,.26],[.5,.74]],
      3:[[.72,.18],[.5,.5],[.28,.82]],
      4:[[.29,.26],[.71,.26],[.29,.74],[.71,.74]],
      5:[[.29,.2],[.71,.2],[.5,.5],[.29,.8],[.71,.8]],
      /* 6餅：上 2 + 下 4（2×2） */
      6:[[.30,.18],[.70,.18], [.30,.55],[.70,.55],[.30,.85],[.70,.85]],
      /* 7餅：上 3 綠斜線剛好相切（不重疊）+ 下 4 紅 2×2；上排斜線方向鏡像反轉 */
      7:[[.30,.10],[.50,.25],[.70,.40], [.32,.65],[.68,.65],[.32,.92],[.68,.92]],
      8:[[.3,.1],[.7,.1],[.3,.36],[.7,.36],[.3,.62],[.7,.62],[.3,.88],[.7,.88]],
      9:[[.22,.15],[.5,.15],[.78,.15],[.22,.5],[.5,.5],[.78,.5],[.22,.85],[.5,.85],[.78,.85]],
    };
    const Gn='#0E6B33', Rd='#C42020', Bk='#1A1A1A';
    const CLRS={
      1:[Gn],                                         // 全綠
      2:[Gn,Bk],                                      // 上綠 + 下黑
      3:[Gn,Rd,Gn],
      4:[Gn,Rd,Rd,Gn],
      5:[Gn,Gn,Rd,Gn,Gn],                             // 4 綠角 + 中心紅
      6:[Gn,Gn, Rd,Rd,Rd,Rd],                         // 上 2 綠 + 下 4 紅
      7:[Gn,Gn,Gn, Rd,Rd,Rd,Rd],                      // 上 3 綠 + 下 4 紅
      8:[Bk,Bk,Bk,Bk,Bk,Bk,Bk,Bk],                    // 全黑
      9:[Bk,Bk,Bk, Rd,Rd,Rd, Gn,Gn,Gn],               // 上黑 / 中紅 / 下綠
    };
    const bg='#FDF6E3';
    const pos=POS[n]||[], clrs=CLRS[n]||[];
    const Rv=n===1?11.5:n<=4?6.8:n<=6?6:n===7?5.0:4.5; // 7 餅放大
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
    if(n===1){_drawBird(c,TW,TH);return;}
    /* layout: [fx, fy, rotation?]；rotation 弧度（正＝順時針，頂端向右斜） */
    const LAYOUTS={
      2:[[.50,.28],[.50,.72]],                                                    // 中央上下 2 根
      3:[[.50,.22],[.22,.66],[.78,.66]],                                          // 倒三角（中上、左右下）
      4:[[.30,.27],[.70,.27],[.30,.73],[.70,.73]],                                // 2×2
      5:[[.28,.22],[.72,.22],[.50,.50],[.28,.78],[.72,.78]],                      // X 對稱、中心紅
      6:[[.20,.30],[.50,.30],[.80,.30],[.20,.70],[.50,.70],[.80,.70]],            // 3×2
      7:[[.50,.13],[.20,.45],[.50,.45],[.80,.45],[.20,.80],[.50,.80],[.80,.80]], // 頂 1 紅 + 下 3+3
      /* 上倒M（W）+ 下M：外直、內加大斜度 + 縮小上下間距 → 連貫成「)(」對稱 */
      8:[
        [.14,.27,0], [.36,.30,.55],  [.64,.30,-.55], [.86,.27,0],
        [.14,.73,0], [.36,.70,-.55], [.64,.70,.55],  [.86,.73,0],
      ],
      9:[[.20,.18],[.50,.18],[.80,.18],[.20,.50],[.50,.50],[.80,.50],[.20,.82],[.50,.82],[.80,.82]], // 3×3
    };
    /* RED_IDX: 哪幾根紅。5條中心、7條頂端、9條中間整列 */
    const RED_IDX={5:[2],7:[0],9:[1,4,7]};
    const layout=LAYOUTS[n]||[];
    const redSet=new Set(RED_IDX[n]||[]);
    const W_TBL={2:8,3:7.5,4:7,5:6.5,6:6.5,7:6.5,8:5.5,9:5.8};
    const H_TBL={2:18,3:14,4:18,5:14,6:18,7:13,8:20,9:12};
    const w=W_TBL[n]||6, h=H_TBL[n]||14;
    layout.forEach(([fx,fy,rot=0],i)=>_drawBamboo(c, fx*TW, fy*TH, w, h, redSet.has(i), rot));
  }
  /* 1條：孔雀風格的鳥（中央，不含右側竹子） */
  function _drawBird(c, TW, TH) {
    const bx=TW*.50, by=TH*.50;
    c.fillStyle='#2B8000'; c.beginPath(); c.ellipse(bx,by+3,11,8.5,-.15,0,Math.PI*2); c.fill();
    c.fillStyle='#0A4400'; c.beginPath();
    c.moveTo(bx-3,by-1); c.quadraticCurveTo(bx-11,by+3,bx-8,by+8); c.quadraticCurveTo(bx-3,by+6,bx,by+4); c.closePath(); c.fill();
    c.fillStyle='#CC2200'; c.beginPath(); c.arc(bx+6,by-5,5.5,0,Math.PI*2); c.fill();
    c.fillStyle='#FFB000'; c.beginPath();
    c.moveTo(bx+10,by-6); c.lineTo(bx+18,by-4); c.lineTo(bx+10,by-2); c.closePath(); c.fill();
    c.fillStyle='#fff'; c.beginPath(); c.arc(bx+7,by-6,1.8,0,Math.PI*2); c.fill();
    c.fillStyle='#000'; c.beginPath(); c.arc(bx+7.7,by-6,1,0,Math.PI*2); c.fill();
    c.fillStyle='#CC2200'; c.beginPath();
    c.moveTo(bx+3,by-10); c.lineTo(bx+6,by-14); c.lineTo(bx+9,by-10); c.closePath(); c.fill();
    c.strokeStyle='#FFB000'; c.lineWidth=1.4; c.lineCap='round';
    c.beginPath(); c.moveTo(bx-2,by+10); c.lineTo(bx-2,by+15); c.stroke();
    c.beginPath(); c.moveTo(bx+4,by+10); c.lineTo(bx+4,by+15); c.stroke();
    c.fillStyle='#0A4400'; c.beginPath();
    c.moveTo(bx-9,by); c.lineTo(bx-15,by-4); c.lineTo(bx-13,by+2); c.lineTo(bx-15,by+6); c.lineTo(bx-9,by+4); c.closePath(); c.fill();
  }
  /* 單根竹子：圓角矩形 + 水平竹節線 + 左側高光，可選 rotation */
  function _drawBamboo(c, cx, cy, w, h, isRed, rot=0) {
    const main = isRed?'#CC2200':'#1E7800';
    const dark = isRed?'#7A1500':'#0A4400';
    const lite = isRed?'#FF6644':'#3FA040';
    const r = Math.min(w*.45, 2.4);
    c.save();
    c.translate(cx, cy);
    if (rot) c.rotate(rot);
    c.fillStyle=main;
    _tileRR(c, -w/2, -h/2, w, h, r); c.fill();
    c.fillStyle=dark;
    const nJoints = h>=30 ? 4 : (h>=18 ? 3 : (h>=12 ? 2 : 1));
    const lineH = Math.max(.9, h*.025);
    for (let i=1; i<=nJoints; i++) {
      const yj = -h/2 + (h*i)/(nJoints+1);
      c.fillRect(-w/2+.3, yj-lineH/2, w-.6, lineH);
    }
    c.globalAlpha=.5;
    c.fillStyle=lite;
    const sw = Math.max(.8, w*.16);
    c.fillRect(-w*.32, -h/2+r*.8, sw, h-r*1.6);
    c.restore();
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
    // 為中/發/白把發光烤進快取畫布 → 動畫迴圈內不需要再每幀設 shadowBlur（最大的 CPU 來源）
    const _glow = sym==='中' ? ['rgba(255,60,60,.85)',12]
                : sym==='發' ? ['rgba(50,210,80,.85)',12]
                : sym==='白' ? ['rgba(200,220,255,.70)',8]
                : null;
    let out = oc;
    if (_glow) {
      const pad = Math.ceil(_glow[1] * 1.5);
      const W2 = TW + pad*2, H2 = TH + pad*2;
      const gc = document.createElement('canvas');
      gc.width = W2; gc.height = H2;
      const gx = gc.getContext('2d');
      gx.shadowColor = _glow[0]; gx.shadowBlur = _glow[1];
      gx.drawImage(oc, pad, pad);
      gx.shadowBlur = 0;
      gx.drawImage(oc, pad, pad); // 再描一次本體確保不被陰影沖淡
      out = gc;
    }
    _TILE_CACHE[sym]=out; return out;
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
  const _wd = { code:0, temp:null, precip:0, pop:null, cloudCover:50, windSpeed:0, windDir:null, visibility:10000, isDay:true, city:null, country:null, updatedAt:null, intensity:0.5, desc:null, source:null,
               sunRiseMin:360, sunSetMin:1080, moonPhase:0, moonRiseMin:1080, moonSetMin:360 };

  // 晚霞漸層快取：天空隨「夜化係數 nf」由晚霞色混向深夜藍（鍵：H + nf 量化階）；
  // 地平線暖霾只跟 H 有關。免每幀重建。
  const _ssGrad = { h: -1, nfStep: -1, sky: null, hz: null, hzTop: 0, hzH: -1 };
  // 兩個 #RRGGBB 線性內插（k=0→a, k=1→b）
  function _hexLerp(a, b, k) {
    const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
    const r = Math.round(((pa>>16)&255) + (((pb>>16)&255)-((pa>>16)&255))*k);
    const g = Math.round(((pa>>8)&255)  + (((pb>>8)&255) -((pa>>8)&255)) *k);
    const bl= Math.round((pa&255)        + ((pb&255)      -(pa&255))       *k);
    return '#' + ((1<<24) + (r<<16) + (g<<8) + bl).toString(16).slice(1);
  }

  // 回傳該地當地「一天中分鐘數」(0~1440, 含小數)。日夜/太陽/晚霞/日出/星星全用它 → 切到外國
  // (?wxloc=)時按「當地時間」呈現，而非裝置時間。
  // 優先用後端 Open-Meteo 回的「真實 UTC 偏移」(_wd.tzOffMin，含日光節約)，與校正後的日出日落同一基準；
  // 後端未提供時退回「經度近似」(每 15°=1hr)。
  function _locNowMin() {
    const d = new Date();
    const utcMin = d.getUTCHours()*60 + d.getUTCMinutes() + d.getUTCSeconds()/60 + d.getUTCMilliseconds()/60000;
    const tzOff = (_wd.tzOffMin != null) ? _wd.tzOffMin : Math.round((_wxLon || 0) / 15) * 60;
    let m = utcMin + tzOff;
    return ((m % 1440) + 1440) % 1440;
  }

  /* ── 風向 → 螢幕水平分量（+ 往右/東、- 往左/西）。氣象風向是「來向」(0=N,90=E,180=S,270=W)，
        實際吹向 = 來向+180。取其東西分量當水平風。缺資料時預設西南風（往右上吹）。 */
  function _windVecX() {
    const dir = (_wd.windDir == null) ? 250 : _wd.windDir;
    return Math.sin((dir + 180) * Math.PI / 180);   // -1(左/西) … +1(右/東)
  }
  /* 每幀水平風位移（px/幀，z=1 基準）：方向×(底噪+風速) */
  function _windDriftPx() { return _windVecX() * (0.18 + _wd.windSpeed * 0.02); }
  /* 風向（度，來向）→ 8 方位中文名 */
  const _DIR8 = ['北','東北','東','東南','南','西南','西','西北'];
  function _dirName(deg) { return _DIR8[Math.round((deg % 360) / 45) % 8]; }
  /* 對流潛勢：暖(>24°C) + 高雲 + 雷雨/陣雨 → 畫積雨雲（砧狀對流雲） */
  function _isConvective() {
    const warm = (_wd.temp == null) || _wd.temp >= 24;
    return (type === 'thunder' || type === 'storm') ||
           (warm && _wd.cloudCover >= 60 && (type === 'rain' || type === 'cloudy'));
  }
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

  /* ── 視差深度（3D 感）：滑鼠(桌面)/陀螺儀(手機) 驅動，遠近天氣層以不同幅度位移 ──
     _parX/_parY 回傳某景深 z(0遠~1近) 的像素位移：近層動得多、遠層動得少 → 縱深透視。 */
  function _parX(z){ return _paX * (8 + z*z*44); }
  function _parY(z){ return _paY * (4 + z*z*20); }
  function _initParallax(){
    if (_paOn) return; _paOn = true;
    try { if (matchMedia('(prefers-reduced-motion: reduce)').matches) return; } catch(e){}  // 尊重減少動態偏好
    window.addEventListener('mousemove', e => {
      _paTX = (e.clientX/(window.innerWidth||1) - 0.5) * 2;
      _paTY = (e.clientY/(window.innerHeight||1) - 0.5) * 2;
    }, { passive:true });
    const onTilt = e => {
      if (e.gamma == null) return;
      _paTX = Math.max(-1, Math.min(1, e.gamma/35));            // 左右傾斜（°/35 → ±1）
      _paTY = Math.max(-1, Math.min(1, ((e.beta||45)-45)/35));  // 前後傾斜（以 45° 為中立）
    };
    // 傾斜視差：被動監聽 deviceorientation（Android 直接有；iOS 已授權才有事件）。
    // 不再主動呼叫 iOS DeviceOrientationEvent.requestPermission() → 不會每次開都跳陀螺儀權限詢問
    // （傾斜視差只是次要效果，犧牲它換取不一直被問權限）。
    window.addEventListener('deviceorientation', onTilt, { passive:true });
  }

  function _sunArcPos() {
    const nowMin = _locNowMin();
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
  /* 真實月面：月海(maria) 大片不規則暗斑 [fx,fy,rx,ry,暗度]（近側月海近似位置，非對稱） */
  const _MOON_MARIA = [
    [-.38,-.34,.30,.26,.26],[-.02,-.40,.19,.17,.20],[ .22,-.15,.22,.21,.24],
    [ .50,-.27,.12,.12,.22],[-.50, .05,.20,.33,.21],[-.20, .34,.21,.15,.19],
  ];
  /* 散布的小隕石坑 [fx,fy,半徑比]（小、散、不對稱）*/
  const _MOON_CRA = [
    [-.14,-.06,.055],[.34,.30,.05],[-.40,-.10,.045],[.08,.50,.05],
    [ .42,.12,.035],[-.28,.16,.03],[.18,.40,.028],
  ];
  // 月面繪製本體（畫進任意 2D context g；給離屏快取重複使用）
  function _renderMoon(g, cx, cy, R, phase) {
    const DARK = 'rgba(12,16,34,0.97)';
    // 受光面奶白漸層（偏移高光中心 + 邊緣壓暗 → 球體感 / limb darkening）
    const lit = g.createRadialGradient(cx - R*0.30, cy - R*0.30, R*0.06, cx, cy, R*1.08);
    lit.addColorStop(0, '#fdfcf4'); lit.addColorStop(0.60, '#e7edf6'); lit.addColorStop(1, '#bbc8da');
    g.save();
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI*2); g.clip();
    g.fillStyle = DARK; g.fillRect(cx-R, cy-R, R*2, R*2);
    const eRx = R * Math.abs(Math.cos(2 * Math.PI * phase));
    g.fillStyle = lit;
    if (phase < 0.5) {                       // waxing：右半受光
      g.beginPath(); g.arc(cx, cy, R, -Math.PI/2, Math.PI/2); g.closePath(); g.fill();
      if (phase < 0.25) { g.fillStyle = DARK; g.beginPath(); g.ellipse(cx, cy, eRx, R, 0, -Math.PI/2, Math.PI/2); g.closePath(); g.fill(); }
      else              { g.beginPath(); g.ellipse(cx, cy, eRx, R, 0, Math.PI/2, -Math.PI/2); g.closePath(); g.fill(); }
    } else {                                 // waning：左半受光
      g.beginPath(); g.arc(cx, cy, R, Math.PI/2, -Math.PI/2); g.closePath(); g.fill();
      const p2 = phase - 0.5;
      if (p2 < 0.25) { g.beginPath(); g.ellipse(cx, cy, eRx, R, 0, -Math.PI/2, Math.PI/2); g.closePath(); g.fill(); }
      else           { g.fillStyle = DARK; g.beginPath(); g.ellipse(cx, cy, eRx, R, 0, Math.PI/2, -Math.PI/2); g.closePath(); g.fill(); }
    }
    // 隕石坑：剪裁到受光側（暗面不畫），坑體 + 內陰影 + 受光緣 = 立體凹陷
    const nearFull = Math.abs(phase - 0.5) < 0.07;
    g.save();
    if (!nearFull) {
      g.beginPath();
      if (phase < 0.5) g.rect(cx, cy-R, R, 2*R); else g.rect(cx-R, cy-R, R, 2*R);
      g.clip();
    }
    // 月海：大片柔邊暗灰斑（橢圓，用 translate+scale 壓扁圓形漸層）→ 真實月面感、非臉譜
    _MOON_MARIA.forEach(([fx,fy,rx,ry,d]) => {
      const x=cx+fx*R, y=cy+fy*R, rr=rx*R;
      const gr=g.createRadialGradient(0,0,0,0,0,rr);
      gr.addColorStop(0,`rgba(98,106,126,${d})`); gr.addColorStop(.65,`rgba(106,114,132,${(d*.6).toFixed(3)})`); gr.addColorStop(1,'rgba(106,114,132,0)');
      g.save(); g.translate(x,y); g.scale(1, ry/rx); g.fillStyle=gr;
      g.beginPath(); g.arc(0,0,rr,0,Math.PI*2); g.fill(); g.restore();
    });
    // 小隕石坑：暗點 + 受光緣（小而散）
    _MOON_CRA.forEach(([fx,fy,fr]) => {
      const x=cx+fx*R, y=cy+fy*R, r=fr*R;
      g.fillStyle='rgba(108,118,140,.40)'; g.beginPath(); g.arc(x,y,r,0,Math.PI*2); g.fill();
      g.fillStyle='rgba(252,250,244,.28)'; g.beginPath(); g.arc(x-r*.32,y-r*.32,r*.5,0,Math.PI*2); g.fill();
    });
    g.restore();
    // 整顆 limb darkening（邊緣再壓暗 → 更像球體）
    const ld = g.createRadialGradient(cx, cy, R*0.55, cx, cy, R);
    ld.addColorStop(0, 'rgba(0,0,0,0)'); ld.addColorStop(1, 'rgba(20,28,48,0.30)');
    g.fillStyle = ld; g.fillRect(cx-R, cy-R, R*2, R*2);
    g.restore();   // 結束 disc clip
    // 清晰邊緣描線
    g.save();
    g.strokeStyle='rgba(214,228,248,.55)'; g.lineWidth=Math.max(.6, R*.045);
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI*2); g.stroke();
    g.restore();
  }

  // 月面離屏快取：只在相位/尺寸改變(≈每 30 分一次)時重繪，每幀僅 drawImage 一張
  // → 省下每幀數十次 gradient/clip/arc（夜間最重的逐幀繪製）
  let _moonCv=null, _moonCx=null, _moonKey='';
  function _drawMoonPhase(cx, cy, R, phase) {
    const key = R + '|' + phase.toFixed(3);
    if (key !== _moonKey || !_moonCv) {
      const pad = Math.ceil(R*0.06) + 2, sz = Math.ceil(R*2 + pad*2);
      if (!_moonCv) { _moonCv = document.createElement('canvas'); _moonCx = _moonCv.getContext('2d'); }
      _moonCv.width = sz; _moonCv.height = sz;
      _moonCx.clearRect(0,0,sz,sz);
      _renderMoon(_moonCx, sz/2, sz/2, R, phase);
      _moonKey = key;
    }
    const half = _moonCv.width / 2;
    ctx.drawImage(_moonCv, cx-half, cy-half);
  }

  function _drawAstro(t) {
    if (type==='aurora'||type==='sunset'||type==='sunrise'||type==='meteor') return;  // 這些自帶天空/太陽，不要再疊系統日月
    const nowMin = _locNowMin();
    const lx = W * 0.04, rx = W * 0.96;
    const horizonY = H * 0.88, peakY = H * 0.08;

    if (_wd.isDay) {
      if (type === 'thunder' || type === 'sunny' || type === 'partly') return; // 這些由 dSunny 自畫太陽
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
      if (type==='storm'||type==='overcast') al=0.15; else if (type==='rain'||type==='drizzle') al=0.35;
      else if (type==='fog') al=0.50; else if (type==='cloudy'||type==='windy') al=0.62;
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
      // corona pulse
      const pls = 0.5+0.5*Math.sin(t*1.4);
      ctx.strokeStyle=`rgba(255,210,55,${0.13+0.07*pls})`; ctx.lineWidth=1.5;
      ctx.beginPath(); ctx.arc(sx,sy,23+pls*3,0,Math.PI*2); ctx.stroke();
      ctx.globalAlpha=1; ctx.restore();
    } else {
      if (type === 'thunder') return; // 雷雨自己處理；夜空(night)等其餘夜間天氣都走這條比例制升落弧線
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
      if (type==='storm'||type==='overcast') al*=0.2; else if (type==='rain'||type==='drizzle') al*=0.45; else if (type==='fog'||type==='windy') al*=0.55;
      ctx.save(); ctx.globalAlpha = al;
      const mglow = ctx.createRadialGradient(mx,my,0,mx,my,90);
      mglow.addColorStop(0,'rgba(180,210,255,0.22)'); mglow.addColorStop(1,'rgba(0,0,0,0)');
      ctx.fillStyle=mglow; ctx.beginPath(); ctx.arc(mx,my,90,0,Math.PI*2); ctx.fill();
      _drawMoonPhase(mx, my, (type==='night'?30:26), phase); // 晴朗夜空月亮放大
      ctx.globalAlpha=1; ctx.restore();
    }
  }

  /* ───────────────── 八大行星（夜空，本地計算、無 API、無標籤） ─────────────────
     用 Paul Schlyter 簡化克卜勒軌道根數：算各行星地心赤經/赤緯 → 觀測者地平座標
     (方位角 az / 高度角 alt)，投影到夜空。大小依視星等(越亮越大)、顏色取實際色調。
     地球除外（站在地球上看不到自己），共 7 顆。每 ~2 分鐘重算一次快取。 */
  const _D2R = Math.PI/180, _R2D = 180/Math.PI;
  const _sind = a => Math.sin(a*_D2R), _cosd = a => Math.cos(a*_D2R);
  const _atan2d = (y,x) => Math.atan2(y,x)*_R2D;
  const _rev = a => { a%=360; return a<0 ? a+360 : a; };
  // 各行星：名稱、實際色 [r,g,b]、絕對星等基準 H0、相位係數 ph、
  //          軌道根數 el = [N, i, w, a, e, M]，每項 [常數項, 每日變率]
  const _PLANETS = [
    { name:'Mercury', c:[185,160,126], H0:-0.36, ph:0.027,
      el:[[48.3313,3.24587e-5],[7.0047,5.00e-8],[29.1241,1.01444e-5],[0.387098,0],[0.205635,5.59e-10],[168.6562,4.0923344368]] },
    { name:'Venus',   c:[244,236,203], H0:-4.34, ph:0.013,
      el:[[76.6799,2.46590e-5],[3.3946,2.75e-8],[54.8910,1.38374e-5],[0.723330,0],[0.006773,-1.302e-9],[48.0052,1.6021302244]] },
    { name:'Mars',    c:[217,96,59],   H0:-1.51, ph:0.016,
      el:[[49.5574,2.11081e-5],[1.8497,-1.78e-8],[286.5016,2.92961e-5],[1.523688,0],[0.093405,2.516e-9],[18.6021,0.5240207766]] },
    { name:'Jupiter', c:[231,211,161], H0:-9.25, ph:0.014,
      el:[[100.4542,2.76854e-5],[1.3030,-1.557e-7],[273.8777,1.64505e-5],[5.20256,0],[0.048498,4.469e-9],[19.8950,0.0830853001]] },
    { name:'Saturn',  c:[227,201,138], H0:-9.00, ph:0.044,
      el:[[113.6634,2.38980e-5],[2.4886,-1.081e-7],[339.3939,2.97661e-5],[9.55475,0],[0.055546,-9.499e-9],[316.9670,0.0334442282]] },
    { name:'Uranus',  c:[166,224,230], H0:-7.15, ph:0.001,
      el:[[74.0005,1.3978e-5],[0.7733,1.9e-8],[96.6612,3.0565e-5],[19.18171,-1.55e-8],[0.047318,7.45e-9],[142.5905,0.011725806]] },
    { name:'Neptune', c:[93,123,228],  H0:-6.90, ph:0.001,
      el:[[131.7806,3.0173e-5],[1.7700,-2.55e-7],[272.8461,-6.027e-6],[30.05826,3.313e-8],[0.008606,2.15e-9],[260.2471,0.005995147]] },
  ];
  // 太陽軌道根數（地心黃道用；N=i=0）
  const _SUN_EL = [[0,0],[0,0],[282.9404,4.70935e-5],[1.0,0],[0.016709,-1.151e-9],[356.0470,0.9856002585]];

  function _dayNum(date){
    const Y=date.getUTCFullYear(), M=date.getUTCMonth()+1, D=date.getUTCDate();
    const ut=date.getUTCHours()+date.getUTCMinutes()/60+date.getUTCSeconds()/3600;
    const d=367*Y - Math.floor(7*(Y+Math.floor((M+9)/12))/4) + Math.floor(275*M/9) + D - 730530;
    return d + ut/24;
  }
  // 解克卜勒方程 → 真近點角 v(度) 與向徑 r，連同 N/i/w
  function _orbit(el,d){
    const N=el[0][0]+el[0][1]*d, i=el[1][0]+el[1][1]*d, w=el[2][0]+el[2][1]*d,
          a=el[3][0]+el[3][1]*d, e=el[4][0]+el[4][1]*d, M=_rev(el[5][0]+el[5][1]*d);
    let E=M + e*_R2D*_sind(M)*(1+e*_cosd(M));
    for(let k=0;k<6;k++){ E = E - (E - e*_R2D*_sind(E) - M)/(1 - e*_cosd(E)); }
    const xv=a*(_cosd(E)-e), yv=a*Math.sqrt(1-e*e)*_sind(E);
    return { N, w, v:_atan2d(yv,xv), r:Math.hypot(xv,yv) };
  }
  // 黃道日心直角座標
  function _helioXYZ(o, iDeg){
    const u=o.v+o.w;
    return { x:o.r*(_cosd(o.N)*_cosd(u)-_sind(o.N)*_sind(u)*_cosd(iDeg)),
             y:o.r*(_sind(o.N)*_cosd(u)+_cosd(o.N)*_sind(u)*_cosd(iDeg)),
             z:o.r*(_sind(u)*_sind(iDeg)) };
  }

  let _planetCache = { at:0, list:[] };
  function _computePlanets(lat,lon,date){
    const d=_dayNum(date);
    const ecl=23.4393-3.563e-7*d;
    // 太陽地心位置（黃道，z=0）
    const so=_orbit(_SUN_EL,d);
    const lonsun=_rev(so.v+so.w);
    const xs=so.r*_cosd(lonsun), ys=so.r*_sind(lonsun);
    const sDist=Math.hypot(xs,ys);
    // 地方恆星時（度）
    const ut=date.getUTCHours()+date.getUTCMinutes()/60+date.getUTCSeconds()/3600;
    const gmst0=_rev(so.v+so.w+180)/15;        // 小時
    const lst=_rev((gmst0+ut)*15 + lon);       // 度
    const out=[];
    for(const p of _PLANETS){
      const iDeg=p.el[1][0]+p.el[1][1]*d;
      const o=_orbit(p.el,d), h=_helioXYZ(o,iDeg);
      const xg=h.x+xs, yg=h.y+ys, zg=h.z;       // 地心黃道
      const xe=xg, ye=yg*_cosd(ecl)-zg*_sind(ecl), ze=yg*_sind(ecl)+zg*_cosd(ecl);
      const ra=_rev(_atan2d(ye,xe)), dec=_atan2d(ze,Math.hypot(xe,ye));
      const R=Math.hypot(xg,yg,zg);             // 地心距
      const ha=_rev(lst-ra);
      // HA + Dec → 地平座標
      const x1=_cosd(ha)*_cosd(dec), y1=_sind(ha)*_cosd(dec), z1=_sind(dec);
      const xhor=x1*_sind(lat)-z1*_cosd(lat), yhor=y1, zhor=x1*_cosd(lat)+z1*_sind(lat);
      const az=_rev(_atan2d(yhor,xhor)+180);
      const alt=_atan2d(zhor,Math.hypot(xhor,yhor));
      // 視星等（含相位角）
      let cosFV=(o.r*o.r+R*R-sDist*sDist)/(2*o.r*R); cosFV=Math.max(-1,Math.min(1,cosFV));
      const FV=Math.acos(cosFV)*_R2D;
      const mag=p.H0+5*Math.log10(o.r*R)+p.ph*FV;
      out.push({ c:p.c, az, alt, mag });
    }
    return out;   // 月亮另由 _drawAstro 以比例制升落弧線繪製（跨裝置一致），不在此算
  }

  // 方位角 az / 高度角 alt → 夜空螢幕座標；地平線下或背向 → 回 null
  function _skyXY(az, alt){
    if(alt<=0.5) return null;
    const fa=(_wxLat<0)?(az+180)%360:az;   // 北半球面南、南半球面北
    if(fa<45||fa>315) return null;         // 背向那 ~90°（正後方）略過
    return { x:((fa-45)/270)*W, y:H*0.86-(alt/90)*(H*0.86-H*0.05) };  // 東(升)左、西(落)右
  }

  function _drawPlanets(t){
    const now=Date.now();
    if(now-_planetCache.at>120000){ _planetCache={ at:now, list:_computePlanets(_wxLat,_wxLon,new Date()) }; }
    const cloudDim=1-Math.min(1,(_wd.cloudCover||0)/100)*0.65;
    for(const p of _planetCache.list){
      const pos=_skyXY(p.az,p.alt); if(!pos) continue;
      const x=pos.x, y=pos.y;
      let r=2.8-p.mag*0.55; r=Math.max(1.1,Math.min(4.4,r));            // 最小尺寸提高 → 暗行星也看得到
      let a=(1.45-p.mag*0.16); a=Math.max(0.42,Math.min(1,a))*cloudDim; // 亮度下限提高
      const tw=0.86+0.14*Math.sin(t*1.6+x*0.05);            // 微閃爍
      const [cr,cg,cb]=p.c;
      ctx.save();
      if(r>1.8){                                            // 含火星/土星等較亮行星加光暈
        const g=ctx.createRadialGradient(x,y,0,x,y,r*3.2);
        g.addColorStop(0,`rgba(${cr},${cg},${cb},${(0.45*a*tw).toFixed(3)})`); g.addColorStop(1,'rgba(0,0,0,0)');
        ctx.fillStyle=g; ctx.beginPath(); ctx.arc(x,y,r*3.2,0,Math.PI*2); ctx.fill();
      }
      if (!_lowFx) { ctx.shadowBlur=r*2.4; ctx.shadowColor=`rgba(${cr},${cg},${cb},${(0.85*a).toFixed(3)})`; }  // 手機關 shadowBlur（已有漸層光暈墊著）
      ctx.fillStyle=`rgba(${cr},${cg},${cb},${(a*tw).toFixed(3)})`;
      ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fill();
      ctx.shadowBlur=0; ctx.restore();
    }
  }

  function _init() {
    const ri = Math.max(0.3, _wd.intensity);          /* precip intensity 0.3-1 */
    const ci = Math.min(1, _wd.cloudCover / 100);      /* cloud cover 0-1 */
    stars  = Array.from({length:Math.round(100*_fxN)}, () => ({ x:Math.random()*W, y:Math.random()*H*.88, r:.3+Math.random()*1.8, ph:Math.random()*Math.PI*2, sp:.18+Math.random()*.42 }));
    sparks = Array.from({length:14}, _newSpark);
    // 雨：連續景深 z（0=遠、1=近）；用 z² / z³ 大幅拉開前後差距 → 立體視差明顯
    const nRain = Math.round((110+200*ri)*_fxN);   // 加密雨量（手機降載）
    rainP = Array.from({length:nRain}, () => {
      const z = Math.random();
      return { x:Math.random()*W, y:Math.random()*H, z,
        spd: 3.0 + z*z*z*24,    // 更快（近景雨勢更急）
        len: 5 + z*z*40,        // 近的雨絲更長
        a:   .07 + z*z*.66,
        w:   .3 + z*z*3.0 };    // 近的更粗
    }).sort((p,q)=>p.z-q.z);    // 遠先畫、近後畫（正確前後遮擋）
    ripples = []; splashes = [];
    // 前景玻璃水珠（像隔著窗看雨）：少量大水珠，偶爾滑落留痕
    glassDrops = Array.from({length: Math.round((9 + 11*ri)*_fxN)}, () => ({
      x: Math.random()*W, y: Math.random()*H*0.92, r: 5 + Math.random()*12,
      vy: 0, slide: false, age: Math.random()*500, slideAt: 160 + Math.random()*640
    }));
    // 雪：景深 z 大幅拉開——遠景小柔光點、近景大結晶（差距明顯）
    const nSnow = Math.round((28+50*ri)*_fxN);
    snowP  = Array.from({length:nSnow}, () => {
      const z = Math.random();
      return { x:Math.random()*W, y:Math.random()*H, z,
        r:    1 + z*z*9,         // 1..10
        spd:  .25 + z*z*2.4,     // 遠飄移、近落下明顯快
        drift:(Math.random()-.5)*(.4+z*.7),
        rot:  Math.random()*Math.PI/3, rotSpd:(Math.random()-.5)*.022,
        a:    .3 + z*z*.65 };
    }).sort((p,q)=>p.z-q.z);
    snowAccum = 0;   // 重置底部積雪
    // 霧：體積霧團（多顆大柔邊橢圓，不同景深/速度緩慢飄移billow）
    fogBlobs = Array.from({length:Math.round(8*_fxN)}, () => ({
      x: Math.random()*W, y: H*(0.12+Math.random()*0.74),
      rx: W*(0.22+Math.random()*0.30), ry: H*(0.07+Math.random()*0.13),
      sp: (0.15+Math.random()*0.5)*(Math.random()<.5?1:-1),
      a: 0.035+Math.random()*0.06, ph: Math.random()*6.28, z: Math.random() }));
    // 極光帶：3 層綠/青/紫垂直光簾，會波動飄移
    auroraBands = Array.from({length:3}, () => {
      const rays = Math.round((34 + Math.floor(Math.random()*8))*_fxN);
      return { rays, spacing: (W*1.25)/rays, rayW: 5+Math.random()*3,
        drift: (Math.random()-.5)*0.5, sp: 0.45+Math.random()*0.5,
        ph: Math.random()*6.28, h: H*(0.40+Math.random()*0.24), a: 0.75+Math.random()*0.4 };
    });
    meteors = []; meteorTimer = 0;
    const nCloud=Math.max(2, Math.round(2+5*ci));
    const alBase=0.15+ci*.30, scBase=0.11+ci*.08;
    const wf = 1 + Math.min(4, _wd.windSpeed / 12); // 風速倍率：無風=1×、50km/h=5×
    const conv = _isConvective();                   // 對流潛勢 → 部分雲改積雨雲
    // 雲：帶景深 z（遠=小/高/慢/淡，近=大/低/快/濃），遠先畫近後畫疊出層次
    cloudP = Array.from({length:nCloud}, (_v, i) => {
      const z = Math.random();
      const isCb = conv && i < Math.max(1, Math.round(nCloud*0.5));  // 約半數畫成積雨雲
      // 尺寸分級：約 1/3 是「大雲」、其餘中小 → 破除「每朵都差不多大」的均一感
      const szMul = (Math.random() < 0.33) ? (1.5 + Math.random()*0.6)   // 大雲 1.5~2.1×
                                           : (0.72 + Math.random()*0.5); // 中小 0.72~1.22×
      return {
        x: Math.random()*W,
        y: isCb ? H*(.10 + Math.random()*.16)        // 積雨雲底部偏低（塔身往上長）
                : H*(.04 + (1-z)*.32 + Math.random()*.18),  // 遠雲偏高、近雲偏低
        // 近大遠小(景深) × 尺寸分級(大/中小)；上限避免大到誇張
        sc: isCb ? scBase*(.7+z*.45)+.02
                 : Math.min(.46, scBase*(.58 + z*.62) * szMul) + Math.random()*.02,
        al: Math.min(.96, (isCb ? alBase*(.9+z*.5)+.10 : alBase*(.7+z*.7)) + Math.random()*.08),
        sp: (.03+Math.random()*.10)*wf*(.5+z),       // 近快遠慢（視差）
        shape: isCb ? 4 : 0,
        puffs: isCb ? _genCbPuffs() : _genCloudPuffs(),   // 一般雲 / 積雨雲皆每朵獨立隨機（不重複、不對稱、不像動物）
        flip: Math.random() < .5 ? 1 : -1,
        z,
      };
    }).sort((a,b)=>a.z-b.z);
    // 風線（大風動畫用）：橫向掠過的氣流線，數量隨風速增加
    const nWind = Math.round(10 + 14 * Math.min(1, _wd.windSpeed / 40));
    windStreaks = Array.from({length:nWind}, () => ({
      x: Math.random()*W, y: Math.random()*H*0.82,
      len: 50+Math.random()*130, spd: 5+Math.random()*9,
      a: 0.05+Math.random()*0.10, bow: (Math.random()-.5)*10,
    }));
    leafP  = Array.from({length:42}, () => { const lf=_newLeaf(); lf.y=Math.random()*H; return lf; });
    petalP  = Array.from({length:38}, () => { const p=_newPetal(); p.y=Math.random()*H; return p; });
    mahjongP= Array.from({length:28}, () => { const p=_newMahjong(); p.y=Math.random()*H; return p; });
    shootTimer = 200+Math.floor(Math.random()*250);
    // ── 天然災害狀態 ──
    // 冰雹：帶景深，近大快、遠小慢
    hailP = Array.from({length: Math.round(40+60*ri)}, () => {
      const z = Math.random();
      return { x:Math.random()*W, y:Math.random()*H, z, r:2+z*z*5, spd:7+z*z*15, a:.5+z*.45 };
    }).sort((p,q)=>p.z-q.z);
    hailSplash = [];
    // 龍卷風：漏斗位置 + 旋轉碎屑
    tornadoX = W*0.5;
    tDebris = Array.from({length:48}, () => ({
      h: Math.random(), ang: Math.random()*Math.PI*2,
      spd: .10+Math.random()*.20, rise: .002+Math.random()*.004, sz: 1.4+Math.random()*3.2,
    }));
    // 地震：裂縫 / 落塵 / 計時
    qCracks = []; qDust = []; quakeT = 0;
  }

  /* ── cloud puff layouts (relative to baseY = cy + h*0.35) ──
     0: classic cumulus (高聳對稱)
     1: stratocumulus (寬扁延展)
     2: towering cumulus (中央雙峰高聳)
     3: small fluffy (小巧緊湊)            */
  const _CLOUD_VARIANTS = [
    [ // 0
      [-.40, -.18, .46],[-.20, -.50, .66],[.02, -.72, .78],
      [ .22, -.48, .62],[ .40, -.18, .46],[.02, -.20, .55],
    ],
    [ // 1
      [-.48, -.10, .42],[-.28, -.30, .55],[-.05, -.42, .58],
      [ .18, -.38, .54],[ .40, -.20, .48],[.50, -.05, .38],[-.05, -.05, .50],
    ],
    [ // 2
      [-.32, -.20, .48],[-.10, -.55, .65],[.08, -.78, .70],
      [ .26, -.55, .68],[ .42, -.20, .48],[-.18, -.05, .50],[ .20, -.05, .55],
    ],
    [ // 3
      [-.30, -.15, .52],[-.05, -.50, .68],[ .25, -.30, .58],[ .05, -.05, .52],
    ],
    [ // 4 積雨雲（對流雲）：高聳塔身 + 頂部砧狀外擴
      [-.46,-.92,.34],[-.20,-.97,.40],[.06,-.96,.40],[.32,-.92,.36],[.52,-.85,.30], // 砧頂
      [-.10,-.70,.50],[ .12,-.66,.48],
      [-.16,-.46,.54],[ .10,-.46,.54],
      [-.10,-.22,.58],[ .10,-.22,.56],
      [-.04,-.02,.60],[-.24,-.02,.50],[ .18,-.02,.52],                              // 塔底（雨幕起點）
    ],
  ];
  /* 程序化生成一朵「自然積雲」的凸起 [fx,fy,fr]。
     用「大量小 puff」沿一條平滑的圓鼓雲頂包絡密集填滿（同 _genCbPuffs 的思路）：
     少數大圓會形成離散的頭/耳/腳輪廓 → 像動物或怪形狀；密集小 puff 只剩連續起伏的
     雲面 → 自然蓬鬆、破除 pareidolia。主圓鼓位置/高度/微傾皆隨機 → 每朵不同、不對稱。 */
  function _genCloudPuffs() {
    const puffs = [];
    const lean  = (Math.random()-0.5)*0.12;            // 整朵微傾，破對稱
    const peak  = 0.40 + Math.random()*0.20;           // 主圓鼓位置（0左~1右）
    const peakH = 0.74 + Math.random()*0.26;           // 主圓鼓高度
    const cols  = 10 + Math.floor(Math.random()*4);    // 橫向取樣 10-13 柱
    for (let c=0;c<cols;c++){
      const t  = c/(cols-1);                           // 0..1
      const fx = -0.48 + t*0.96 + lean*(t-0.5);
      // 雲頂包絡：兩端平滑收斂(edge)、主圓鼓處加高(bump) → 蓬鬆圓鼓而非尖三角
      const edge = Math.max(0, 1 - Math.pow(Math.abs(t-0.5)*2, 1.8));
      const bump = 0.60 + 0.40*Math.max(0, 1 - Math.abs(t-peak)/0.42);
      const topH = peakH * edge * bump;
      const stack = 1 + Math.round(topH*3.4);          // 該柱由底到頂堆幾顆小 puff
      for (let s=0;s<stack;s++){
        const u  = stack>1 ? s/(stack-1) : 0;          // 0底~1頂
        const fy = -(topH*u) - 0.02 + (Math.random()-0.5)*0.045;
        const fr = 0.23 + Math.random()*0.08 + (1-u)*0.05;   // 小 puff、底略大
        puffs.push([fx + (Math.random()-0.5)*0.05, fy, fr]);
      }
    }
    const baseN = 4 + Math.floor(Math.random()*2);     // 拉平的雲底（cumulus 平底）
    for (let i=0;i<baseN;i++)
      puffs.push([-0.46 + Math.random()*0.92, 0.01 + Math.random()*0.05, 0.27 + Math.random()*0.08]);
    return puffs;
  }
  /* 程序化「積雨雲（cumulonimbus）」：用「大量小 puff」密集填滿『底寬→上窄→砧頂外擴』的塔狀輪廓，
     重疊成連續的花椰菜狀團塊（而非少數大圓）。少數大圓會形成離散的頭/耳/腳輪廓 → 像動物；
     密集小 puff 則只剩連續起伏的雲面，破除 pareidolia（不再像熊/動物）。每朵隨機、不對稱。 */
  function _genCbPuffs() {
    const puffs = [];
    const lean = (Math.random()-0.5)*0.18;             // 整座塔微傾（破對稱）
    const layers = 7 + Math.floor(Math.random()*3);    // 7-9 層密集堆疊
    for (let i=0;i<layers;i++){
      const t = i/(layers-1);                          // 0底 1頂
      // 寬度包絡：塔身往上漸窄、頂端砧狀向外擴（cumulonimbus 典型輪廓）
      const halfW = (t < 0.80) ? (0.52 - t*0.22) : (0.36 + (t-0.80)*1.7);
      const cxL = lean*t + (Math.random()-0.5)*0.06;
      const fy  = -0.02 - t*0.94;
      const per = 3 + Math.floor(Math.random()*3);     // 每層 3-5 顆小 puff 橫向散佈
      for (let j=0;j<per;j++){
        const fx = cxL + (Math.random()*2-1)*halfW;
        const py = fy + (Math.random()-0.5)*0.10;
        const fr = Math.max(0.12, (0.30 - t*0.13)*(0.78 + Math.random()*0.5));  // 小、上小下大
        puffs.push([fx, py, fr]);
      }
    }
    // 拉平的雲底（cumulus 平底）
    const baseN = 4 + Math.floor(Math.random()*2);
    for (let i=0;i<baseN;i++)
      puffs.push([(Math.random()*2-1)*0.48, 0.01 + Math.random()*0.05, 0.30 + Math.random()*0.10]);
    return puffs;
  }
  /* 不同形狀 + 翻轉 + 漸層的雲；shape===4 為積雨雲；depth(0遠~1近) 控制空氣透視；
     傳入 puffsOverride 則用該組凸起（程序化雲），否則用固定範本 */
  function _cloud(cx, cy, w, alpha, shape = 0, flip = 1, depth = 1, puffsOverride = null) {
    ctx.save();
    const conv = shape === 4;                 // 對流雲：高聳塔狀
    const h = w * (conv ? 0.82 : 0.42);
    const baseY = cy + h * 0.35;
    // 立體感：雲底下方一抹柔和暗影（體積/景深），先畫
    ctx.globalAlpha = alpha * 0.55;
    const sh = ctx.createRadialGradient(cx, baseY + h*0.16, 0, cx, baseY + h*0.16, w*0.5);
    sh.addColorStop(0, conv ? "rgba(38,46,64,.6)" : "rgba(64,84,116,.5)");
    sh.addColorStop(1, "rgba(64,84,116,0)");
    ctx.fillStyle = sh;
    ctx.beginPath(); ctx.ellipse(cx, baseY + h*0.18, w*0.5, h*0.34, 0, 0, Math.PI*2); ctx.fill();
    // 雲體
    ctx.globalAlpha = alpha;
    const puffs = puffsOverride || _CLOUD_VARIANTS[shape % _CLOUD_VARIANTS.length];
    ctx.beginPath();
    for (const [fx, fy, fr] of puffs) {
      const px = cx + fx * w * flip;
      const py = baseY + fy * h;
      const pr = h * fr;
      ctx.moveTo(px + pr, py);
      ctx.arc(px, py, pr, 0, Math.PI * 2);
    }
    const g = ctx.createLinearGradient(cx, cy - h*1.05, cx, baseY + h*.10);
    if (conv) {   // 對流雲：頂亮受光、底暗（雨幕），對比更強
      g.addColorStop(0.00, "rgba(248,250,255,.96)");
      g.addColorStop(0.40, "rgba(208,220,240,.92)");
      g.addColorStop(0.74, "rgba(148,166,196,.86)");
      g.addColorStop(1.00, "rgba(92,108,138,.74)");
    } else if (depth < 0.5) {   // 遠景雲：空氣透視 → 霧化藍灰、低對比（拉開景深）
      g.addColorStop(0.00, "rgba(208,219,235,.86)");
      g.addColorStop(0.55, "rgba(178,192,214,.68)");
      g.addColorStop(1.00, "rgba(150,166,190,.50)");
    } else {                    // 近景雲：明亮純白、高對比
      g.addColorStop(0.00, "rgba(255,255,255,.98)");
      g.addColorStop(0.42, "rgba(246,250,255,.94)");
      g.addColorStop(0.78, "rgba(206,224,242,.82)");
      g.addColorStop(1.00, "rgba(172,196,222,.60)");
    }
    ctx.fillStyle = g; ctx.fill();
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
    const nowMin = _locNowMin();
    const rise = _wd.sunRiseMin, set = _wd.sunSetMin;
    const prog = (rise === set) ? 0.5 : Math.max(0, Math.min(1, (nowMin-rise)/(set-rise)));
    const sx = W*0.04 + prog*(W*0.92);
    const sy = H*0.88 - (H*0.88-H*0.08)*Math.sin(prog*Math.PI);
    sunAngle += .0035;
    /* 晴朗度：雲量越高 → 陽光（光芒/光暈）越弱（有下限，不會完全消失） */
    const clr = Math.max(0, 1 - _wd.cloudCover/100), rk = .35 + .65*clr;
    /* background warm glow */
    const bg = ctx.createRadialGradient(sx,sy,0,sx,sy,W*.85);
    bg.addColorStop(0,'rgba(255,240,110,.38)'); bg.addColorStop(.45,'rgba(255,165,30,.11)'); bg.addColorStop(1,'rgba(0,0,0,0)');
    ctx.save(); ctx.globalAlpha=.45+.55*clr; ctx.fillStyle=bg; ctx.fillRect(0,0,W,H); ctx.restore();
    /* god rays（體積光束）：自太陽放射的寬柔光錐，緩慢飄、隨晴朗度增強（lighter 疊加發光） */
    ctx.save(); ctx.globalCompositeOperation='lighter'; ctx.translate(sx,sy);
    for (let i=0;i<7;i++){
      const a=sunAngle*0.5 + (i/7)*Math.PI*2 + Math.sin(t*0.18+i)*0.06;
      const len=W*(0.62+0.22*Math.sin(t*0.13+i*1.7)), wid=0.04+0.028*(i%3);
      const lg=ctx.createLinearGradient(0,0,Math.cos(a)*len,Math.sin(a)*len);
      lg.addColorStop(0,`rgba(255,242,185,${(0.07*rk).toFixed(3)})`); lg.addColorStop(1,'rgba(255,242,185,0)');
      ctx.fillStyle=lg; ctx.beginPath(); ctx.moveTo(0,0);
      ctx.lineTo(Math.cos(a-wid)*len, Math.sin(a-wid)*len);
      ctx.lineTo(Math.cos(a+wid)*len, Math.sin(a+wid)*len);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
    /* 10 rotating rays */
    ctx.save(); ctx.translate(sx,sy); ctx.lineCap="round";
    for (let i=0;i<10;i++) {
      const a=sunAngle+(i/10)*Math.PI*2, even=i%2===0;
      const len=W*(.28+.05*Math.sin(t*.7+i));
      ctx.strokeStyle=even?`rgba(255,230,80,${(.14*rk).toFixed(3)})`:`rgba(255,200,50,${(.07*rk).toFixed(3)})`;
      ctx.lineWidth=even?2.5:1.2;
      ctx.beginPath(); ctx.moveTo(Math.cos(a)*32,Math.sin(a)*32); ctx.lineTo(Math.cos(a)*len,Math.sin(a)*len); ctx.stroke();
    }
    ctx.restore();
    /* pulsing halo rings */
    [55,85,120].forEach((r,i) => {
      ctx.strokeStyle=`rgba(255,220,80,${((.20-i*.05)*rk).toFixed(3)})`; ctx.lineWidth=i===0?2.5:2;
      ctx.beginPath(); ctx.arc(sx,sy,r+Math.sin(t*1.1+i)*7,0,Math.PI*2); ctx.stroke();
    });
    /* sun disc */
    const disc = ctx.createRadialGradient(sx,sy,0,sx,sy,28);
    disc.addColorStop(0,'#FFFCD0'); disc.addColorStop(1,'#FFD700');
    ctx.shadowBlur=30; ctx.shadowColor="rgba(255,200,0,1)";
    ctx.fillStyle=disc; ctx.beginPath(); ctx.arc(sx,sy,28,0,Math.PI*2); ctx.fill();
    ctx.shadowBlur=0;
    /* 鏡頭光暈：沿「太陽→畫面中心」連線散布幾個半透明光點（電影感） */
    ctx.save(); ctx.globalCompositeOperation='lighter';
    const vx=W/2-sx, vy=H/2-sy;
    [[0.5,16,'255,220,140',0.10],[0.92,30,'170,215,255',0.07],[1.22,11,'255,182,200',0.08],[1.65,46,'190,255,210',0.045]].forEach(([d,r,col,al])=>{
      const fx=sx+vx*d, fy=sy+vy*d;
      const fg=ctx.createRadialGradient(fx,fy,0,fx,fy,r);
      fg.addColorStop(0,`rgba(${col},${(al*rk).toFixed(3)})`); fg.addColorStop(1,`rgba(${col},0)`);
      ctx.fillStyle=fg; ctx.beginPath(); ctx.arc(fx,fy,r,0,Math.PI*2); ctx.fill();
    });
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
    /* clouds — draw on top of sun when cloud cover > 0 */
    if (_wd.cloudCover > 5) dCloudy(t);
  }

  function dNight(t) {
    /* nebula blobs (cached gradients) */
    _gc.nebula.forEach(g => { ctx.fillStyle=g; ctx.fillRect(0,0,W,H); });
    /* twinkling stars */
    stars.forEach(p => {
      const a=.15+.75*Math.sin(t*p.sp+p.ph);
      if (a>.88 && !_lowFx) { ctx.shadowBlur=5; ctx.shadowColor="rgba(200,220,255,.9)"; }
      ctx.fillStyle=`rgba(222,232,255,${a})`;
      ctx.beginPath(); ctx.arc(p.x,p.y,a>.6?p.r*1.3:p.r,0,Math.PI*2); ctx.fill(); ctx.shadowBlur=0;   // 星星固定，不隨滑鼠晃
    });
    /* 八大行星（依實際位置/亮度/顏色，無標籤） */
    _drawPlanets(t);
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
    /* 月亮改由 _drawAstro 畫（比例制升落弧線：會隨時間移動、跨裝置一致），這裡不再畫 */
  }

  function dCloudy(t) {
    const cdir = _windVecX() >= 0 ? 1 : -1;       // 雲飄移方向跟著風（+右 -左）
    const margin = W*0.6;
    cloudP.forEach((c, i) => {
      c.x += c.sp * cdir;
      if (cdir > 0 && c.x - W*c.sc > W) c.x = -margin;       // 往右飄出 → 從左回來
      else if (cdir < 0 && c.x + W*c.sc < 0) c.x = W+margin; // 往左飄出 → 從右回來
      _cloud(c.x, c.y + Math.sin(t*.18 + i*1.3)*3.5, W*c.sc, c.al, c.shape, c.flip, c.z, c.puffs);
    });
  }

  function dFog(t) {
    /* 體積霧：多顆大柔邊橢圓霧團，依景深以不同速度飄移 + 緩慢 billow + 視差 → 立體霧氣感 */
    fogBlobs.forEach(b => {
      b.x += b.sp * (0.5 + b.z);                         // 近的飄快
      if (b.sp>0 && b.x-b.rx>W) b.x=-b.rx; else if (b.sp<0 && b.x+b.rx<0) b.x=W+b.rx;
      const cxx = b.x, cyy = b.y + Math.sin(t*0.2+b.ph)*H*0.025;
      const g=ctx.createRadialGradient(cxx,cyy,0,cxx,cyy,b.rx);
      g.addColorStop(0,`rgba(198,213,233,${b.a})`); g.addColorStop(.65,`rgba(190,206,228,${(b.a*.55).toFixed(3)})`); g.addColorStop(1,'rgba(190,206,228,0)');
      ctx.save(); ctx.translate(cxx,cyy); ctx.scale(1, b.ry/b.rx); ctx.fillStyle=g;
      ctx.beginPath(); ctx.arc(0,0,b.rx,0,Math.PI*2); ctx.fill(); ctx.restore();
    });
    ctx.fillStyle=_gc.fogVg; ctx.fillRect(0,0,W,H);   // 整體霧化 vignette（cached）
  }

  function dRain(t) {
    /* 雨勢漸起：開始下雨時 _rainRamp 由 0 緩升到 1（約 6 秒），再疊一層輕微強弱起伏 → 雨會「漸漸下大」 */
    _rainRamp += (1 - _rainRamp) * 0.012;
    const intensity = _rainRamp * (0.84 + 0.16*Math.sin((t||0)*0.3));
    /* stormy sky overlay (cached gradient) — 天色隨雨勢加深 */
    ctx.save(); ctx.globalAlpha = 0.35 + 0.65*intensity; ctx.fillStyle=_gc.rainSky; ctx.fillRect(0,0,W,H); ctx.restore();

    ctx.lineCap="round";
    const wDrift = _windDriftPx();                 // 風向水平位移（+右 -左），隨風速
    const lean   = _windVecX() * (0.10 + _wd.windSpeed*0.012);  // 雨絲傾斜度（隨風向/風速）
    let blurOn = false;                             // 已排序：近景在最後 → 只需切一次 shadowBlur
    rainP.forEach(p => {
      const n = p.z>0.55;                           // 近景
      const pa = p.a * intensity;                   // 透明度隨雨勢漸起
      if (p.z>0.92 && !blurOn && !_lowFx) { ctx.shadowBlur=3; ctx.shadowColor="rgba(200,228,255,.55)"; blurOn=true; }  // 最近景柔焦
      ctx.strokeStyle = n?`rgba(200,232,255,${pa})`:`rgba(130,176,224,${pa})`;
      ctx.lineWidth = p.w;                          // 線寬隨景深（近粗遠細）
      const ox=_parX(p.z), oy=_parY(p.z);           // 視差位移（近景滑動大）
      ctx.beginPath(); ctx.moveTo(p.x+ox,p.y+oy); ctx.lineTo(p.x+ox + lean*p.len, p.y+oy+p.len); ctx.stroke();
      p.y += p.spd; p.x += wDrift*(0.4+p.z);        // 近景水平位移大（視差）；方向跟著風
      if (p.y>H+p.len) {
        if (n && ripples.length<45 && Math.random()<intensity)   // 雨勢越大、漣漪/水花越多
          ripples.push({x:p.x, y:H*.968, r:0, maxR:6+Math.random()*13*p.z, a:.30*p.z+.14});
        if (p.z>0.7 && splashes.length<70 && Math.random()<intensity) {  // 近景大雨滴落地 → 向上濺起小水花
          const cnt = 2+Math.floor(Math.random()*2);
          for (let k=0;k<cnt;k++){
            const ang=-Math.PI/2 + (Math.random()-0.5)*1.15, sp=1.4+Math.random()*2.6*p.z;
            splashes.push({ x:p.x, y:H*.963, vx:Math.cos(ang)*sp, vy:Math.sin(ang)*sp, life:0, max:9+Math.random()*8, a:.55*p.z });
          }
        }
        p.y=-p.len; p.x=Math.random()*(W+60)-30;
      }
    });
    if (blurOn) ctx.shadowBlur=0;

    /* puddle ripple rings */
    for (let i=ripples.length-1;i>=0;i--) {
      const rp=ripples[i];
      ctx.strokeStyle=`rgba(165,215,255,${rp.a})`; ctx.lineWidth=.8;
      ctx.beginPath(); ctx.ellipse(rp.x,rp.y,rp.r,rp.r*.28,0,0,Math.PI*2); ctx.stroke();
      rp.r+=.85; rp.a-=.026;
      if (rp.a<=0) ripples.splice(i,1);
    }

    /* 落地濺起的小水花（重力拋物線） */
    for (let i=splashes.length-1;i>=0;i--) {
      const s=splashes[i]; s.life++; s.vy+=0.22; s.x+=s.vx; s.y+=s.vy;
      const al=s.a*(1-s.life/s.max);
      if (al<=0 || s.life>=s.max) { splashes.splice(i,1); continue; }
      ctx.fillStyle=`rgba(205,230,255,${al.toFixed(3)})`;
      ctx.beginPath(); ctx.arc(s.x,s.y,1.1,0,Math.PI*2); ctx.fill();
    }

    /* wet ground sheen + bottom mist（cached）— 隨雨勢漸起 */
    ctx.save(); ctx.globalAlpha = intensity;
    ctx.fillStyle=_gc.rainGnd; ctx.fillRect(0,H*.88,W,H*.12);
    ctx.fillStyle=_gc.rainMist; ctx.fillRect(0,H*.62,W,H*.38);
    ctx.restore();

    /* 前景玻璃水珠（隔窗看雨）：最近平面 → 視差最大、偶爾滑落留痕；隨雨勢漸起浮現 */
    const gx=_parX(1), gy=_parY(1); ctx.lineCap="round";
    ctx.save(); ctx.globalAlpha = Math.min(1, intensity*1.15);
    glassDrops.forEach(d => {
      d.age++;
      if (!d.slide && d.age>d.slideAt) d.slide=true;
      if (d.slide) {
        d.vy += 0.06; d.y += d.vy;
        ctx.strokeStyle='rgba(205,228,255,0.10)'; ctx.lineWidth=d.r*0.5;
        ctx.beginPath(); ctx.moveTo(d.x+gx, d.y+gy-d.vy*5); ctx.lineTo(d.x+gx, d.y+gy); ctx.stroke();
        if (d.y>H+d.r) { d.x=Math.random()*W; d.y=-d.r; d.vy=0; d.slide=false; d.age=0; d.slideAt=160+Math.random()*640; }
      }
      const dx=d.x+gx, dy=d.y+gy;
      const g=ctx.createRadialGradient(dx-d.r*0.3, dy-d.r*0.35, d.r*0.1, dx, dy, d.r);
      g.addColorStop(0,'rgba(228,242,255,0.40)'); g.addColorStop(0.6,'rgba(150,186,226,0.16)'); g.addColorStop(1,'rgba(120,160,210,0.03)');
      ctx.fillStyle=g; ctx.beginPath(); ctx.arc(dx,dy,d.r,0,Math.PI*2); ctx.fill();
      ctx.fillStyle='rgba(255,255,255,0.45)'; ctx.beginPath(); ctx.arc(dx-d.r*0.32, dy-d.r*0.36, d.r*0.2, 0, Math.PI*2); ctx.fill();
    });
    ctx.restore();
  }

  function dSnow(t) {
    const wDrift = _windDriftPx();
    snowP.forEach(p => {
      const ox=_parX(p.z), oy=_parY(p.z);           // 視差位移（近景滑動大）
      const dx=p.x+ox, dy=p.y+oy;
      if (p.r < 2.6) {
        // 遠景雪：簡單柔光點（也省效能，遠處本就看不出結晶）
        ctx.fillStyle=`rgba(226,240,255,${p.a*.72})`;
        ctx.beginPath(); ctx.arc(dx,dy,p.r*.62,0,Math.PI*2); ctx.fill();
      } else {
        if (p.z>0.85 && !_lowFx) { ctx.shadowBlur=4; ctx.shadowColor="rgba(220,238,255,.6)"; }   // 近景結晶柔光
        _snowflake(dx,dy,p.r,p.rot,p.a);
        if (p.z>0.85) ctx.shadowBlur=0;
      }
      // 近景飄擺幅度大（視差）；水平方向跟著風
      p.y += p.spd; p.x += p.drift + Math.sin(t*.5+p.x*.01)*.3*(.5+p.z) + wDrift*(.5+p.z)*.5; p.rot += p.rotSpd;
      if (p.y>H+p.r*2) { p.y=-p.r*2; p.x=Math.random()*W; }
      if (p.x<-10) p.x=W+10; if (p.x>W+10) p.x=-10;
    });
    ctx.fillStyle=_gc.snowAtm; ctx.fillRect(0,0,W,H*.35);
    /* 底部積雪堆積：隨時間緩慢增厚（封頂），起伏雪丘頂緣 + 受光緣 */
    snowAccum = Math.min(H*0.065, snowAccum + 0.045);
    if (snowAccum > 1) {
      const baseY = H - snowAccum;
      ctx.save();
      ctx.beginPath(); ctx.moveTo(0, H);
      ctx.lineTo(0, baseY - 4*Math.sin(0.7));
      for (let x=0; x<=W; x+=W/22){
        const yy = baseY - 5 - 6*Math.sin(x*0.012 + 0.6) - 3*Math.sin(x*0.05);   // 起伏雪丘
        ctx.lineTo(x, yy);
      }
      ctx.lineTo(W, H); ctx.closePath();
      const sg=ctx.createLinearGradient(0, baseY-12, 0, H);
      sg.addColorStop(0,'rgba(246,251,255,0.97)'); sg.addColorStop(1,'rgba(214,228,245,0.9)');
      ctx.fillStyle=sg; ctx.fill();
      ctx.restore();
    }
  }

  function dStorm() {
    /* heavy angled rain — 傾斜方向跟著風（風強傾斜大） */
    const sdx = _windVecX()*(3 + _wd.windSpeed*0.06);
    rainP.forEach(p => {
      ctx.strokeStyle=`rgba(130,180,255,${p.a*.75})`; ctx.lineWidth=1;
      ctx.beginPath(); ctx.moveTo(p.x,p.y); ctx.lineTo(p.x+sdx*0.8,p.y+p.len*1.3); ctx.stroke();
      p.y+=p.spd*1.6; p.x+=sdx*0.5;
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
    /* very heavy angled rain — 傾斜方向跟著風 */
    const wvx = _windVecX();
    rainP.forEach(p => {
      ctx.strokeStyle=`rgba(160,215,255,${p.a*.85})`; ctx.lineWidth=p.a>.38?1.8:1.1;
      ctx.beginPath(); ctx.moveTo(p.x,p.y); ctx.lineTo(p.x+wvx*p.len*.6,p.y+p.len*2.0); ctx.stroke();
      p.y+=p.spd*2.4; p.x+=wvx*p.len*.32;
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

  /* ══════════════ 天然災害 ══════════════ */

  /* ── 冰雹：白色冰球高速砸落 + 落地彈跳濺起（帶景深）── */
  function dHail(t) {
    ctx.fillStyle="rgba(40,55,80,.20)"; ctx.fillRect(0,0,W,H);   // 陰沉天幕
    const wDrift=_windDriftPx(), gndY=H*.94;
    let blurOn=false;
    hailP.forEach(p => {
      if (p.z>0.9 && !blurOn && !_lowFx) { ctx.shadowBlur=4; ctx.shadowColor="rgba(220,238,255,.6)"; blurOn=true; }  // 近景柔焦
      ctx.fillStyle=`rgba(232,243,255,${p.a})`;
      ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,Math.PI*2); ctx.fill();
      ctx.fillStyle=`rgba(255,255,255,${Math.min(1,p.a+.25)})`;       // 上方高光
      ctx.beginPath(); ctx.arc(p.x-p.r*.32,p.y-p.r*.32,p.r*.42,0,Math.PI*2); ctx.fill();
      p.y+=p.spd; p.x+=wDrift*(0.5+p.z);
      if (p.y>gndY) {
        if (p.z>0.45 && hailSplash.length<70)
          for (let k=0;k<2;k++) hailSplash.push({x:p.x,y:gndY,r:p.r*.6,vx:(Math.random()-.5)*5,vy:-(2+Math.random()*4)*p.z,a:.8});
        p.y=-p.r; p.x=Math.random()*W;
      }
    });
    if (blurOn) ctx.shadowBlur=0;
    for (let i=hailSplash.length-1;i>=0;i--){
      const s=hailSplash[i];
      ctx.fillStyle=`rgba(226,241,255,${s.a})`;
      ctx.beginPath(); ctx.arc(s.x,s.y,s.r,0,Math.PI*2); ctx.fill();
      s.x+=s.vx; s.y+=s.vy; s.vy+=.55; s.a-=.045;
      if (s.a<=0||s.y>gndY+5) hailSplash.splice(i,1);
    }
    ctx.fillStyle="rgba(222,236,255,.05)"; ctx.fillRect(0,gndY,W,H-gndY);  // 地面薄白堆積
  }

  /* ── 龍卷風：旋轉漏斗雲 + 螺旋上升碎屑 + 底部塵爆（隨風水平移動）── */
  function dTornado(t) {
    ctx.fillStyle="rgba(42,44,56,.32)"; ctx.fillRect(0,0,W,H);     // 暗天幕
    tornadoX += _windVecX()*0.5;                                   // 隨風緩慢橫移
    if (tornadoX<W*0.2) tornadoX=W*0.2; if (tornadoX>W*0.8) tornadoX=W*0.8;
    const xc=tornadoX, topY=H*0.05, botY=H*0.88, topR=W*0.15, botR=W*0.018;
    const Rat=h=>topR+(botR-topR)*h, Yat=h=>topY+(botY-topY)*h;
    const Xat=h=>xc+Math.sin(h*7+t*2.4)*Rat(h)*0.32;              // 漏斗本身的擺動
    // 頂部風暴雲
    ctx.save(); ctx.fillStyle="rgba(54,58,74,.62)";
    ctx.beginPath(); ctx.ellipse(xc, topY+H*0.025, topR*1.5, H*0.06, 0,0,Math.PI*2); ctx.fill(); ctx.restore();
    // 漏斗填色（兩側收斂）
    ctx.beginPath();
    for (let h=0;h<=1.0001;h+=0.05){ const x=Xat(h)-Rat(h)*0.5, y=Yat(h); h===0?ctx.moveTo(x,y):ctx.lineTo(x,y); }
    for (let h=1;h>=-0.0001;h-=0.05){ ctx.lineTo(Xat(h)+Rat(h)*0.5, Yat(h)); }
    ctx.closePath();
    const fg=ctx.createLinearGradient(xc-topR,0,xc+topR,0);
    fg.addColorStop(0,"rgba(70,74,90,.32)"); fg.addColorStop(.5,"rgba(124,128,144,.58)"); fg.addColorStop(1,"rgba(70,74,90,.32)");
    ctx.fillStyle=fg; ctx.fill();
    // 旋轉條帶（barber-pole）
    ctx.lineCap="round";
    for (let b=0;b<5;b++){
      const phase=b/5*Math.PI*2;
      ctx.strokeStyle=`rgba(158,162,178,${(.10+.05*b).toFixed(3)})`; ctx.lineWidth=2;
      ctx.beginPath();
      for (let h=0;h<=1.0001;h+=0.04){ const x=Xat(h)+Math.sin(h*9+t*3+phase)*Rat(h)*0.5, y=Yat(h); h===0?ctx.moveTo(x,y):ctx.lineTo(x,y); }
      ctx.stroke();
    }
    // 螺旋上升碎屑
    tDebris.forEach(d=>{
      d.ang+=d.spd; d.h-=d.rise; if(d.h<0){ d.h=1; d.ang=Math.random()*Math.PI*2; }
      const R=Rat(d.h), x=Xat(d.h)+Math.cos(d.ang)*R*0.55, y=Yat(d.h)+Math.sin(d.ang)*R*0.12;
      ctx.fillStyle=Math.sin(d.ang)>0?"rgba(92,86,74,.85)":"rgba(60,56,50,.5)";   // 前側亮、後側暗
      ctx.beginPath(); ctx.arc(x,y,d.sz,0,Math.PI*2); ctx.fill();
    });
    // 底部塵爆
    ctx.save();
    const dust=ctx.createRadialGradient(xc,botY,0,xc,botY,W*0.13);
    dust.addColorStop(0,"rgba(122,112,96,.48)"); dust.addColorStop(1,"rgba(122,112,96,0)");
    ctx.fillStyle=dust; ctx.beginPath(); ctx.ellipse(xc,botY,W*0.13,H*0.055,0,0,Math.PI*2); ctx.fill(); ctx.restore();
  }

  /* ── 地震：背景層震動 + 地面裂縫蔓延 + 落塵（不影響交易 UI）── */
  function dQuake(t) {
    quakeT += 1;
    // 地震波：持續微震 + 陣發強震（不會整段靜止 → 一直感覺得到在搖）
    const burst = 0.34 + 0.66*Math.max(0, Math.sin(quakeT*0.045));
    const wave = burst * (0.7 + 0.3*Math.abs(Math.sin(quakeT*0.33)));   // ~0.24..1
    const mag = wave*6, gndY=H*0.84;
    // 震動整個畫面（UI 跟著晃 → 真正的地震感）
    const sk = 6 + wave*12;   // 振幅 6~18px
    document.body.style.transform =
      `translate(${((Math.random()-.5)*sk).toFixed(1)}px, ${((Math.random()-.5)*sk*0.7).toFixed(1)}px)`;
    ctx.fillStyle=`rgba(92,42,30,${(0.05+0.13*wave).toFixed(3)})`; ctx.fillRect(0,0,W,H);   // 紅褐警示脈動
    ctx.save();
    ctx.translate((Math.random()-.5)*mag, (Math.random()-.5)*mag);   // 背景層再加細微晃（地面/裂縫/落塵）
    ctx.fillStyle="rgba(45,38,32,.5)"; ctx.fillRect(-30,gndY,W+60,H-gndY+60);   // 地面帶
    if (wave>0.5 && Math.random()<0.05 && qCracks.length<9) {        // 強震時偶爾新裂縫
      let cx=Math.random()*W, cy=gndY; const seg=[[cx,cy]];
      const n=4+Math.floor(Math.random()*4);
      for(let i=0;i<n;i++){ cx+=(Math.random()-.5)*64; cy+=18+Math.random()*30; seg.push([cx,cy]); }
      qCracks.push({pts:seg, a:1});
    }
    for(let i=qCracks.length-1;i>=0;i--){
      const c=qCracks[i];
      ctx.lineCap="round"; ctx.lineJoin="round";
      ctx.strokeStyle=`rgba(18,14,12,${c.a})`; ctx.lineWidth=2.6;
      ctx.beginPath(); ctx.moveTo(c.pts[0][0],c.pts[0][1]); c.pts.slice(1).forEach(([x,y])=>ctx.lineTo(x,y)); ctx.stroke();
      ctx.strokeStyle=`rgba(132,66,44,${(c.a*0.5).toFixed(3)})`; ctx.lineWidth=1; ctx.stroke();   // 內側暖光
      c.a-=0.004; if(c.a<=0) qCracks.splice(i,1);
    }
    if (wave>0.3 && qDust.length<90 && Math.random()<0.6)
      qDust.push({x:Math.random()*W,y:-5,vx:(Math.random()-.5)*1.6,vy:1+Math.random()*2.2,a:.4+Math.random()*.4,r:.6+Math.random()*1.9});
    for(let i=qDust.length-1;i>=0;i--){
      const d=qDust[i];
      ctx.fillStyle=`rgba(150,135,115,${d.a.toFixed(3)})`;
      ctx.beginPath(); ctx.arc(d.x,d.y,d.r,0,Math.PI*2); ctx.fill();
      d.x+=d.vx; d.y+=d.vy; d.a-=0.004;
      if(d.y>H||d.a<=0) qDust.splice(i,1);
    }
    ctx.restore();
  }

  /* ── 麻將牌飄落 ── */
  function dMahjong() {
    const len = mahjongP.length;
    for (let i = 0; i < len; i++) {
      const p = mahjongP[i];
      p.swing += p.swingSpd;
      p.x += p.vx + Math.sin(p.swing) * .55;
      p.y += p.vy;
      p.rot += p.rotV;
      if (p.y > H+55 || p.x < -60 || p.x > W+60) { mahjongP[i] = _newMahjong(); continue; }
      const img = _getTileImg(p.sym);
      const cs = Math.cos(p.rot), sn = Math.sin(p.rot);
      // setTransform 一次到位，省下每張牌兩次 save/restore（28 張 × 60fps = 3360 次/秒）
      ctx.setTransform(cs, sn, -sn, cs, p.x, p.y);
      ctx.globalAlpha = p.a;
      ctx.drawImage(img, -img.width/2, -img.height/2);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
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

  /* ── 晴時多雲：白天太陽+雲；夜間只畫雲（月亮交給 _drawAstro）── */
  function dPartly(t) {
    if (_wd.isDay) {
      dSunny(t);                     // dSunny 內含 cloudCover>5 時畫雲
      if (_wd.cloudCover <= 5) dCloudy(t);   // 雲量太低也保證有幾朵雲飄過
    } else {
      dCloudy(t);                    // 夜間多雲：畫雲，月亮由 _drawAstro 畫（會穿雲）
    }
  }

  /* ── 陰天/密雲：全灰滿雲、無太陽（比 cloudy 更暗更密）── */
  function dOvercast(t) {
    ctx.fillStyle = "rgba(150,160,176,.30)"; ctx.fillRect(0,0,W,H);   // 灰天幕
    const cdir = _windVecX() >= 0 ? 1 : -1, margin = W*0.6;
    cloudP.forEach((c, i) => {
      c.x += c.sp * cdir;
      if (cdir > 0 && c.x - W*c.sc > W) c.x = -margin;
      else if (cdir < 0 && c.x + W*c.sc < 0) c.x = W+margin;
      // 雲更大、更不透明 → 密雲感
      _cloud(c.x, c.y + Math.sin(t*.14 + i*1.1)*3, W*c.sc*1.18,
             Math.min(.92, c.al + .28), c.shape, c.flip, 1, c.puffs);
    });
    ctx.fillStyle = "rgba(118,128,144,.16)"; ctx.fillRect(0,0,W,H);   // 再壓一層暗
  }

  /* ── 毛毛雨/微雨：稀疏細小雨絲、無漣漪無暴風天幕（比 rain 輕很多）── */
  function dDrizzle() {
    ctx.fillStyle = "rgba(150,165,186,.13)"; ctx.fillRect(0,0,W,H);   // 淡灰濛
    ctx.lineCap = "round";
    const lean = _windVecX()*.10, wd = _windDriftPx()*.5;   // 傾斜/飄移跟著風
    rainP.forEach(p => {
      if (p.a > 0.30) return;        // 只畫細雨絲，跳過大雨滴
      ctx.strokeStyle = `rgba(176,204,232,${(p.a*0.7).toFixed(3)})`;
      ctx.lineWidth = .5;
      ctx.beginPath(); ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + lean*p.len, p.y + p.len*.55); ctx.stroke();
      p.y += p.spd*.55; p.x += wd;
      if (p.y > H + p.len) { p.y = -p.len; p.x = Math.random()*W; }
    });
  }

  /* ── 大風：快速飄移的雲 + 橫向掠過的氣流線 ── */
  function dWindy(t) {
    const cdir = _windVecX() >= 0 ? 1 : -1, margin = W*0.6;
    cloudP.forEach((c, i) => {
      c.x += c.sp * 3.4 * cdir;      // 雲跑很快、方向跟著風
      if (cdir > 0 && c.x - W*c.sc > W) c.x = -margin;
      else if (cdir < 0 && c.x + W*c.sc < 0) c.x = W+margin;
      _cloud(c.x, c.y + Math.sin(t*.32 + i)*2, W*c.sc, c.al, c.shape, c.flip, c.z, c.puffs);
    });
    ctx.strokeStyle = "rgba(224,232,246,.10)"; ctx.lineWidth = 1.2; ctx.lineCap = "round";
    windStreaks.forEach(s => {
      ctx.globalAlpha = s.a * 6;     // a 0.05~0.15 → 0.3~0.9
      const L = s.len * cdir;        // 氣流線朝風向延伸/掠過
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.bezierCurveTo(s.x + L*.4, s.y - s.bow, s.x + L*.6, s.y + s.bow, s.x + L, s.y);
      ctx.stroke();
      s.x += s.spd * cdir;
      if (cdir > 0 && s.x > W + s.len) { s.x = -s.len; s.y = Math.random()*H*0.82; }
      else if (cdir < 0 && s.x < -s.len) { s.x = W + s.len; s.y = Math.random()*H*0.82; }
    });
    ctx.globalAlpha = 1;
  }

  /* ═══════════════ 新天氣：極光 / 晚霞 / 流星雨 ═══════════════ */

  /* 🌌 極光：上半夜空加暗讓綠光跳出 + 整體底光暈 + 3 層綠/青/紫垂直光簾（lighter 發光、波動飄移） */
  function dAurora(t) {
    // 上半部夜空加暗（向下淡出、不蓋到城堡）→ 提高極光對比
    const nb=ctx.createLinearGradient(0,0,0,H*0.62);
    nb.addColorStop(0,'rgba(6,12,28,0.62)'); nb.addColorStop(1,'rgba(6,12,28,0)');
    ctx.fillStyle=nb; ctx.fillRect(0,0,W,H*0.62);
    stars.forEach(p => {                                   // 夜空微星（固定，不隨滑鼠）
      const a=.12+.5*Math.sin(t*p.sp+p.ph);
      ctx.fillStyle=`rgba(205,225,255,${(a*.6).toFixed(3)})`;
      ctx.beginPath(); ctx.arc(p.x, p.y*.72, p.r*.7, 0, 6.28); ctx.fill();
    });
    ctx.save(); ctx.globalCompositeOperation='lighter';
    const cols=[[110,255,165],[70,215,205],[150,110,255]];   // 綠 / 青 / 紫
    auroraBands.forEach((b,ci) => {
      const col=cols[ci%cols.length];
      const drift = (((t*b.drift*30) % (W+200)) - 100);
      // ⚡每幀每 band 只建「一條」垂直漸層（原本每根光簾各建一條 → ~110/幀降到 3/幀）
      const top = H*0.02, bot = H*0.02 + b.h*1.15;
      const g=ctx.createLinearGradient(0, top, 0, bot);
      g.addColorStop(0,`rgba(${col},0)`);
      g.addColorStop(0.40,`rgba(${col},${(0.12*b.a).toFixed(3)})`);
      g.addColorStop(0.80,`rgba(${col},${(0.28*b.a).toFixed(3)})`);
      g.addColorStop(1,`rgba(${col},0)`);
      ctx.fillStyle=g;
      ctx.fillRect(0, top, W, bot-top);            // 整片底光暈
      for (let i=0;i<b.rays;i++) {                  // 垂直光簾（共用同一條漸層，免逐根建立）
        const rx = (((i*b.spacing + drift) % (W+200)) - 100) + Math.sin(t*b.sp + i*0.45 + b.ph)*16;
        const topY = top + Math.sin(t*b.sp*0.6 + i*0.35 + b.ph)*H*0.05;
        const h = b.h*(0.72 + 0.28*Math.sin(t*1.1 + i*0.7));
        ctx.fillRect(rx, topY, b.rayW, h);
      }
    });
    ctx.restore();
  }

  /* 晚霞用的背光雲：暗剪影 + 暖色受光頂緣 */
  function _sunsetCloud(cx, cy, w, flip, puffs) {
    const h=w*0.42;
    ctx.save();
    ctx.beginPath();
    for (const [fx,fy,fr] of (puffs || _CLOUD_VARIANTS[0])) {
      const px=cx+fx*w*flip, py=cy+fy*h, pr=h*fr;
      ctx.moveTo(px+pr,py); ctx.arc(px,py,pr,0,Math.PI*2);
    }
    ctx.fillStyle='rgba(58,40,56,0.5)'; ctx.fill();              // 暗剪影
    const rim=ctx.createLinearGradient(cx,cy-h,cx,cy+h*0.2);     // 頂緣暖光
    rim.addColorStop(0,'rgba(255,190,120,0.5)'); rim.addColorStop(0.4,'rgba(255,150,90,0.12)'); rim.addColorStop(1,'rgba(0,0,0,0)');
    ctx.globalCompositeOperation='lighter'; ctx.fillStyle=rim; ctx.fill();
    ctx.restore();
  }

  /* 🌅 晚霞：靛→紫→橘→暖黃天空漸層 + 太陽「隨真實時間」沉入地平線下 + 背光雲 + 初現星
     配色已調淡（降彩度、降輝光 alpha）；太陽依當前時刻相對真實日落時間下降、過地平線後被遮住。*/
  function dSunset(t) {
    // ── 太陽位置：依「真實時間」對齊真實日落，以真實速度緩緩下沉（逐幀平滑、sub-second 精度）──
    // 日落視窗 ±45min：set-45min → 高掛(prog0)、真實日落時刻 set → 觸地平線(prog0.5)、
    // set+45min → 沒入地平線下(prog1)。用秒+毫秒精度算 → 不是每分鐘跳一格，而是每一幀都在動。
    const nowMinF=_locNowMin();                             // 當地時間（依經度），切外國也準
    const setMin=(_wd.sunSetMin!=null)?_wd.sunSetMin:1080;
    let prog=(nowMinF-(setMin-45))/90; prog=Math.max(0,Math.min(1,prog));
    // 夜化係數 nf：日落時刻(prog0.5)之後天空逐漸轉夜色，prog1（視窗結束→交棒給 dNight）已是深夜藍
    // → 與「夜晚」無縫銜接，不再硬切。暖輝/暖霾/背光雲也隨 nf 淡出。
    const _e=Math.max(0,Math.min(1,(prog-0.5)/0.5)); const nf=_e*_e*(3-2*_e);
    const _wf=1-nf;                                         // 暖色保留比例
    const horizonY=H;                                       // 地平線＝螢幕最下緣（太陽落到螢幕下緣才沒入）
    const sx=W*0.5;                                          // 固定置中（真實落日不左右晃，移除原本的水平擺動）
    const sy=H*0.40+(H*1.60-H*0.40)*prog, R=54;             // 由高漸降；真實日落(prog0.5)正好觸螢幕下緣、之後沉到螢幕外

    // 天空漸層：晚霞色 → 深夜藍（隨 nf 混色，鍵 H+nf 量化階以維持快取）；地平線暖霾只跟 H 有關
    const nfStep=Math.round(nf*16);
    if (_ssGrad.h!==H || _ssGrad.nfStep!==nfStep) {
      _ssGrad.h=H; _ssGrad.nfStep=nfStep;
      const k=nfStep/16;
      const SS=['#3A3358','#6B5A7C','#B98A92','#E3AE86','#F2D6A6'];   // 晚霞：柔靛→霧紫→灰玫瑰→柔橘→淡暖黃
      const NT=['#0C0C18','#12111E','#171425','#1C1828','#221C2C'];   // 深夜藍目標
      const stops=[0,0.34,0.60,0.80,1];
      const sky=ctx.createLinearGradient(0,0,0,H);
      stops.forEach((p,i)=>sky.addColorStop(p,_hexLerp(SS[i],NT[i],k)));
      _ssGrad.sky=sky;
    }
    if (_ssGrad.hzH!==H) {
      const hzTop=H*0.78;
      const hz=ctx.createLinearGradient(0,hzTop,0,H);
      hz.addColorStop(0,'rgba(255,188,128,0)'); hz.addColorStop(0.6,'rgba(255,182,120,0.10)'); hz.addColorStop(1,'rgba(252,174,112,0.20)');
      _ssGrad.hz=hz; _ssGrad.hzTop=hzTop; _ssGrad.hzH=H;
    }
    ctx.fillStyle=_ssGrad.sky; ctx.fillRect(0,0,W,H);
    // ── 星星：太陽越往下沉、天越暗 → 星星越多越亮（隨 prog 漸現）──
    // 亮度與可見天區都隨 prog 增加：prog0(日落前)幾乎看不到 → prog1(沉入後)滿天星。
    const starLit=Math.max(0, prog*prog);                   // 平方 → 前段更暗、後段才明顯冒出
    if (starLit > 0.01) {
      const skyLimit=H*(0.36+0.30*prog);                    // 越暗、星星往下鋪越廣
      stars.forEach(p => {
        if (p.y < skyLimit) {
          const tw=.45+.55*Math.sin(t*p.sp+p.ph);           // 閃爍
          const a=tw*starLit*0.9;
          if (a < 0.02) return;
          ctx.fillStyle=`rgba(255,255,245,${a.toFixed(3)})`;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r*(0.6+0.5*prog), 0, 6.28); ctx.fill();
        }
      });
    }
    ctx.save(); ctx.globalCompositeOperation='lighter'; ctx.globalAlpha=_wf;   // 暖輝隨夜化淡出
    // 大範圍天空暖輝（整片柔暖，alpha 調淡）
    const hg=ctx.createRadialGradient(sx,sy,0,sx,sy,W*0.68);
    hg.addColorStop(0,'rgba(255,206,140,0.22)'); hg.addColorStop(0.4,'rgba(255,160,100,0.08)'); hg.addColorStop(1,'rgba(255,130,90,0)');
    ctx.fillStyle=hg; ctx.fillRect(0,0,W,H);
    ctx.restore();
    // ── 太陽本體與光暈：裁切在地平線以上 → 下沉時被地平線遮住，像真的落下 ──
    ctx.save();
    ctx.beginPath(); ctx.rect(0,0,W,horizonY); ctx.clip();
    ctx.save(); ctx.globalCompositeOperation='lighter';
    // 太陽光暈 bloom（緊貼太陽、柔和；alpha 調淡）
    const bloom=ctx.createRadialGradient(sx,sy,R*0.5,sx,sy,R*2.6);
    bloom.addColorStop(0,'rgba(255,238,196,0.52)'); bloom.addColorStop(0.45,'rgba(255,194,130,0.24)'); bloom.addColorStop(1,'rgba(255,165,105,0)');
    ctx.fillStyle=bloom; ctx.beginPath(); ctx.arc(sx,sy,R*2.6,0,Math.PI*2); ctx.fill();
    ctx.restore();
    // 太陽本體：暖漸層（柔金心→金→柔橘邊），微微脈動呼吸
    const pr=R*(1+0.015*Math.sin(t*0.8));
    const disc=ctx.createRadialGradient(sx,sy,0, sx,sy,pr);
    disc.addColorStop(0,'#FFF1CC'); disc.addColorStop(0.55,'#FFCD86'); disc.addColorStop(0.9,'#FBAA63'); disc.addColorStop(1,'#F2945A');
    ctx.fillStyle=disc; ctx.beginPath(); ctx.arc(sx,sy,pr,0,Math.PI*2); ctx.fill();
    // 柔亮邊緣（lighter 疊一圈 → 邊緣發光、不死板）
    ctx.save(); ctx.globalCompositeOperation='lighter';
    const rim=ctx.createRadialGradient(sx,sy,pr*0.82,sx,sy,pr*1.05);
    rim.addColorStop(0,'rgba(255,240,200,0)'); rim.addColorStop(1,'rgba(255,226,172,0.4)');
    ctx.fillStyle=rim; ctx.beginPath(); ctx.arc(sx,sy,pr*1.05,0,Math.PI*2); ctx.fill();
    ctx.restore();
    ctx.restore();   // 解除地平線裁切
    const cdir=_windVecX()>=0?1:-1;
    ctx.save(); ctx.globalAlpha=_wf;                        // 背光雲隨夜化淡出（夜晚無雲、與 dNight 一致）
    cloudP.forEach((c,i) => {
      c.x += c.sp*cdir*0.5;
      if (cdir>0 && c.x-W*c.sc>W) c.x=-W*0.6; else if (cdir<0 && c.x+W*c.sc<0) c.x=W+W*0.6;
      _sunsetCloud(c.x, H*(0.42+0.13*(i%3)), W*c.sc*1.1, c.flip, c.puffs);
    });
    ctx.restore();
    // 地平線暖霾：集中在螢幕下緣（太陽沉沒處）→ 暖光由下往上淡出；隨夜化整體再淡出（用快取漸層）
    ctx.save(); ctx.globalAlpha=_wf;
    ctx.fillStyle=_ssGrad.hz; ctx.fillRect(0,_ssGrad.hzTop,W,H-_ssGrad.hzTop);
    ctx.restore();
  }

  /* 🌄 日出（朝霞）：dSunset 的時間鏡像 → 夜 → 朝霞暖色 → 白天；太陽自螢幕下緣升起、星星淡出。
     日出視窗 ±45min：rise-45→深夜(prog0)、真實日出 rise→太陽觸螢幕下緣(prog0.5)、rise+45→升入天空接白天(prog1)。*/
  function dSunrise(t) {
    const nowMinF=_locNowMin();
    const riseMin=(_wd.sunRiseMin!=null)?_wd.sunRiseMin:360;
    let prog=(nowMinF-(riseMin-45))/90; prog=Math.max(0,Math.min(1,prog));
    // 夜化係數 nf：prog0(日出前)=深夜(1) → prog0.5(真實日出)=朝霞暖(0)；之後維持暖
    const _e=Math.max(0,Math.min(1,(0.5-prog)/0.5)); const nf=_e*_e*(3-2*_e);
    // 入日係數 dayf：prog0.5→1 天空淡出露出白天底（接 dSunny）
    const _d=Math.max(0,Math.min(1,(prog-0.5)/0.5)); const dayf=_d*_d*(3-2*_d);
    const warmA=(1-nf)*(1-dayf);                            // 朝霞暖光：夜=0、日出=最強、白天=0
    const horizonY=H, R=54;
    const sx=W*0.5;
    const sy=H*1.60-(H*1.60-H*0.40)*prog;                  // 由螢幕下緣外升起；prog0.5 觸下緣、prog1 升到 0.40H

    // 天空漸層（朝霞色↔深夜藍，隨 nf 混色；與 dSunset 共用快取/調色盤）
    const nfStep=Math.round(nf*16);
    if (_ssGrad.h!==H || _ssGrad.nfStep!==nfStep) {
      _ssGrad.h=H; _ssGrad.nfStep=nfStep; const k=nfStep/16;
      const SS=['#3A3358','#6B5A7C','#B98A92','#E3AE86','#F2D6A6'];
      const NT=['#0C0C18','#12111E','#171425','#1C1828','#221C2C'];
      const sky=ctx.createLinearGradient(0,0,0,H);
      [0,0.34,0.60,0.80,1].forEach((p,i)=>sky.addColorStop(p,_hexLerp(SS[i],NT[i],k)));
      _ssGrad.sky=sky;
    }
    if (_ssGrad.hzH!==H) {
      const hzTop=H*0.78; const hz=ctx.createLinearGradient(0,hzTop,0,H);
      hz.addColorStop(0,'rgba(255,188,128,0)'); hz.addColorStop(0.6,'rgba(255,182,120,0.10)'); hz.addColorStop(1,'rgba(252,174,112,0.20)');
      _ssGrad.hz=hz; _ssGrad.hzTop=hzTop; _ssGrad.hzH=H;
    }
    ctx.save(); ctx.globalAlpha=1-dayf; ctx.fillStyle=_ssGrad.sky; ctx.fillRect(0,0,W,H); ctx.restore();

    // 星星：夜濃才多 → 用 nf（prog0 滿天、日出後淡出）
    const starLit=nf;
    if (starLit>0.01) {
      const skyLimit=H*(0.36+0.30*(1-prog));
      stars.forEach(p => {
        if (p.y<skyLimit) {
          const tw=.45+.55*Math.sin(t*p.sp+p.ph);
          const a=tw*starLit*0.9; if (a<0.02) return;
          ctx.fillStyle=`rgba(255,255,245,${a.toFixed(3)})`;
          ctx.beginPath(); ctx.arc(p.x,p.y,p.r*(0.6+0.5*(1-prog)),0,6.28); ctx.fill();
        }
      });
    }
    // 大範圍暖輝（朝霞）
    ctx.save(); ctx.globalCompositeOperation='lighter'; ctx.globalAlpha=warmA;
    const hg=ctx.createRadialGradient(sx,sy,0,sx,sy,W*0.68);
    hg.addColorStop(0,'rgba(255,206,140,0.22)'); hg.addColorStop(0.4,'rgba(255,160,100,0.08)'); hg.addColorStop(1,'rgba(255,130,90,0)');
    ctx.fillStyle=hg; ctx.fillRect(0,0,W,H); ctx.restore();
    // 太陽本體與光暈（裁切地平線以上 → 升起時自下緣冒出）
    ctx.save(); ctx.beginPath(); ctx.rect(0,0,W,horizonY); ctx.clip();
    ctx.save(); ctx.globalCompositeOperation='lighter';
    const bloom=ctx.createRadialGradient(sx,sy,R*0.5,sx,sy,R*2.6);
    bloom.addColorStop(0,'rgba(255,238,196,0.52)'); bloom.addColorStop(0.45,'rgba(255,194,130,0.24)'); bloom.addColorStop(1,'rgba(255,165,105,0)');
    ctx.fillStyle=bloom; ctx.beginPath(); ctx.arc(sx,sy,R*2.6,0,Math.PI*2); ctx.fill();
    ctx.restore();
    const pr=R*(1+0.015*Math.sin(t*0.8));
    const disc=ctx.createRadialGradient(sx,sy,0, sx,sy,pr);
    disc.addColorStop(0,'#FFF1CC'); disc.addColorStop(0.55,'#FFCD86'); disc.addColorStop(0.9,'#FBAA63'); disc.addColorStop(1,'#F2945A');
    ctx.fillStyle=disc; ctx.beginPath(); ctx.arc(sx,sy,pr,0,Math.PI*2); ctx.fill();
    ctx.save(); ctx.globalCompositeOperation='lighter';
    const rim=ctx.createRadialGradient(sx,sy,pr*0.82,sx,sy,pr*1.05);
    rim.addColorStop(0,'rgba(255,240,200,0)'); rim.addColorStop(1,'rgba(255,226,172,0.4)');
    ctx.fillStyle=rim; ctx.beginPath(); ctx.arc(sx,sy,pr*1.05,0,Math.PI*2); ctx.fill();
    ctx.restore();
    ctx.restore();   // 解除地平線裁切
    const cdir=_windVecX()>=0?1:-1;
    ctx.save(); ctx.globalAlpha=warmA;
    cloudP.forEach((c,i) => {
      c.x += c.sp*cdir*0.5;
      if (cdir>0 && c.x-W*c.sc>W) c.x=-W*0.6; else if (cdir<0 && c.x+W*c.sc<0) c.x=W+W*0.6;
      _sunsetCloud(c.x, H*(0.42+0.13*(i%3)), W*c.sc*1.1, c.flip, c.puffs);
    });
    ctx.restore();
    ctx.save(); ctx.globalAlpha=warmA;
    ctx.fillStyle=_ssGrad.hz; ctx.fillRect(0,_ssGrad.hzTop,W,H-_ssGrad.hzTop);
    ctx.restore();
  }

  /* ☄️ 流星雨：暗夜 + 星 + 行星，頻繁從上方輻射射出帶光尾的流星 */
  function dMeteor(t) {
    _gc.nebula && _gc.nebula.forEach(g => { ctx.fillStyle=g; ctx.fillRect(0,0,W,H); });
    stars.forEach(p => {
      const a=.15+.7*Math.sin(t*p.sp+p.ph);
      ctx.fillStyle=`rgba(222,232,255,${a})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, a>.6?p.r*1.2:p.r, 0, 6.28); ctx.fill();
    });
    _drawPlanets(t);
    meteorTimer--;
    if (meteorTimer<=0 && meteors.length<14) {
      meteorTimer = 5+Math.floor(Math.random()*15);            // 頻繁
      const ang=Math.PI/2.6 + (Math.random()-.5)*0.5, sp=10+Math.random()*12;
      meteors.push({ x:W*(0.1+Math.random()*0.8), y:-20, vx:Math.cos(ang)*sp, vy:Math.sin(ang)*sp,
        len:60+Math.random()*120, life:0, max:30+Math.random()*40, a:.6+Math.random()*.4 });
    }
    for (let i=meteors.length-1;i>=0;i--) {
      const m=meteors[i]; m.life++; m.x+=m.vx; m.y+=m.vy;
      const fade = m.life>m.max-12 ? Math.max(0,(m.max-m.life)/12) : 1;
      const hyp=Math.hypot(m.vx,m.vy), ux=m.vx/hyp, uy=m.vy/hyp;
      const tg=ctx.createLinearGradient(m.x,m.y,m.x-ux*m.len,m.y-uy*m.len);
      tg.addColorStop(0,`rgba(255,255,255,${(m.a*fade).toFixed(3)})`); tg.addColorStop(1,'rgba(180,210,255,0)');
      ctx.strokeStyle=tg; ctx.lineWidth=1.6; ctx.lineCap='round';
      if (!_lowFx) { ctx.shadowBlur=8; ctx.shadowColor='rgba(200,225,255,0.8)'; }
      ctx.beginPath(); ctx.moveTo(m.x,m.y); ctx.lineTo(m.x-ux*m.len,m.y-uy*m.len); ctx.stroke(); ctx.shadowBlur=0;
      ctx.fillStyle=`rgba(255,255,255,${(m.a*fade).toFixed(3)})`; ctx.beginPath(); ctx.arc(m.x,m.y,1.6,0,6.28); ctx.fill();
      if (m.life>=m.max || m.y>H+50 || m.x>W+60 || m.x<-60) meteors.splice(i,1);
    }
  }

  /* ── 溫度色調：熱→暖橘、冷→冷藍（全畫面極淡疊色，依實際溫度） ── */
  function _tempTint() {
    if (_wd.temp == null) return;
    const tmp = _wd.temp;
    if (tmp >= 28)      { ctx.fillStyle = `rgba(255,150,40,${Math.min(.12,(tmp-28)*.012).toFixed(3)})`; ctx.fillRect(0,0,W,H); }
    else if (tmp <= 6)  { ctx.fillStyle = `rgba(120,170,255,${Math.min(.14,(6-tmp)*.012).toFixed(3)})`; ctx.fillRect(0,0,W,H); }
  }

  /* ── main loop ── */
  function draw() {
    ctx.clearRect(0,0,W,H);
    if (type === "off") return;  // 「無」模式：清空畫布即可，不畫任何特效
    _paX += (_paTX - _paX) * 0.07; _paY += (_paTY - _paY) * 0.07;   // 平滑視差位移
    const t=Date.now()*.001;
    ({sunny:dSunny,night:dNight,cloudy:dCloudy,fog:dFog,rain:dRain,snow:dSnow,storm:dStorm,thunder:dThunder,mahjong:dMahjong,leaves:dLeaves,spring:dSpring,partly:dPartly,overcast:dOvercast,drizzle:dDrizzle,windy:dWindy,hail:dHail,tornado:dTornado,quake:dQuake,aurora:dAurora,sunset:dSunset,sunrise:dSunrise,meteor:dMeteor})[type]?.(t);
    _drawAstro(t);
    _tempTint();
  }
  function loop(ts) {
    rafId = requestAnimationFrame(loop);
    if (document.hidden || ts - _lastFrameTs < _frameMin) return;
    const _now = (performance.now ? performance.now() : Date.now());
    // 手機：觸控後 350ms 內暫停天氣重繪（平移/縮放圖表期間不搶主執行緒）
    if (_lowFx && _touchT && _now - _touchT < 350) return;
    // 任何裝置：圖表正在移動（平移/縮放/慣性滑動）→ 暫停天氣重繪 220ms，把幀預算讓給圖表，
    // 主圖滑動更順。圖表停止移動 220ms 後天氣自動恢復。
    if (window._chartMoveTs && _now - window._chartMoveTs < 220) return;
    _lastFrameTs = ts;
    draw();
  }
  let _inited = false;
  function start(wt) {
    const changed = wt !== type || !_inited;
    // 進入下雨類型時把雨勢 ramp 歸零 → 之後在 dRain 緩升（雨水漸起感）
    const rainy = w => w==='rain'||w==='storm'||w==='drizzle';
    if (rainy(wt) && !rainy(type)) _rainRamp = 0;
    if (wt !== 'quake') document.body.style.transform = '';   // 離開地震 → 畫面歸位
    type = wt;
    // 晴朗夜空（type==='night'）→ 主圖淡淡透出夜空(月亮/星星/行星)；其餘天氣/白天不透
    const wasNight = document.documentElement.classList.contains('sky-night');
    const isNight = wt === 'night';
    document.documentElement.classList.toggle('sky-night', isNight);
    // 夜↔日切換時重套主圖漸層：夜間中央色帶半透明(露夜空)、白天恢復不透明
    if (wasNight !== isNight) window._applyChartBgGradient?.();
    if (changed) { _init(); _inited = true; }
    _lastFrameTs = 0;
    if (!rafId) requestAnimationFrame(loop);
  }

  /* 各國國旗（簡化版）→ inline SVG，配城堡棕旗桿 + 棕邊框（手繪風）。未對應 → 暖色小旗 */
  function _flagSvg(country) {
    const k = (country || '').toLowerCase();
    let f = null;
    if (k.indexOf('taiwan') >= 0)        f = "<rect x='5' y='4' width='17' height='11' fill='#D62828'/><rect x='5' y='4' width='8.5' height='5.5' fill='#13357B'/><circle cx='9.25' cy='6.75' r='1.9' fill='#fff'/>";
    else if (k.indexOf('japan') >= 0)    f = "<rect x='5' y='4' width='17' height='11' fill='#fff'/><circle cx='13.5' cy='9.5' r='3' fill='#D62828'/>";
    else if (k === 'china')              f = "<rect x='5' y='4' width='17' height='11' fill='#DE2910'/><circle cx='9' cy='7' r='1.8' fill='#FFDE00'/><circle cx='12.6' cy='5.9' r='.7' fill='#FFDE00'/><circle cx='13.3' cy='7.9' r='.7' fill='#FFDE00'/>";
    else if (k.indexOf('korea') >= 0)    f = "<rect x='5' y='4' width='17' height='11' fill='#fff'/><circle cx='13.5' cy='9.5' r='2.8' fill='#003478'/><path d='M13.5 6.7a2.8 2.8 0 0 1 0 5.6 1.4 1.4 0 0 1 0-2.8 1.4 1.4 0 0 0 0-2.8z' fill='#C60C30'/>";
    else if (k.indexOf('hong') >= 0)     f = "<rect x='5' y='4' width='17' height='11' fill='#DE2910'/><circle cx='13.5' cy='9.5' r='2.6' fill='#fff'/>";
    else if (k === 'usa')                f = "<rect x='5' y='4' width='17' height='11' fill='#fff'/><rect x='5' y='5.57' width='17' height='1.57' fill='#B22234'/><rect x='5' y='8.71' width='17' height='1.57' fill='#B22234'/><rect x='5' y='11.85' width='17' height='1.57' fill='#B22234'/><rect x='5' y='4' width='17' height='1.57' fill='#B22234'/><rect x='5' y='4' width='7' height='6' fill='#3C3B6E'/>";
    else if (k === 'uk')                 f = "<rect x='5' y='4' width='17' height='11' fill='#012169'/><path d='M5 4L22 15M22 4L5 15' stroke='#fff' stroke-width='2.4'/><path d='M13.5 4V15M5 9.5H22' stroke='#fff' stroke-width='3.4'/><path d='M13.5 4V15M5 9.5H22' stroke='#C8102E' stroke-width='1.6'/>";
    else if (k === 'france')             f = "<rect x='5' y='4' width='5.67' height='11' fill='#0055A4'/><rect x='10.67' y='4' width='5.67' height='11' fill='#fff'/><rect x='16.33' y='4' width='5.67' height='11' fill='#EF4135'/>";
    else if (k === 'germany')            f = "<rect x='5' y='4' width='17' height='3.67' fill='#111'/><rect x='5' y='7.67' width='17' height='3.67' fill='#D00'/><rect x='5' y='11.33' width='17' height='3.67' fill='#FFCE00'/>";
    else if (k.indexOf('singapore') >= 0)f = "<rect x='5' y='4' width='17' height='5.5' fill='#EF3340'/><rect x='5' y='9.5' width='17' height='5.5' fill='#fff'/><circle cx='9' cy='6.75' r='2' fill='#fff'/><circle cx='9.9' cy='6.75' r='1.7' fill='#EF3340'/>";
    else if (k.indexOf('thailand') >= 0) f = "<rect x='5' y='4' width='17' height='11' fill='#fff'/><rect x='5' y='4' width='17' height='2.2' fill='#A51931'/><rect x='5' y='12.8' width='17' height='2.2' fill='#A51931'/><rect x='5' y='7.3' width='17' height='4.4' fill='#2D2A4A'/>";
    else if (k.indexOf('australia') >= 0)f = "<rect x='5' y='4' width='17' height='11' fill='#012169'/><path d='M5 4L12 9.5M12 4L5 9.5' stroke='#fff' stroke-width='1.2'/><circle cx='17.5' cy='11' r='1' fill='#fff'/><circle cx='9' cy='13' r='.9' fill='#fff'/>";
    else if (k === 'uae')                f = "<rect x='5' y='4' width='4' height='11' fill='#FF0000'/><rect x='9' y='4' width='13' height='3.67' fill='#00843D'/><rect x='9' y='7.67' width='13' height='3.67' fill='#fff'/><rect x='9' y='11.33' width='13' height='3.67' fill='#111'/>";
    const flag = f || "<path d='M6 4.6c4-1.5 7 1.4 11.4 0l-.5 5.7c-4 1.5-7-1.4-11.4 0z' fill='#D89C68'/>";
    const box  = f ? "<rect x='5' y='4' width='17' height='11' fill='none' stroke='#5A4632' stroke-width='1' stroke-linejoin='round'/>" : "";
    return "<svg class='ctry-flag' viewBox='0 0 26 24' xmlns='http://www.w3.org/2000/svg'>" +
           "<path d='M4 3.2V21' fill='none' stroke='#7A5E42' stroke-width='1.6' stroke-linecap='round'/>" +
           flag + box + "</svg>";
  }

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
      '<div style="opacity:.68">風 '+(_wd.windDir==null?'':_dirName(_wd.windDir)+' ')+_wd.windSpeed+' km/h　雲量 '+_wd.cloudCover+'%</div>'+
      '<div style="opacity:.68">降雨 '+_wd.precip+' mm　能見度 '+vis+'</div>'+
      '<div style="opacity:.38;font-size:10px">'+hm+' 更新　'+(_wd.source==='cwa'?'中央氣象署':'Open-Meteo')+'</div>';
    // 手機設定面板頂部天氣卡（#mSetWeather）：與浮動卡 #_wxCard 同資料；有溫度才顯示(.on)
    const _mw = document.getElementById('mSetWeather');
    if (_mw) {
      _mw.classList.add('on');
      _mw.innerHTML =
        '<div class="wx-top">'+
          (_wd.city ? '<span class="wx-city">'+_wd.city+'</span>' : '')+
          '<span class="wx-temp">'+_wd.temp+'°</span>'+
          '<span class="wx-desc">'+desc+'</span>'+
        '</div>'+
        '<div class="wx-grid">'+
          '<span>風　<b>'+(_wd.windDir==null?'':_dirName(_wd.windDir)+' ')+_wd.windSpeed+' km/h</b></span>'+
          '<span>雲量　<b>'+_wd.cloudCover+'%</b></span>'+
          '<span>降雨　<b>'+_wd.precip+' mm</b></span>'+
          '<span>能見度　<b>'+vis+'</b></span>'+
        '</div>'+
        '<div class="wx-foot">'+hm+' 更新　'+(_wd.source==='cwa'?'中央氣象署':'Open-Meteo')+'</div>';
    }
    // 開場首頁上方：依天氣 API 顯示所在地（城市 + 溫度 + 天氣）
    const _lloc = document.getElementById('landingLoc');
    if (_lloc && _wd.city) {                                       // 兩層：城市+天氣 / 溫度+降雨機率（雨滴符號）
      const _pop = (_wd.pop != null) ? '　<span class="lloc-pop">' + _wd.pop + '%</span>' : '';
      _lloc.innerHTML =
        '<span class="lloc-1">' + _wd.city + ' <span class="lloc-wx">' + desc + '</span></span>' +
        '<span class="lloc-2">' + _wd.temp + '°C' + _pop + '</span>';
    }
    // 大門上：國旗 + 草寫國名（在 .landing-stage 內 → 點門放大時隨門一起放大、鎖定畫面也保持顯示）
    const _lcountry = document.getElementById('landingCountry');
    if (_lcountry && _wd.country)
      _lcountry.innerHTML = _flagSvg(_wd.country) + '<span class="ctry-name">' + _wd.country + '</span>';
  }

  // 手動是否選了天氣特效（button 高亮中）→ 自動天氣不可覆蓋
  function _isManualOn() {
    return ['leaf','rain','snow','spring','thunder','mahjong','hail','tornado','quake','aurora','meteor'].some(
      w => document.getElementById(w+'ToggleBtn')?.classList.contains(w+'-active'));
  }
  // 解析自動天氣：好天氣(晴/少雲) + 真實日落時段(±45min) → 自動晚霞；否則照後端 _autoType
  function _resolveAutoType() {
    const base = _autoType || 'sunny';
    const clearish = (base==='sunny'||base==='partly'||base==='night') && ((_wd.cloudCover==null) || _wd.cloudCover < 45);
    if (clearish) {
      const nowMin = _locNowMin();
      if (_wd.sunSetMin!=null  && Math.abs(nowMin - _wd.sunSetMin)  <= 45) return 'sunset';
      if (_wd.sunRiseMin!=null && Math.abs(nowMin - _wd.sunRiseMin) <= 45) return 'sunrise';
    }
    return base;
  }
  // 非手動時套用自動天氣（含晚霞自動觸發）；每分鐘重評，日落時段過了會自動切回
  function _applyAutoType() {
    if (_isManualOn()) return;
    const t = _resolveAutoType();
    if (t !== type) start(t);
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
        _wd.windDir     = (d.wind_dir == null) ? null : +d.wind_dir;  // 風向（度，來向）；缺則 null → 預設西南風
        _wd.pop         = (d.pop == null) ? null : Math.round(+d.pop); // 降雨機率 %
        _wd.country     = d.country || null;                          // 英文國家名（首頁大門上草寫）
        _wd.visibility  = d.visibility;
        _wd.desc        = d.description || null;
        _wd.city        = d.location || d.station || null;
        _wd.updatedAt   = new Date();
        _wd.sunRiseMin  = d.sun_rise_min  ?? 360;
        _wd.sunSetMin   = d.sun_set_min   ?? 1080;
        _wd.tzOffMin    = (d.tz_offset_min != null) ? d.tz_offset_min : null;   // 該地真實 UTC 偏移(分)，給 _locNowMin 用
        _wd.moonPhase   = d.moon_phase    ?? 0;
        _wd.moonRiseMin = d.moon_rise_min ?? 1080;
        _wd.moonSetMin  = d.moon_set_min  ?? 360;
        const pInt = Math.min(1, (d.precipitation || 0) / 20);
        const cInt = (d.cloud_cover || 0) / 100;
        _wd.intensity  = Math.max(0.3, pInt * 0.7 + cInt * 0.3);
        _autoType = d.weather_type || 'sunny';
        // 首次進來：button 還沒高亮 → 嘗試從 localStorage 恢復；否則依解析後的自動天氣（含晚霞）
        if (!_isManualOn() && !window._restoreManualWxIfAny?.()) start(_resolveAutoType());
        _renderWeatherCard();
      })
      .catch(() => {
        _autoType = 'sunny'; _wd.intensity = 0.5;
        if (!_isManualOn() && !window._restoreManualWxIfAny?.()) start(_resolveAutoType());
      });
  }
  function _clearWeatherBtns() {
    document.getElementById("leafToggleBtn")    ?.classList.remove("leaf-active");
    document.getElementById("rainToggleBtn")    ?.classList.remove("rain-active");
    document.getElementById("snowToggleBtn")    ?.classList.remove("snow-active");
    document.getElementById("springToggleBtn")  ?.classList.remove("spring-active");
    document.getElementById("thunderToggleBtn") ?.classList.remove("thunder-active");
    document.getElementById("mahjongToggleBtn") ?.classList.remove("mahjong-active");
    document.getElementById("hailToggleBtn")    ?.classList.remove("hail-active");
    document.getElementById("tornadoToggleBtn") ?.classList.remove("tornado-active");
    document.getElementById("quakeToggleBtn")   ?.classList.remove("quake-active");
    document.getElementById("auroraToggleBtn")  ?.classList.remove("aurora-active");
    document.getElementById("sunsetToggleBtn")  ?.classList.remove("sunset-active");
    document.getElementById("meteorToggleBtn")  ?.classList.remove("meteor-active");
    document.getElementById("noFxToggleBtn")    ?.classList.remove("nofx-active");
  }
  window._getWeatherType = () => type;

  // 記住使用者上次手動選的天氣特效（leaves/rain/snow/spring/thunder/mahjong）
  // 若沒選則回到 _autoType（依 API 自動切）
  const _WX_KEY = "weatherManual";
  function _saveManualWx(name) { try { localStorage.setItem(_WX_KEY, name); } catch(e){} }
  function _clearManualWx()    { try { localStorage.removeItem(_WX_KEY); } catch(e){} }
  function _getManualWx() {
    try { return localStorage.getItem(_WX_KEY) || null; } catch(e) { return null; }
  }
  // 啟動指定手動天氣特效（含按鈕高亮）；name 對應 type 值
  function _applyManualWx(name) {
    _clearWeatherBtns();
    if (name === "off") {
      start("off");
      document.getElementById("noFxToggleBtn")?.classList.add("nofx-active");
      return;
    }
    const cls = (name === "leaves") ? "leaf-active" : name + "-active";
    const btnId = (name === "leaves") ? "leafToggleBtn" : name + "ToggleBtn";
    if (name === "thunder") { thunderBolts=[]; thunderFlashes=[]; thunderTimer=10; }
    start(name);
    document.getElementById(btnId)?.classList.add(cls);
  }
  // 給 fetchWeather 用：在 _autoType 設好之後恢復上次選擇
  window._restoreManualWxIfAny = function() {
    const saved = _getManualWx();
    if (!saved) return false;
    const valid = ["leaves","rain","snow","spring","thunder","mahjong","hail","tornado","off","aurora","meteor"];  // 已移除 quake/sunset 選單 → 不從 localStorage 復活
    if (!valid.includes(saved)) { _clearManualWx(); return false; }
    _applyManualWx(saved);
    return true;
  };

  function _toggleWx(name) {
    if (type === name) {
      start(_autoType); _clearWeatherBtns(); _clearManualWx();
    } else {
      _applyManualWx(name); _saveManualWx(name);
    }
  }
  window._leafToggle    = () => _toggleWx("leaves");
  window._rainToggle    = () => _toggleWx("rain");
  window._snowToggle    = () => _toggleWx("snow");
  window._springToggle  = () => _toggleWx("spring");
  window._mahjongToggle = () => _toggleWx("mahjong");
  window._noFxToggle    = () => _toggleWx("off");
  window._thunderToggle = () => _toggleWx("thunder");
  window._hailToggle    = () => _toggleWx("hail");
  window._tornadoToggle = () => _toggleWx("tornado");
  window._quakeToggle   = () => _toggleWx("quake");
  window._auroraToggle  = () => _toggleWx("aurora");
  window._sunsetToggle  = () => _toggleWx("sunset");
  window._sunriseToggle = () => _toggleWx("sunrise");
  window._meteorToggle  = () => _toggleWx("meteor");

  window.addEventListener("resize", resize);
  resize();
  _initParallax();
  setInterval(_applyAutoType, 60000);   // 每分鐘重評自動天氣（讓晚霞在日落時段自動出現/退場）
  // 不在這裡 start()——等 fetchWeather 回來再用真實 _wd 啟動，
  // 避免「先用預設值畫一次→拿到 API 又重畫」造成的閃爍/位移

  // ── 天氣定位 ────────────────────────────────────────────────
  // 修：舊版第一次成功就把座標永久快取、之後每次都只讀快取「不再更新」→ 使用者移到
  //     其他地區仍顯示舊地點（常見：永遠台北中正區=預設值）。被拒一次更會記 "deny" 鎖死。
  // 新流程：
  //   ① 有快取 → 先即時畫（免空白/閃爍），但「不」當最終結果
  //   ② 每次啟動都重新抓真實定位（已授權 → 靜默、不再跳權限窗；被拒 → 立即 error 不跳窗）
  //   ③ 瀏覽器定位被拒/不支援 → 改用伺服器 IP 粗定位（/api/geoip）顯示真實地區
  //   ④ 連 IP 都失敗、且沒有可用快取 → 才退回台北預設
  // ⓪ 指定地點預覽：?wxlat=22.30&wxlon=114.17（或 ?wxloc=hongkong）→ 「只在這次帶參數時」鎖定該地、
  //    跳過自動定位。不帶參數的純網址一律走真實自動定位（不記住、不殘留）。
  const _qp = new URLSearchParams(location.search);
  const _WX_PRESET = {
    taiwan:[25.04,121.51], taipei:[25.04,121.51], tw:[25.04,121.51],
    hongkong:[22.30,114.17], hk:[22.30,114.17],
    japan:[35.68,139.76], tokyo:[35.68,139.76], jp:[35.68,139.76],
    korea:[37.57,126.98], seoul:[37.57,126.98], kr:[37.57,126.98],
    china:[31.23,121.47], shanghai:[31.23,121.47], cn:[31.23,121.47],
    singapore:[1.35,103.82], sg:[1.35,103.82],
    thailand:[13.76,100.50], bangkok:[13.76,100.50], th:[13.76,100.50],
    usa:[40.71,-74.01], newyork:[40.71,-74.01], us:[40.71,-74.01],
    uk:[51.51,-0.13], london:[51.51,-0.13], gb:[51.51,-0.13],
    france:[48.86,2.35], paris:[48.86,2.35], fr:[48.86,2.35],
    germany:[52.52,13.40], berlin:[52.52,13.40], de:[52.52,13.40],
    uae:[25.20,55.27], dubai:[25.20,55.27],
    australia:[-33.87,151.21], sydney:[-33.87,151.21], au:[-33.87,151.21],
  };
  try { localStorage.removeItem('wxOverride'); } catch (e) {}   // 清掉舊版殘留的持久化覆寫
  let _ovLat = parseFloat(_qp.get('wxlat')), _ovLon = parseFloat(_qp.get('wxlon'));
  const _ovLoc = (_qp.get('wxloc') || '').toLowerCase().replace(/[^a-z]/g,'');
  if ((isNaN(_ovLat) || isNaN(_ovLon)) && _WX_PRESET[_ovLoc]) { _ovLat = _WX_PRESET[_ovLoc][0]; _ovLon = _WX_PRESET[_ovLoc][1]; }
  if (!isNaN(_ovLat) && !isNaN(_ovLon)) { fetchWeather(_ovLat, _ovLon); return; }   // 僅本次預覽，不寫入 localStorage

  let _wxCoordCache = null;
  try { _wxCoordCache = JSON.parse(localStorage.getItem('wxCoords') || 'null'); } catch (e) {}
  const _saveCoords = (lat, lon) => {
    try { localStorage.setItem('wxCoords', JSON.stringify({ lat: lat, lon: lon, ts: Date.now() })); } catch (e) {}
  };
  const _ipFallback = (painted) => {
    fetch('/api/geoip').then(r => r.ok ? r.json() : null).then(g => {
      if (g && g.ok && g.lat != null && g.lon != null) {
        _saveCoords(g.lat, g.lon); fetchWeather(g.lat, g.lon);
      } else if (!painted) {
        fetchWeather(25.04, 121.51);                 // 連 IP 都查不到 → 台北預設
      }
    }).catch(() => { if (!painted) fetchWeather(25.04, 121.51); });
  };
  const _hasCache = _wxCoordCache && typeof _wxCoordCache === 'object' && _wxCoordCache.lat != null;
  if (_hasCache) fetchWeather(_wxCoordCache.lat, _wxCoordCache.lon);   // ① 有快取先即時畫（免空白）

  // ② 取真實定位 — 用 Permissions API 避免「每次打開都跳權限詢問」：
  //    · 已授權(granted)  → 靜默 getCurrentPosition 刷新（不跳窗）→ 既精準又不打擾，移動換區也會更新
  //    · 已拒絕(denied)   → 不問，改用 IP 粗定位
  //    · 未決定(prompt)   → 只在「第一次、且尚無快取」時問一次；之後不再每次問（用快取/IP），
  //                        使用者一旦允許就變 granted → 往後都靜默精準定位
  const _getPos = () => navigator.geolocation.getCurrentPosition(
    p => { _saveCoords(p.coords.latitude, p.coords.longitude); fetchWeather(p.coords.latitude, p.coords.longitude); },
    () => { try { localStorage.setItem('wxGeoAsked', '1'); } catch (e) {} _ipFallback(_hasCache); },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 }   // 高精度(GPS)→修「定位不準」；maxAge 5min→重複開啟用近期定位、免每次重抓(修「太慢」)
  );
  let _asked = false; try { _asked = !!localStorage.getItem('wxGeoAsked'); } catch (e) {}
  const _promptOnce = () => {
    if (!_asked && !_hasCache) { try { localStorage.setItem('wxGeoAsked', '1'); } catch (e) {} _getPos(); }
    else _ipFallback(_hasCache);          // 問過或已有快取 → 不再每次跳窗
  };
  if (!navigator.geolocation) {
    _ipFallback(_hasCache);
  } else if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: 'geolocation' }).then(st => {
      if (st.state === 'granted')      _getPos();          // 靜默精準刷新
      else if (st.state === 'denied')  _ipFallback(_hasCache);
      else                             _promptOnce();      // prompt：不每次問
    }).catch(_promptOnce);
  } else {
    // iOS 舊 Safari 等不支援 Permissions API：直接 getCurrentPosition。
    // 修正：先前走 _promptOnce → 一旦 wxGeoAsked/有快取 就改吃 IP 粗定位（ip-api 城市級、行動網路常飄）
    //       → 即使使用者「已授權 GPS」也永遠拿 IP 不準。改直接 _getPos：
    //       已授權→靜默高精度定位(準)；已拒絕→error handler 轉 IP 後援；未決定→只在此時詢問一次。
    _getPos();
  }
})();
