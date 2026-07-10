/* ── 天氣背景動畫（華麗版・CSS3D 分層）── */
(function initWeatherBg() {
  const canvas = document.getElementById("weatherBg");
  if (!canvas) return;
  // 低效能裝置降載：手機(小螢幕/觸控+低記憶體) → 減少粒子數、關 shadowBlur、簡化光束
  const _lowFx = (() => {
    try {
      const small  = Math.min(window.innerWidth, window.innerHeight) < 640;
      const coarse = matchMedia('(pointer: coarse)').matches;
      const lowMem = (navigator.deviceMemory || 8) <= 4;
      return small || (coarse && lowMem);
    } catch(e) { return false; }
  })();
  const _fxN = _lowFx ? 0.5 : 1;           // 粒子數倍率
  const _frameMin = _lowFx ? 60 : 33;      // 幀間隔下限：手機 ~16fps（省 GPU/主執行緒）、桌面 ~30fps

  /* ── 3D 舞台與景深層（規格：docs/weather-3d-spec.md）──
     #weatherStage 套 CSS perspective(=_P)，內含多張 canvas 依 translateZ 排不同景深；
     相機（滑鼠/陀螺儀）動 perspective-origin → 瀏覽器 GPU 算真透視視差（如隔窗看景：
     遠層相對位移大、近層小），取代舊的逐粒子 _parX/_parY 軟體視差。
     各層 canvas 實際解析度縮小 1/s（s=補償縮放；CSS transform 放大回鋪滿）→ 遠層省填充率，
     並把 scale(1/s) 烤進 ctx 基準變換 → 所有繪製程式照舊用「螢幕座標」，零改動成本。 */
  const _P = 1200;                          // 必須與 CSS #weatherStage 的 perspective 一致
  // [名稱, translateZ(px), 高解析?]；高解析層 backing 不縮（透視縮小恰好抵銷補償縮放 → 1:1 顯示、不糊），
  // 給細節重的內容用（astro：月面/行星；fore：本來就 1:1）。其餘層縮 1/s 省填充率。
  // astro＝天體專屬深景層：太陽/月亮/行星/星空在最深處大幅視差，前方雲雨會從它面前掠過（真遮擋）。
  // mid/near 也走全解析（雲/雨等主要內容都在這兩層，縮減解析在大螢幕看得出糊 → 桌面比手機糊）；
  // sky 也走全解析：整幕最大面積的天色漸層，縮 1/s 再放大 2.33× 會把瀏覽器漸層抖色噪點
  //   放大成明顯「顆粒感」（使用者回報）→ 全解析消除。far 只有遠景柔霧 → 維持縮減省填充率。
  const _LAYER_DEFS = _lowFx                // 手機省層數
    ? [["sky", -1600, 1], ["astro", -1400, 1], ["mid", -450, 1], ["fore", 0, 1]]
    : [["sky", -1600, 1], ["astro", -1400, 1], ["far", -900, 0], ["mid", -450, 1], ["near", -150, 1], ["fore", 0, 1]];
  let stage = document.getElementById("weatherStage");
  if (!stage) {                             // 防舊快取頁（HTML 還沒有 stage）→ JS 自建
    stage = document.createElement("div");
    stage.id = "weatherStage";
    canvas.parentNode.insertBefore(stage, canvas);
    stage.appendChild(canvas);
  }
  const _CAM_AMP = _lowFx ? 8 : 12;         // 相機 perspective-origin 振幅（% 視窗）；層出血量也用它算
  const _layers = {};
  _LAYER_DEFS.forEach(([name, d, hi], i) => {
    const cv = (i === 0) ? canvas : document.createElement("canvas");   // sky 沿用既有 #weatherBg（CSS 掛勾都在它身上）
    cv.classList.add("wx-layer", "wx-" + name);   // wx-<層名>：CSS 可單獨控某層顯隱（自選頁只露 fore 層太陽系儀）
    if (cv !== canvas) stage.appendChild(cv);                            // DOM 順序＝疊放順序（transform-style 預設 flat）
    const s = 1 - d / _P;                   // 補償縮放：translateZ 往後縮小 k=P/(P-d)，scale=1/k 補回鋪滿
    // 出血放大 ov：相機運鏡時此層最多橫移 (−d/(P−d))×AMP% 視窗 → 額外放大兩倍此量，
    // 邊緣才永遠蓋住視窗（否則層一移動邊邊就露出空白 → 破圖）
    const ov = d === 0 ? 1 : 1 + 2 * (-d / (_P - d)) * (_CAM_AMP / 100) + 0.01;
    cv.style.transform = "translateZ(" + d + "px) scale(" + (s * ov).toFixed(4) + ")";
    _layers[name] = { cv: cv, ctx: cv.getContext("2d"), s: s, bs: hi ? 1 : 1 / s };   // bs＝backing 縮放
  });
  if (!_layers.far)  _layers.far  = _layers.sky;   // 手機：遠景併天空、近景併中景
  if (!_layers.near) _layers.near = _layers.mid;
  // 預設繪圖層＝mid（中景）：尚未分層的天氣全畫這裡（中等視差、螢幕位置與既往一致）
  const ctx = _layers.mid.ctx;
  // 依粒子景深 z（0遠~1近）選繪圖層
  function _ctxFor(z) { return (z < 0.33 ? _layers.far : z < 0.66 ? _layers.mid : _layers.near).ctx; }

  let W = 0, H = 0, type = "sunny", rafId = null, _gc = {}, _lastFrameTs = 0;
  let _animClock = 0, _lastClockTs = 0;    // 動畫虛擬時鐘（毫秒）：圖表移動中放慢 → 慢動作而非凍結
  // 手機：手指觸控/平移圖表時暫停天氣重繪 → 主執行緒全讓給圖表，平移/縮放更順（消除「卡」感）
  let _touchT = 0;
  if (_lowFx) {
    const _mark = () => { _touchT = (performance.now ? performance.now() : Date.now()); };
    window.addEventListener('touchstart', _mark, { passive: true });
    window.addEventListener('touchmove',  _mark, { passive: true });
  }
  let _camX = 0, _camY = 0, _camTX = 0, _camTY = 0, _camOn = false, _camRM = false;  // 3D 相機：平滑值/目標值(-1~1)，滑鼠或陀螺儀驅動 perspective-origin

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
    W = window.innerWidth  || 1200;
    H = window.innerHeight || 700;
    _LAYER_DEFS.forEach(([name]) => {
      const L = _layers[name];
      L.cv.width  = Math.ceil(W * L.bs);    // 一般層 backing 縮 1/s 省填充率；高解析層（astro/fore）1:1 保細節
      L.cv.height = Math.ceil(H * L.bs);
      L.ctx.setTransform(L.bs, 0, 0, L.bs, 0, 0);   // 基準變換：繪製程式照舊用螢幕座標
    });
    _buildGradCache();
    _init();
  }

  /* ── 3D 相機：滑鼠(桌面)/陀螺儀(手機) 驅動 #weatherStage 的 perspective-origin ──
     GPU 對各 translateZ 層自動算透視位移（遠層相對位移大、近層小 → 真縱深，如隔窗看景），
     取代舊的逐粒子 _parX/_parY 軟體位移（已移除，避免雙重視差）。 */
  let _camInputTs = -1e9;            // 最近一次陀螺儀輸入時間（秒）；_CAM_AMP 已上移至層建立處（出血計算共用）
  function _applyCamera(){
    if (_camRM || !_camOn) return;
    // 閒置 3 秒沒輸入 → 相機回正中、不自動繞行：自動繞行會讓最深的 astro 層（太陽/月亮/星空）
    // 被視差帶著飄＝看起來「亂晃」。改回正中後天體只走自己的時間弧線（正常軌道），雲仍隨風飄。
    // 手機陀螺儀傾斜（onTilt）仍會即時運鏡，那是使用者主動輸入、不算亂晃。
    const now = (performance.now ? performance.now() : Date.now()) * 0.001;
    if (now - _camInputTs > 3) {
      _camTX = 0; _camTY = 0;
    }
    _camX += (_camTX - _camX) * 0.07; _camY += (_camTY - _camY) * 0.07;   // 平滑跟隨
    stage.style.perspectiveOrigin =
      (50 - _camX * _CAM_AMP).toFixed(2) + '% ' + (50 - _camY * _CAM_AMP).toFixed(2) + '%';
  }
  const _camNowS = () => (performance.now ? performance.now() : Date.now()) * 0.001;
  function _initParallax(){
    if (_camOn) return; _camOn = true;
    try { if (matchMedia('(prefers-reduced-motion: reduce)').matches) { _camRM = true; return; } } catch(e){}  // 尊重減少動態偏好（CSS 端也有 !important 鎖，雙保險）
    // 滑鼠跟隨已移除（使用者不要背景跟滑鼠動）；閒置自動運鏡也已關（會讓太陽/月亮亂晃）→ 桌面背景靜止、只各層自轉/弧線；手機保留陀螺儀傾斜
    const onTilt = e => {
      if (e.gamma == null) return;
      _camInputTs = _camNowS();      // 有輸入 → 暫停自動運鏡、跟著傾斜
      _camTX = Math.max(-1, Math.min(1, e.gamma/35));            // 左右傾斜（°/35 → ±1）
      _camTY = Math.max(-1, Math.min(1, ((e.beta||45)-45)/35));  // 前後傾斜（以 45° 為中立）
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
    const DARK = 'rgba(30,38,64,0.94)';      // 暗面帶「地照」微透藍灰（真實月相細節，不再死黑）
    // 受光面奶白漸層：高光中心朝太陽方向（waxing 右 / waning 左）+ 邊緣壓暗 → 球體感
    const sunSide = (phase < 0.5) ? 1 : -1;
    const lit = g.createRadialGradient(cx + sunSide*R*0.30, cy - R*0.24, R*0.06, cx, cy, R*1.08);
    lit.addColorStop(0, '#fdfcf4'); lit.addColorStop(0.60, '#e7edf6'); lit.addColorStop(1, '#bbc8da');
    g.save();
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI*2); g.clip();
    g.fillStyle = DARK; g.fillRect(cx-R, cy-R, R*2, R*2);
    const eRx = R * Math.abs(Math.cos(2 * Math.PI * phase));
    // 相位遮罩改 3 層漸縮橢圓 → 柔和的明暗交界線（terminator），不再是銳利剪影 → 立體球
    const softCover = (style, a0, a1) => {
      [[1.08, .38], [1, .80], [0.92, .38]].forEach(([k, aa]) => {
        g.globalAlpha = aa; g.fillStyle = style;
        g.beginPath(); g.ellipse(cx, cy, Math.min(R, eRx * k), R, 0, a0, a1); g.closePath(); g.fill();
      });
      g.globalAlpha = 1;
    };
    g.fillStyle = lit;
    if (phase < 0.5) {                       // waxing：右半受光
      g.beginPath(); g.arc(cx, cy, R, -Math.PI/2, Math.PI/2); g.closePath(); g.fill();
      if (phase < 0.25) softCover(DARK, -Math.PI/2, Math.PI/2);
      else              softCover(lit,   Math.PI/2, -Math.PI/2);
    } else {                                 // waning：左半受光
      g.beginPath(); g.arc(cx, cy, R, Math.PI/2, -Math.PI/2); g.closePath(); g.fill();
      const p2 = phase - 0.5;
      if (p2 < 0.25) softCover(lit, -Math.PI/2, Math.PI/2);
      else           softCover(DARK, Math.PI/2, -Math.PI/2);
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
    _layers.astro.ctx.drawImage(_moonCv, cx-half, cy-half);   // 月亮 → 天體深景層（3D 視差 + 全解析不糊）
  }

  function _drawAstro(t) {
    if (type==='aurora'||type==='sunset'||type==='sunrise'||type==='meteor') return;  // 這些自帶天空/太陽，不要再疊系統日月
    const ga = _layers.astro.ctx;   // 天體深景層：3D 相機下大幅視差、前方雲雨真遮擋、全解析不糊
    const nowMin = _locNowMin();
    const lx = W * 0.04, rx = W * 0.96;
    const horizonY = H * 0.88, peakY = H * 0.08;

    if (_wd.isDay) {
      // 白天淡月（真實天文）：月亮在地平線上、天氣晴朗時，白晝天空也掛一輪極淡的月
      const dimD = _astroDim();
      if (dimD > 0.35) {
        const mp = _moonProg(nowMin);
        if (mp != null && Math.sin(_wd.moonPhase * Math.PI) >= 0.05) {
          const mx = lx + mp * (rx - lx), my = horizonY - (horizonY - peakY) * Math.sin(mp * Math.PI);
          ga.save(); ga.globalAlpha = 0.16 * dimD;
          _drawMoonPhase(mx, my, 22, _wd.moonPhase);
          ga.restore();
        }
      }
      if (type === 'thunder' || type === 'sunny' || type === 'partly') return; // 這些由 dSunny 自畫太陽（淡月已畫）
      const rise = _wd.sunRiseMin, set = _wd.sunSetMin;
      if (nowMin < rise || nowMin > set) return;
      const prog = (nowMin - rise) / (set - rise);
      const sx = lx + prog * (rx - lx);
      const sy = horizonY - (horizonY - peakY) * Math.sin(prog * Math.PI);
      // horizon warmth near sunrise/sunset
      const edgeFade = Math.min(prog, 1 - prog) * 6; // 0 at edges → 1 past 1/6 of day
      // arc guide
      ga.save();
      ga.beginPath();
      for (let p = 0; p <= 1; p += 0.025) {
        const ax = lx + p * (rx - lx);
        const ay = horizonY - (horizonY - peakY) * Math.sin(p * Math.PI);
        p === 0 ? ga.moveTo(ax, ay) : ga.lineTo(ax, ay);
      }
      ga.strokeStyle = 'rgba(255,200,60,0.07)';
      ga.lineWidth = 1; ga.setLineDash([3, 9]); ga.stroke(); ga.setLineDash([]);
      // opacity by weather, boosted near horizon
      let al = 1.0;
      if (type==='storm'||type==='overcast') al=0.15; else if (type==='rain'||type==='drizzle') al=0.35;
      else if (type==='fog') al=0.50; else if (type==='cloudy'||type==='windy') al=0.62;
      al = Math.max(al, edgeFade < 1 ? 0.80 : 0); // sunrise/sunset always bright
      ga.globalAlpha = al;
      // horizon glow at low prog (sunrise) or high prog (sunset)
      if (edgeFade < 1) {
        const hg = ga.createRadialGradient(sx, horizonY, 0, sx, horizonY, W * 0.35);
        hg.addColorStop(0, 'rgba(255,160,40,0.22)'); hg.addColorStop(1, 'rgba(0,0,0,0)');
        ga.fillStyle = hg; ga.fillRect(0, 0, W, H);
      }
      _sunHalo(ga, sx, sy);   // 22° 日暈
      // glow
      const glow = ga.createRadialGradient(sx,sy,0,sx,sy,62);
      glow.addColorStop(0,'rgba(255,240,100,0.45)'); glow.addColorStop(0.42,'rgba(255,160,30,0.15)'); glow.addColorStop(1,'rgba(0,0,0,0)');
      ga.fillStyle=glow; ga.beginPath(); ga.arc(sx,sy,62,0,Math.PI*2); ga.fill();
      // disc（3D 球體 + 電漿表面）
      _drawSun3D(ga, sx, sy, 17, t);
      // corona pulse
      const pls = 0.5+0.5*Math.sin(t*1.4);
      ga.strokeStyle=`rgba(255,210,55,${0.13+0.07*pls})`; ga.lineWidth=1.5;
      ga.beginPath(); ga.arc(sx,sy,23+pls*3,0,Math.PI*2); ga.stroke();
      ga.globalAlpha=1; ga.restore();
    } else {
      if (type === 'thunder') return; // 雷雨自己處理；夜空(night)等其餘夜間天氣都走這條
      /* ── 夜間天文全餐（所有夜間天氣都有，依天氣/雲量減光）：銀河 → 星空 → 星座 → 行星 → 月亮 ── */
      const dim = _astroDim();
      if (dim > 0.05) {
        if (dim > 0.32) _milkyWay(Math.min(1, (dim - 0.32) / 0.5) * 0.9);   // 銀河：天氣稍好就浮現
        if (type !== 'night') {                               // night 型的星空由 dNight 畫（含高光），避免雙重
          stars.forEach(p => {
            const raw = Math.max(0, .34 + .66 * Math.sin(t * p.sp + p.ph));
            const a = raw * dim;
            if (a <= 0.02) return;
            ga.fillStyle = `rgba(${p.col||'228,238,255'},${a.toFixed(3)})`;
            ga.beginPath(); ga.arc(p.x, p.y, raw > .6 ? p.r * 1.25 : p.r * .9, 0, 6.283); ga.fill();
            if (raw > .8 && p.r > 1.2) _starSpike(ga, p.x, p.y, p.r * 3.6, a);
          });
        }
        _drawConstellations(t, dim);                          // 真實星座（北斗/獵戶/仙后/夏季大三角/天蠍）
        _drawPlanets(t);                                      // 行星：原只在晴夜，現所有夜間天氣（內部依雲量減光）
      }
      /* 月亮（比例制升落弧線） */
      const phase = _wd.moonPhase;
      const vis = Math.sin(phase * Math.PI);
      if (vis < 0.02) return; // true new moon, skip
      const prog = _moonProg(nowMin);
      if (prog == null) return;                               // 月亮不在天上
      const mx = lx + prog * (rx - lx);
      const my = horizonY - (horizonY - peakY) * Math.sin(prog * Math.PI);
      let al = Math.max(0.18, vis) * 0.92; // floor so near-new-moon still faintly shows
      if (type==='storm'||type==='overcast') al*=0.42; else if (type==='rain'||type==='drizzle') al*=0.55; else if (type==='fog'||type==='windy') al*=0.65;
      ga.save(); ga.globalAlpha = al;
      const mglow = ga.createRadialGradient(mx,my,0,mx,my,90);
      mglow.addColorStop(0,'rgba(180,210,255,0.22)'); mglow.addColorStop(1,'rgba(0,0,0,0)');
      ga.fillStyle=mglow; ga.beginPath(); ga.arc(mx,my,90,0,Math.PI*2); ga.fill();
      _drawMoonPhase(mx, my, (type==='night'?30:26), phase); // 晴朗夜空月亮放大
      ga.globalAlpha=1; ga.restore();
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
  const _PZH = { Mercury:'水星', Venus:'金星', Mars:'火星', Jupiter:'木星', Saturn:'土星', Uranus:'天王星', Neptune:'海王星' };

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
      out.push({ c:p.c, az, alt, mag, zh:_PZH[p.name] || p.name });
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
    const ga=_layers.astro.ctx;                              // 行星 → 天體深景層（3D 視差 + 全解析）
    const cloudDim=1-Math.min(1,(_wd.cloudCover||0)/100)*0.4;   // 雲多調暗但保有下限（裝飾優先）
    for(const p of _planetCache.list){
      const pos=_skyXY(p.az,p.alt); if(!pos) continue;
      const x=pos.x, y=pos.y;
      let r=2.8-p.mag*0.55; r=Math.max(1.1,Math.min(4.4,r));            // 最小尺寸提高 → 暗行星也看得到
      let a=(1.45-p.mag*0.16); a=Math.max(0.42,Math.min(1,a))*cloudDim; // 亮度下限提高
      const tw=0.86+0.14*Math.sin(t*1.6+x*0.05);            // 微閃爍
      const [cr,cg,cb]=p.c;
      ga.save();
      if(r>1.8){                                            // 含火星/土星等較亮行星加光暈
        const g=ga.createRadialGradient(x,y,0,x,y,r*3.2);
        g.addColorStop(0,`rgba(${cr},${cg},${cb},${(0.45*a*tw).toFixed(3)})`); g.addColorStop(1,'rgba(0,0,0,0)');
        ga.fillStyle=g; ga.beginPath(); ga.arc(x,y,r*3.2,0,Math.PI*2); ga.fill();
      }
      if (!_lowFx) { ga.shadowBlur=r*2.4; ga.shadowColor=`rgba(${cr},${cg},${cb},${(0.85*a).toFixed(3)})`; }  // 手機關 shadowBlur（已有漸層光暈墊著）
      ga.fillStyle=`rgba(${cr},${cg},${cb},${(a*tw).toFixed(3)})`;
      ga.beginPath(); ga.arc(x,y,r,0,Math.PI*2); ga.fill();
      ga.shadowBlur=0;
      // 科技 HUD：內圈旋轉虛線環 + 外圈反向旋轉「目標括號」（4 段弧，像鎖定框）
      ga.strokeStyle=`rgba(120,225,255,${(0.55*a).toFixed(3)})`;
      ga.lineWidth=.9; ga.setLineDash([4,5]); ga.lineDashOffset=-t*6;
      ga.beginPath(); ga.arc(x,y,r*3.2+3,0,Math.PI*2); ga.stroke();
      ga.setLineDash([]);
      const R2=r*3.2+8, a0=-t*0.7;
      ga.strokeStyle=`rgba(170,240,255,${(0.75*a).toFixed(3)})`; ga.lineWidth=1.4;
      for(let k2=0;k2<4;k2++){
        const s0=a0+k2*Math.PI/2;
        ga.beginPath(); ga.arc(x,y,R2,s0,s0+0.5); ga.stroke();
      }
      // 精確讀數：固定 4 向細刻線 + 45° 引線 + 名稱/視星等標籤（儀器感）
      ga.lineWidth=1; ga.strokeStyle=`rgba(150,235,255,${(0.6*a).toFixed(3)})`;
      ga.beginPath();
      for(let k3=0;k3<4;k3++){
        const ang=k3*Math.PI/2;
        ga.moveTo(x+Math.cos(ang)*(R2+2), y+Math.sin(ang)*(R2+2));
        ga.lineTo(x+Math.cos(ang)*(R2+6), y+Math.sin(ang)*(R2+6));
      }
      ga.stroke();
      const lx2=x+R2+9, ly2=y-R2-9;
      ga.beginPath(); ga.moveTo(x+R2*0.74, y-R2*0.74); ga.lineTo(lx2, ly2); ga.lineTo(lx2+6, ly2); ga.stroke();
      ga.font='10px ui-monospace, Menlo, monospace'; ga.textAlign='left'; ga.textBaseline='bottom';
      ga.fillStyle=`rgba(180,242,255,${(0.95*a).toFixed(3)})`;
      ga.fillText(p.zh+' '+(p.mag>=0?'+':'')+p.mag.toFixed(1), lx2+8, ly2+4);
      ga.restore();
    }
  }

  /* ── 天文減光：天氣越差/雲越多 → 星空/銀河/星座越暗 ──
     ⚠ 有「下限」設計：這是裝飾性背景不是天文台——天文永遠看得到，天氣只調高低
     （曾因寫實減光在陰天夜把星空壓到 0.08 → 使用者「看不到」）。 */
  function _astroDim() {
    let al = 1;
    if (type==='storm'||type==='thunder') al = 0.45;
    else if (type==='overcast') al = 0.55;          // 陰天自帶灰天幕會再蓋一層 → 下限要更高
    else if (type==='rain'||type==='drizzle'||type==='hail') al = 0.55;
    else if (type==='fog') al = 0.62;
    else if (type==='snow') al = 0.68;
    else if (type==='cloudy'||type==='windy') al = 0.80;
    return al * (1 - Math.min(1, (_wd.cloudCover || 0) / 100) * 0.25);
  }

  /* ── 亮星十字繞射光芒（望遠鏡攝影感 → 科技感）── */
  function _starSpike(g, x, y, len, a) {
    g.strokeStyle = `rgba(215,238,255,${(a * .5).toFixed(3)})`;
    g.lineWidth = .8;
    g.beginPath();
    g.moveTo(x - len, y); g.lineTo(x + len, y);
    g.moveTo(x, y - len); g.lineTo(x, y + len);
    g.stroke();
  }

  /* ── 3D 太陽：限邊減光球體 + 兩層反向慢轉的電漿表面紋理（米粒組織「沸騰」感）── */
  let _sunTexA = null, _sunTexB = null;
  function _bakeSunTex(R, n) {
    const cv = document.createElement('canvas'); cv.width = cv.height = R * 2;
    const g = cv.getContext('2d');
    const base = g.createRadialGradient(R, R, 0, R, R, R);   // 限邊減光：中心亮白金 → 邊緣深金橘（真實太陽特徵）
    base.addColorStop(0, '#FFFDE8'); base.addColorStop(.55, '#FFE99A'); base.addColorStop(.85, '#FFC93C'); base.addColorStop(1, '#F5A623');
    g.fillStyle = base; g.beginPath(); g.arc(R, R, R, 0, 6.283); g.fill();
    for (let i = 0; i < n; i++) {                            // 亮斑/暗斑隨機散佈（表面紋理）
      const a = Math.random() * 6.283, d = Math.sqrt(Math.random()) * R * .92;
      const x = R + Math.cos(a) * d, y = R + Math.sin(a) * d, r = R * (0.06 + Math.random() * 0.16);
      const sg = g.createRadialGradient(x, y, 0, x, y, r);
      sg.addColorStop(0, Math.random() < .5 ? `rgba(255,255,235,${(.10 + Math.random() * .14).toFixed(3)})`
                                            : `rgba(214,120,20,${(.08 + Math.random() * .12).toFixed(3)})`);
      sg.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = sg; g.beginPath(); g.arc(x, y, r, 0, 6.283); g.fill();
    }
    return cv;
  }
  function _drawSun3D(g, x, y, R, t) {
    if (!_sunTexA) { _sunTexA = _bakeSunTex(64, 26); _sunTexB = _bakeSunTex(64, 20); }
    g.save();
    g.beginPath(); g.arc(x, y, R, 0, 6.283); g.clip();
    g.translate(x, y);
    g.rotate(t * 0.05);          g.drawImage(_sunTexA, -R, -R, R * 2, R * 2);
    g.globalAlpha = .55; g.rotate(-t * 0.115); g.drawImage(_sunTexB, -R, -R, R * 2, R * 2);   // 反向第二層 → 表面緩慢翻騰
    g.globalAlpha = 1;
    g.restore();
    const rim = g.createRadialGradient(x, y, R * .8, x, y, R * 1.12);   // 球緣輝光圈（球體感）
    rim.addColorStop(0, 'rgba(255,220,90,0)'); rim.addColorStop(.85, 'rgba(255,190,60,.5)'); rim.addColorStop(1, 'rgba(255,170,40,0)');
    g.fillStyle = rim; g.beginPath(); g.arc(x, y, R * 1.12, 0, 6.283); g.fill();
  }

  /* ── 銀河帶 v2（動畫電影級）：斜跨夜空的「彩色」銀河 ──
     紫/洋紅/青 billow 雲塊 + 白粉亮核 + 蜿蜒暗塵帶 + 700 顆沿帶星塵（三色溫），
     離屏半解析預烤、每幀一次 drawImage。視覺對標新海誠式夜空。 */
  let _mwCv = null, _mwKey = '';
  function _milkyWay(al) {
    const ga = _layers.astro.ctx, key = W + 'x' + H;
    if (key !== _mwKey) {
      _mwKey = key;
      _mwCv = document.createElement('canvas');
      const s2 = 0.5;
      _mwCv.width = Math.ceil(W * s2); _mwCv.height = Math.ceil(H * s2);
      const g = _mwCv.getContext('2d'); g.scale(s2, s2);
      g.save(); g.translate(W * 0.52, H * 0.38); g.rotate(-0.55);
      const LEN = W * 0.62;
      // 1) 底暈：寬幅紫羅蘭光帶（兩層）
      for (const [len, wid, c, a] of [[LEN*1.15, H*0.17, '120,100,220', 0.10], [LEN, H*0.10, '150,120,240', 0.12]]) {
        const gr = g.createRadialGradient(0, 0, 0, 0, 0, len);
        gr.addColorStop(0, `rgba(${c},${a})`); gr.addColorStop(0.6, `rgba(${c},${(a*0.5).toFixed(3)})`); gr.addColorStop(1, `rgba(${c},0)`);
        g.save(); g.scale(1, wid / len); g.fillStyle = gr; g.beginPath(); g.arc(0, 0, len, 0, 6.283); g.fill(); g.restore();
      }
      // 2) billow 彩色雲塊：沿帶 46 顆隨機柔光斑（紫/洋紅/青/藍）→ 銀河的雲狀結構
      const MWC = [[155,107,255], [255,123,213], [91,224,255], [120,140,255]];
      for (let i = 0; i < 46; i++) {
        const tt = Math.random() * 2 - 1;
        const x = tt * LEN, y = (Math.random() * 2 - 1) * H * (0.05 + 0.06 * (1 - Math.abs(tt)));
        const r = W * (0.03 + Math.random() * 0.07) * (1.2 - Math.abs(tt) * 0.5);
        const c = MWC[(Math.random() * MWC.length) | 0];
        const a = (0.05 + Math.random() * 0.09) * (1 - Math.abs(tt) * 0.45);
        const gr = g.createRadialGradient(x, y, 0, x, y, r);
        gr.addColorStop(0, `rgba(${c[0]},${c[1]},${c[2]},${a.toFixed(3)})`); gr.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 6.283); g.fill();
      }
      // 3) 亮核：白粉強光斑（銀心方向最亮）
      for (const [fx, rr, aa] of [[-0.18, 0.055, 0.30], [0.04, 0.045, 0.38], [0.30, 0.05, 0.26]]) {
        const x = fx * LEN, y = (Math.random() - 0.5) * H * 0.02;
        const gr = g.createRadialGradient(x, y, 0, x, y, W * rr);
        gr.addColorStop(0, `rgba(255,230,245,${aa})`); gr.addColorStop(0.5, `rgba(240,180,235,${(aa*0.5).toFixed(3)})`); gr.addColorStop(1, 'rgba(240,180,235,0)');
        g.fillStyle = gr; g.beginPath(); g.arc(x, y, W * rr, 0, 6.283); g.fill();
      }
      // 4) 暗塵帶：沿中軸蜿蜒的暗斑（真實銀河的分裂感）
      for (let i = 0; i < 9; i++) {
        const tt = -0.8 + i * 0.2 + (Math.random() - 0.5) * 0.05;
        const x = tt * LEN, y = Math.sin(tt * 3.1) * H * 0.018 + (Math.random() - 0.5) * H * 0.012;
        const r = W * (0.025 + Math.random() * 0.03);
        const gr = g.createRadialGradient(x, y, 0, x, y, r);
        gr.addColorStop(0, 'rgba(8,6,24,0.34)'); gr.addColorStop(1, 'rgba(8,6,24,0)');
        g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 6.283); g.fill();
      }
      // 5) 沿帶密集星塵 ×700（三色溫：粉白/冰藍/暖白）
      for (let i = 0; i < 700; i++) {
        const tt = Math.random() * 2 - 1;
        const spread = H * 0.09 * (1 + (1 - Math.abs(tt)) * 1.1);
        const x = tt * LEN * 1.05, y = (Math.random() * 2 - 1) * spread;
        const a = ((0.08 + Math.random() * 0.50) * (1 - Math.abs(tt) * 0.4)).toFixed(3);
        const hue = Math.random();
        g.fillStyle = hue < 0.25 ? `rgba(255,210,235,${a})` : hue < 0.5 ? `rgba(180,220,255,${a})` : `rgba(225,232,255,${a})`;
        const r = Math.random() < 0.9 ? 0.7 : 1.4;
        g.fillRect(x, y, r, r);
      }
      g.restore();
    }
    ga.save(); ga.globalAlpha = al; ga.drawImage(_mwCv, 0, 0, W, H); ga.restore();
  }

  /* ── 星座（真實天文）：J2000 赤經/赤緯 → 當地恆星時 → 地平座標，與行星同一套 _skyXY 投影 ──
     s=[RA°, Dec°, 視星等, 暖色 0藍白~1紅]；l=星點索引連線。每 2 分鐘重算快取。 */
  const _CONSTS = [
    { s:[[165.93,61.75,1.79,.15],[165.46,56.38,2.37,.1],[178.46,53.69,2.44,.1],[183.86,57.03,3.31,.1],[193.51,55.96,1.77,.1],[200.98,54.93,2.27,.1],[206.89,49.31,1.86,.05]],
      l:[[0,1],[1,2],[2,3],[3,0],[3,4],[4,5],[5,6]] },                                   // 北斗七星
    { s:[[88.79,7.41,0.42,.9],[81.28,6.35,1.64,.1],[85.19,-1.94,1.77,.1],[84.05,-1.20,1.69,.1],[83.00,-0.30,2.23,.1],[86.94,-9.67,2.09,.1],[78.63,-8.20,0.13,0]],
      l:[[0,2],[1,4],[2,3],[3,4],[2,5],[4,6]] },                                         // 獵戶座（參宿四紅、參宿七藍白）
    { s:[[2.29,59.15,2.27,.1],[10.13,56.54,2.24,.5],[14.18,60.72,2.47,.1],[21.45,60.24,2.68,.1],[28.60,63.67,3.38,.1]],
      l:[[0,1],[1,2],[2,3],[3,4]] },                                                     // 仙后座 W
    { s:[[279.23,38.78,0.03,0],[310.36,45.28,1.25,.05],[297.70,8.87,0.77,.1]],
      l:[[0,1],[1,2],[2,0]] },                                                           // 夏季大三角（織女/天津四/牛郎）
    { s:[[247.35,-26.43,1.06,.95],[240.08,-22.62,2.29,.2],[263.40,-37.10,1.62,.1]],
      l:[[1,0],[0,2]] },                                                                 // 天蠍座（心宿二紅超巨星）
  ];
  function _lstDeg(date, lon) {              // 地方恆星時（度）——與 _computePlanets 同式
    const d = _dayNum(date), so = _orbit(_SUN_EL, d);
    const ut = date.getUTCHours() + date.getUTCMinutes()/60 + date.getUTCSeconds()/3600;
    return _rev((_rev(so.v + so.w + 180) / 15 + ut) * 15 + lon);
  }
  let _constCache = { at: 0, list: [] };
  function _computeConsts(lat, lon, date) {
    const lst = _lstDeg(date, lon);
    return _CONSTS.map(c => c.s.map(([ra, dec, mag, warm]) => {
      const ha = _rev(lst - ra);
      const x1 = _cosd(ha)*_cosd(dec), y1 = _sind(ha)*_cosd(dec), z1 = _sind(dec);
      const xh = x1*_sind(lat) - z1*_cosd(lat), yh = y1, zh = x1*_cosd(lat) + z1*_sind(lat);
      const pos = _skyXY(_rev(_atan2d(yh, xh) + 180), _atan2d(zh, Math.hypot(xh, yh)));
      return pos ? { x: pos.x, y: pos.y, mag, warm } : null;   // 地平線下/背向 → null
    }));
  }
  function _drawConstellations(t, dim) {
    const ga = _layers.astro.ctx, now = Date.now();
    if (now - _constCache.at > 120000) _constCache = { at: now, list: _computeConsts(_wxLat, _wxLon, new Date()) };
    _constCache.list.forEach((pts, ci) => {
      const def = _CONSTS[ci];
      ga.strokeStyle = `rgba(115,222,255,${(0.10 + 0.24 * dim).toFixed(3)})`; ga.lineWidth = 1;   // 青色發光連線（科技感、含可見下限）
      if (!_lowFx) { ga.shadowBlur = 4; ga.shadowColor = 'rgba(115,222,255,.7)'; }
      ga.beginPath();
      def.l.forEach(([a, b]) => { const p = pts[a], q = pts[b]; if (p && q) { ga.moveTo(p.x, p.y); ga.lineTo(q.x, q.y); } });
      ga.stroke(); ga.shadowBlur = 0;
      pts.forEach(p => {
        if (!p) return;
        let r = 2.6 - p.mag * 0.45; r = Math.max(1.1, Math.min(2.8, r));
        const tw = 0.8 + 0.2 * Math.sin(t * 1.8 + p.x * 0.07);
        const al = Math.min(1, 1.25 - p.mag * 0.18) * dim * tw;
        const cr = Math.round(200 + 55*p.warm), cg = Math.round(215 - 30*p.warm), cb = Math.round(255 - 110*p.warm);
        ga.fillStyle = `rgba(${cr},${cg},${cb},${al.toFixed(3)})`;
        ga.beginPath(); ga.arc(p.x, p.y, r, 0, 6.283); ga.fill();
        if (p.mag < 1.0) {                                   // 一等星：十字光芒 + 節點細環（HUD）
          _starSpike(ga, p.x, p.y, r * 3.4, al);
          ga.strokeStyle = `rgba(120,225,255,${(0.30 * dim).toFixed(3)})`; ga.lineWidth = .8;
          ga.beginPath(); ga.arc(p.x, p.y, r + 3, 0, 6.283); ga.stroke();
        }
      });
    });
  }

  /* 黃道弧視覺已依使用者要求整組移除（宮位符號→刻度→虛線→脈衝光點）；行星/鎖定環保留 */

  /* ── 太陽系即時儀（orrery）：八大行星「真實位置」俯視圖（北黃極往下看）──
     位置取自既有 Schlyter 軌道計算（日心黃經/距離，2 分鐘快取），地球＝太陽地心位置反推；
     半徑對數壓縮（0.39~30AU 塞進小圓盤），行星畫在「當前真實距離」上 → 水星/火星的離心率
     會真實偏離軌道圈。畫在 fore 層（不隨視差晃、全解析銳利）。 */
  /* 太陽系儀的迷你立體星球：每顆烤成帶球面光影的 sprite（光源在左、畫時旋轉朝向中心太陽）。
     土星環 / 木星條紋帶 / 地球大陸+雲絲；大小依真實相對尺寸手調壓縮。順序＝水金地火木土天海 */
  let _orrSpr = null;
  function _bakeOrrPlanets() {
    const DEF = [
      { c:[185,160,126], sz:1.7 },                    // 水星
      { c:[244,236,203], sz:2.3 },                    // 金星
      { c:[ 90,150,235], sz:2.4, earth:true },        // 地球
      { c:[217, 96, 59], sz:1.9 },                    // 火星
      { c:[231,211,161], sz:4.6, bands:true },        // 木星（條紋帶）
      { c:[227,201,138], sz:3.9, ring:true },         // 土星（環）
      { c:[166,224,230], sz:3.0 },                    // 天王星
      { c:[ 93,123,228], sz:3.0 },                    // 海王星
    ];
    return DEF.map(d => {
      const R = 16, Wc = d.ring ? 88 : 48, Hc = 48, cx2 = Wc / 2, cy2 = 24;
      const cv = document.createElement('canvas'); cv.width = Wc; cv.height = Hc;
      const g = cv.getContext('2d');
      const [r, gg, b] = d.c;
      g.save(); g.beginPath(); g.arc(cx2, cy2, R, 0, 6.283); g.clip();
      g.fillStyle = `rgb(${r},${gg},${b})`; g.fillRect(cx2 - R, cy2 - R, R * 2, R * 2);
      if (d.bands) {                                  // 木星：赤道暗帶/亮區
        g.globalAlpha = .38;
        [[-9, 5, '#A0703C'], [-1, 4, '#C9A06B'], [6, 5, '#9C6B40']].forEach(([y, h, c2]) => { g.fillStyle = c2; g.fillRect(cx2 - R, cy2 + y, R * 2, h); });
        g.globalAlpha = 1;
      }
      if (d.earth) {                                  // 地球：大陸綠斑 + 白雲絲
        g.fillStyle = 'rgba(96,180,96,.85)';
        [[-6, -4, 6], [3, 2, 5], [-2, 8, 4]].forEach(([x, y, rr]) => { g.beginPath(); g.arc(cx2 + x, cy2 + y, rr, 0, 6.283); g.fill(); });
        g.fillStyle = 'rgba(255,255,255,.5)';
        [[-4, 3, 7, 2], [2, -7, 8, 2]].forEach(([x, y, w2, h2]) => g.fillRect(cx2 + x, cy2 + y, w2, h2));
      }
      // 球面光影：左受光高光 → 右側落入黑夜（terminator）→ 立體球
      const sh = g.createRadialGradient(cx2 - R * .55, cy2 - R * .2, R * .15, cx2, cy2, R * 1.25);
      sh.addColorStop(0, 'rgba(255,255,255,.55)');
      sh.addColorStop(.45, 'rgba(255,255,255,0)');
      sh.addColorStop(.75, 'rgba(0,0,12,.35)');
      sh.addColorStop(1, 'rgba(0,0,18,.78)');
      g.fillStyle = sh; g.fillRect(cx2 - R, cy2 - R, R * 2, R * 2);
      g.restore();
      if (d.ring) {                                   // 土星環：外亮環 + 內暗環
        g.strokeStyle = 'rgba(214,194,150,.9)'; g.lineWidth = 2.2;
        g.beginPath(); g.ellipse(cx2, cy2, R * 1.95, R * .52, -0.28, 0, 6.283); g.stroke();
        g.strokeStyle = 'rgba(160,140,104,.55)'; g.lineWidth = 1;
        g.beginPath(); g.ellipse(cx2, cy2, R * 1.55, R * .40, -0.28, 0, 6.283); g.stroke();
      }
      return { cv, sz: d.sz, half: Wc / 2, hh: Hc / 2 };
    });
  }

  let _orrCache = { at: 0, list: [], earth: null };
  function _drawOrrery() {
    const g = _layers.fore.ctx;
    let R, cx, cy;
    // 手機/iPad（手機版 UI，非僅 _lowFx：iPad 螢幕大不算 lowFx 但介面同手機）：
    // 只在「自選」分頁顯示（body.m-tab-watch，main.js setTab 掛的），置中放大當背景儀表
    const _mobUI = (typeof isMobileUI === "function") ? isMobileUI() : _lowFx;
    if (_mobUI) {
      if (!document.body.classList.contains('m-tab-watch')) return;
      R = Math.min(W, H) * 0.34;
      cx = W * 0.5; cy = H * 0.38;
    } else {
      R = Math.min(W, H) * 0.19;                                                  // 桌面：右中（landing 城堡在下半，不擋）
      cx = W - R - Math.max(18, W * 0.025); cy = H * 0.46;
    }
    const now = Date.now();
    if (now - _orrCache.at > 120000) {
      const d = _dayNum(new Date());
      const so = _orbit(_SUN_EL, d);
      const list = _PLANETS.map(p => {
        const o = _orbit(p.el, d), iDeg = p.el[1][0] + p.el[1][1] * d;
        const h = _helioXYZ(o, iDeg);
        return { c: p.c, lon: _atan2d(h.y, h.x), r: Math.hypot(h.x, h.y), a: p.el[3][0] };
      });
      _orrCache = { at: now, list, earth: { lon: _rev(so.v + so.w + 180), r: so.r } };   // 地球日心黃經＝太陽地心黃經+180°
    }
    const rad = au => R * (0.16 + 0.84 * Math.log10(au / 0.28) / Math.log10(31 / 0.28));
    const TILT = 0.42;                                                 // 斜上方俯視：y 軸壓縮（軌道面傾斜）
    const B = _lowFx ? 1.1 : 1;          // 手機：儀表畫在自選清單上方（舞台升層），微增亮即可
    g.save(); g.globalAlpha = Math.min(1, 0.92 * B);
    // 底盤暗暈：跟著傾斜壓扁 → 像一塊懸浮的儀表平面
    g.save(); g.translate(cx, cy); g.scale(1, TILT);
    const bg2 = g.createRadialGradient(0, 0, 0, 0, 0, R * 1.18);
    bg2.addColorStop(0, 'rgba(8,16,30,.58)'); bg2.addColorStop(1, 'rgba(8,16,30,0)');
    g.fillStyle = bg2; g.beginPath(); g.arc(0, 0, R * 1.18, 0, 6.283); g.fill();
    g.restore();
    // 雷達掃描線：沿傾斜平面旋轉（科技感）
    const th = (Date.now() * 0.0006) % 6.283;
    g.strokeStyle = `rgba(110,225,255,${Math.min(1,.30*B).toFixed(3)})`; g.lineWidth = 1;
    g.beginPath(); g.moveTo(cx, cy);
    g.lineTo(cx + Math.cos(th) * R, cy - Math.sin(th) * R * TILT); g.stroke();
    // 中心太陽：外層日冕光暈 + 3D 電漿表面（與天上的太陽共用 _drawSun3D → 一樣真實）
    const cor = g.createRadialGradient(cx, cy, 3, cx, cy, 24);
    cor.addColorStop(0, 'rgba(255,236,170,.55)'); cor.addColorStop(.5, 'rgba(255,180,70,.18)'); cor.addColorStop(1, 'rgba(255,160,50,0)');
    g.fillStyle = cor; g.beginPath(); g.arc(cx, cy, 24, 0, 6.283); g.fill();
    _drawSun3D(g, cx, cy, 8, Date.now() * 0.001);
    // 8 顆：水金 + 地球 + 火木土天海。軌道＝傾斜橢圓，遠半圈淡、近半圈亮（縱深）；
    // 行星在「真實當前距離」上，近側放大增亮、遠側縮小變暗 → 立體繞行感
    const all = [..._orrCache.list.slice(0, 2),
                 { c: [110,170,255], lon: _orrCache.earth.lon, r: _orrCache.earth.r, a: 1, earth: true },
                 ..._orrCache.list.slice(2)];
    if (!_orrSpr) _orrSpr = _bakeOrrPlanets();
    all.forEach((p, idx) => {
      const orbR = rad(p.a);
      g.lineWidth = .8; g.setLineDash([3, 4]);
      g.strokeStyle = `rgba(110,220,255,${Math.min(1,.10*B).toFixed(3)})`;   // 遠半圈（上）
      g.beginPath(); g.ellipse(cx, cy, orbR, orbR * TILT, 0, Math.PI, Math.PI * 2); g.stroke();
      g.strokeStyle = `rgba(110,220,255,${Math.min(1,.30*B).toFixed(3)})`;   // 近半圈（下）
      g.beginPath(); g.ellipse(cx, cy, orbR, orbR * TILT, 0, 0, Math.PI); g.stroke();
      g.setLineDash([]);
      const pr2 = rad(Math.max(0.28, p.r));
      const sL = Math.sin(p.lon * _D2R);
      const px = cx + Math.cos(p.lon * _D2R) * pr2, py = cy - sL * pr2 * TILT;
      const near = (1 - sL) / 2;                                        // 0 遠~1 近
      const spr = _orrSpr[idx];
      const vr = spr.sz * (0.72 + 0.55 * near);                         // 視覺半徑（近大遠小）
      const scl = vr / 16;                                              // sprite 球半徑烤 16px
      g.save();
      g.translate(px, py);
      g.rotate(Math.atan2(py - cy, px - cx));                           // 受光面永遠朝向中心太陽（物理正確）
      g.globalAlpha = Math.min(1, (0.62 + 0.38 * near) * B);
      g.drawImage(spr.cv, -spr.half * scl, -spr.hh * scl, spr.cv.width * scl, spr.cv.height * scl);
      g.restore();
      if (p.earth) { g.strokeStyle = 'rgba(120,225,255,.9)'; g.lineWidth = 1; g.beginPath(); g.arc(px, py, vr + 2.6, 0, 6.283); g.stroke(); }   // 地球鎖定圈（我們在這）
    });
    g.restore();   // 英文標籤已依使用者要求移除（純圖像儀表）
  }

  /* ═══════ 白天加料：22°日暈 / 雨後彩虹 / 飛機凝結尾 / 飛鳥群 / 熱氣球 ═══════ */

  /* 22° 日暈：卷雲（中等雲量）時太陽外圈光環，內紅外藍白（真實大氣光學，雲量 ~50% 最明顯） */
  function _sunHalo(g, x, y) {
    const cc = _wd.cloudCover == null ? 50 : _wd.cloudCover;
    const f = Math.max(0, 1 - Math.abs(cc - 50) / 35);
    if (f <= 0.02) return;
    const R = Math.min(W, H) * 0.16;
    const gr = g.createRadialGradient(x, y, R - 8, x, y, R + 16);
    gr.addColorStop(0, 'rgba(255,255,255,0)');
    gr.addColorStop(0.30, `rgba(255,128,84,${(0.14 * f).toFixed(3)})`);   // 內緣偏紅（真實特徵）
    gr.addColorStop(0.55, `rgba(255,236,200,${(0.11 * f).toFixed(3)})`);
    gr.addColorStop(0.85, `rgba(210,230,255,${(0.07 * f).toFixed(3)})`);
    gr.addColorStop(1, 'rgba(210,230,255,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, R + 16, 0, 6.283); g.fill();
  }

  /* 雨後彩虹：雨類→晴/雲類（白天）切換時掛 3 分鐘漸淡的主虹+霓（副虹反序更淡）；far 層（雲後） */
  let _rainbowUntil = 0;
  function _drawRainbow() {
    const now = Date.now();
    if (now >= _rainbowUntil || !_wd.isDay) return;
    const k = Math.min(1, (_rainbowUntil - now) / 150000);
    const g = _layers.far.ctx;
    const cy2 = H * 1.06, r0 = H * 0.78;
    const COLS = ['255,60,60', '255,150,40', '255,220,60', '90,200,90', '70,160,255', '90,90,235', '150,80,220'];
    g.save(); g.lineCap = 'round';
    g.lineWidth = 7;
    COLS.forEach((c, i) => {                                   // 主虹：外紅內紫
      g.strokeStyle = `rgba(${c},${(0.13 * k).toFixed(3)})`;
      g.beginPath(); g.arc(W * 0.5, cy2, r0 - i * 7, Math.PI, Math.PI * 2); g.stroke();
    });
    g.lineWidth = 5;
    COLS.forEach((c, i) => {                                   // 霓：半徑更大、顏色反序、更淡
      g.strokeStyle = `rgba(${c},${(0.045 * k).toFixed(3)})`;
      g.beginPath(); g.arc(W * 0.5, cy2, r0 + 34 + i * 5, Math.PI, Math.PI * 2); g.stroke();
    });
    g.restore();
  }

  /* 飛機凝結尾：偶爾一條高空白色尾跡劃過，沿途暈開消散（far 層）；機頭一點亮 */
  let _ctr = null, _ctrNext = 0;
  function _drawContrail(t) {
    if (!_wd.isDay || ['storm', 'thunder', 'rain', 'drizzle', 'fog', 'hail'].includes(type)) { _ctr = null; return; }
    if (!_ctr) {
      if (!_ctrNext) _ctrNext = t + 15 + Math.random() * 60;
      if (t < _ctrNext) return;
      const ltr = Math.random() < .5;
      _ctr = { x: ltr ? -20 : W + 20, y: H * (0.07 + Math.random() * 0.25),
               vx: (ltr ? 1 : -1) * (1.6 + Math.random() * 1.2),
               vy: (Math.random() - .5) * 0.22, puffs: [], last: 0 };
      _ctrNext = 0;
    }
    const g = _layers.far.ctx, MAXP = _lowFx ? 120 : 220;
    _ctr.x += _ctr.vx; _ctr.y += _ctr.vy;
    if (t - _ctr.last > 0.05) { _ctr.puffs.push({ x: _ctr.x, y: _ctr.y, born: t }); _ctr.last = t; }
    if (_ctr.puffs.length > MAXP) _ctr.puffs.shift();
    let alive = false;
    for (const p of _ctr.puffs) {
      const age = t - p.born;
      const a = 0.30 * (1 - age / 22);                          // ~22 秒暈開消散
      if (a <= 0.004) continue;
      alive = true;
      g.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
      g.beginPath(); g.arc(p.x, p.y, 1.2 + age * 0.28, 0, 6.283); g.fill();
    }
    const off = _ctr.x < -40 || _ctr.x > W + 40;
    if (!off) { g.fillStyle = 'rgba(255,255,255,.9)'; g.beginPath(); g.arc(_ctr.x, _ctr.y, 1.4, 0, 6.283); g.fill(); }
    if (off && !alive) _ctr = null;
  }

  /* 飛鳥群：遠景 V 字雁群（小、慢）+ 近景鳥（大、快），拍翅動畫；好天氣白天偶爾一波 */
  let _flocks = [], _flockNext = 0;
  const _BIRD_OK = ['sunny', 'partly', 'cloudy', 'windy', 'leaves', 'spring', 'mahjong'];
  function _drawBirds(t) {
    if (!_wd.isDay || !_BIRD_OK.includes(type)) { _flocks = []; return; }
    if (!_flockNext) _flockNext = t + 6 + Math.random() * 30;
    if (t >= _flockNext && _flocks.length < 2) {
      const near = Math.random() < 0.4, dir = Math.random() < .5 ? 1 : -1;
      _flocks.push({ near, dir,
        n: near ? 2 + (Math.random() * 2 | 0) : 5 + (Math.random() * 4 | 0),
        x: dir > 0 ? -60 : W + 60,
        y: H * (near ? 0.18 + Math.random() * 0.30 : 0.08 + Math.random() * 0.25),
        sp: (near ? 2.0 : 0.75) * (0.8 + Math.random() * .4), ph: Math.random() * 6.28 });
      _flockNext = t + 24 + Math.random() * 50;
    }
    _flocks = _flocks.filter(f => {
      f.x += f.sp * f.dir;
      const g = f.near ? _layers.near.ctx : _layers.far.ctx;
      const s = f.near ? 7 : 3.6;
      g.strokeStyle = f.near ? 'rgba(40,46,60,.75)' : 'rgba(60,70,90,.55)';
      g.lineWidth = f.near ? 1.6 : 1; g.lineCap = 'round';
      for (let i = 0; i < f.n; i++) {                          // V 字隊形：左右交錯排斜後方
        const row = Math.ceil(i / 2), side = i % 2 ? 1 : -1;
        const bx = f.x - row * s * 2.6 * f.dir, by = f.y + (i ? side * row * s * 1.4 : 0);
        const flap = Math.sin(t * 9 + f.ph + i) * 0.85;        // 拍翅
        g.beginPath();
        g.moveTo(bx - s, by);
        g.quadraticCurveTo(bx - s * .45, by - s * flap, bx, by);
        g.quadraticCurveTo(bx + s * .45, by - s * flap, bx + s, by);
        g.stroke();
      }
      return f.dir > 0 ? f.x < W + 130 : f.x > -130;
    });
  }

  /* 熱氣球：晴朗白天偶爾一顆，隨風向極慢飄過 + 微浮動；sprite 每次隨機配色（mid 層） */
  let _balloon = null, _balloonNext = 0, _balloonCv = null;
  function _bakeBalloon() {
    const cv = document.createElement('canvas'); cv.width = 46; cv.height = 66;
    const g = cv.getContext('2d');
    const PAIRS = [['#E8543F', '#F6E7C1'], ['#3F7FE8', '#EAF2FF'], ['#E8A23F', '#FFF8E8'], ['#7E4FB5', '#F2DFFF'], ['#2FA86E', '#FFF6D9']];
    const [cA, cB] = PAIRS[(Math.random() * PAIRS.length) | 0];
    const bx = 23, by = 22, rx = 19, ry = 20;
    const grd = g.createRadialGradient(bx - 6, by - 7, 3, bx, by, rx + 4);   // 球皮（上側受光）
    grd.addColorStop(0, cB); grd.addColorStop(1, cA);
    g.fillStyle = grd; g.beginPath(); g.ellipse(bx, by, rx, ry, 0, 0, 6.283); g.fill();
    g.strokeStyle = 'rgba(0,0,0,.18)'; g.lineWidth = 1.2;                     // 縱向條紋（gore）
    [0.3, 0.65, 1].forEach(k => { g.beginPath(); g.ellipse(bx, by, rx * k, ry, 0, 0, 6.283); g.stroke(); });
    g.strokeStyle = 'rgba(70,50,30,.8)'; g.lineWidth = 1;                     // 吊繩
    g.beginPath();
    g.moveTo(bx - 7, by + ry - 3); g.lineTo(bx - 4, by + ry + 12);
    g.moveTo(bx + 7, by + ry - 3); g.lineTo(bx + 4, by + ry + 12);
    g.stroke();
    g.fillStyle = '#8A5A2B'; g.fillRect(bx - 6, by + ry + 12, 12, 8);         // 籐籃
    return cv;
  }
  function _drawBalloon(t) {
    if (!_wd.isDay || !['sunny', 'partly', 'cloudy', 'spring', 'leaves'].includes(type)) { _balloon = null; return; }
    if (!_balloon) {
      if (!_balloonNext) _balloonNext = t + 30 + Math.random() * 90;
      if (t < _balloonNext) return;
      const dir = _windVecX() >= 0 ? 1 : -1;
      _balloon = { x: dir > 0 ? -50 : W + 50, dir, y: H * (0.16 + Math.random() * 0.30),
                   sp: 0.18 + Math.random() * 0.14, ph: Math.random() * 6.28, sc: 0.8 + Math.random() * 0.5 };
      _balloonCv = _bakeBalloon();
      _balloonNext = 0;
    }
    _balloon.x += _balloon.sp * _balloon.dir;
    const y = _balloon.y + Math.sin(t * 0.25 + _balloon.ph) * 6;             // 熱氣流微浮動
    const g = _layers.mid.ctx;
    g.save(); g.globalAlpha = .92;
    g.drawImage(_balloonCv, _balloon.x - 23 * _balloon.sc, y - 33 * _balloon.sc, 46 * _balloon.sc, 66 * _balloon.sc);
    g.restore();
    if (_balloon.dir > 0 ? _balloon.x > W + 60 : _balloon.x < -60) _balloon = null;
  }

  /* ═══════ 雨天加料：遠景雨幕 / 水窪反光 / 簷滴 / 小蝸牛 / 小黃鴨 ═══════ */

  /* 遠景雨幕：灰色半透雨簾一片片橫移掃過（far 層）→ 真實雨胞的縱深感 */
  let _curtains = null;
  function _rainCurtains(t, inten) {
    const g = _layers.far.ctx;
    if (!_curtains) _curtains = Array.from({ length: 3 }, () => ({
      x: Math.random() * W, w: W * (0.12 + Math.random() * 0.18),
      sp: 0.35 + Math.random() * 0.45, a: 0.05 + Math.random() * 0.05, ph: Math.random() * 6.28 }));
    const dir = _windVecX() >= 0 ? 1 : -1, lean = _windVecX() * 0.12;
    _curtains.forEach(c => {
      c.x += c.sp * dir;
      if (dir > 0 && c.x - c.w > W) c.x = -c.w; else if (dir < 0 && c.x + c.w < 0) c.x = W + c.w;
      const a = c.a * inten * (0.7 + 0.3 * Math.sin(t * 0.4 + c.ph));
      if (a <= 0.005) return;
      const gr = g.createLinearGradient(c.x, 0, c.x + c.w, 0);
      gr.addColorStop(0, 'rgba(150,170,195,0)');
      gr.addColorStop(0.5, `rgba(150,170,195,${a.toFixed(3)})`);
      gr.addColorStop(1, 'rgba(150,170,195,0)');
      g.save(); g.transform(1, 0, lean, 1, 0, 0);   // 隨風斜切
      g.fillStyle = gr; g.fillRect(c.x, 0, c.w, H);
      g.restore();
    });
  }

  /* 水窪反光：底部積水帶的光柱倒影，隨漣漪左右搖曳（near 層）；冷光為主、偶有暖光 */
  let _pudl = null;
  function _puddles(t, inten) {
    const g = _layers.near.ctx;
    if (!_pudl) _pudl = Array.from({ length: 9 }, () => ({
      x: Math.random() * W, w: 2 + Math.random() * 5, h: H * (0.015 + Math.random() * 0.03),
      ph: Math.random() * 6.28, warm: Math.random() < 0.35 }));
    const y0 = H * 0.985;
    _pudl.forEach(p => {
      const a = inten * (0.10 + 0.10 * Math.sin(t * 1.3 + p.ph));
      if (a <= 0.01) return;
      const sw = Math.sin(t * 2.1 + p.ph) * 1.5;
      const col = p.warm ? '255,205,150' : '170,215,255';
      const gr = g.createLinearGradient(0, y0 - p.h, 0, y0);
      gr.addColorStop(0, `rgba(${col},0)`); gr.addColorStop(1, `rgba(${col},${a.toFixed(3)})`);
      g.fillStyle = gr; g.fillRect(p.x + sw, y0 - p.h, p.w, p.h);
    });
  }

  /* 簷滴：螢幕頂緣醞釀的大水滴墜落 → 觸地大水花+漣漪（near 層，像躲屋簷下看雨） */
  let _eaves = [];
  function _eaveDrips(t, inten) {
    const g = _layers.near.ctx;
    if (_eaves.length < 4 && Math.random() < 0.012 * inten)
      _eaves.push({ x: Math.random() * W, y: 2, vy: 0, grow: 0, r: 2.2 + Math.random() * 1.6 });
    for (let i = _eaves.length - 1; i >= 0; i--) {
      const d = _eaves[i];
      if (d.grow < 1) {                        // 醞釀變大、欲墜
        d.grow += 0.012;
        const rr = d.r * d.grow;
        g.fillStyle = 'rgba(200,228,255,.75)';
        g.beginPath(); g.ellipse(d.x, d.y + rr * 0.6, rr * 0.8, rr, 0, 0, 6.283); g.fill();
        continue;
      }
      d.vy += 0.5; d.y += d.vy;                // 墜落（拉長水滴形）
      g.fillStyle = 'rgba(205,230,255,.8)';
      g.beginPath(); g.ellipse(d.x, d.y, d.r * 0.55, d.r, 0, 0, 6.283); g.fill();
      if (d.y > H * 0.96) {
        for (let k = 0; k < 4; k++) {
          const ang = -Math.PI / 2 + (Math.random() - 0.5) * 1.3, sp = 2 + Math.random() * 3;
          splashes.push({ x: d.x, y: H * 0.963, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, life: 0, max: 12 + Math.random() * 8, a: .6 });
        }
        ripples.push({ x: d.x, y: H * .968, r: 0, maxR: 14 + Math.random() * 8, a: .4 });
        _eaves.splice(i, 1);
      }
    }
  }

  /* 小蝸牛：雨天偶爾一隻慢慢爬過畫面底部，殼帶雨天反光、身體蠕動（fore 層彩蛋） */
  let _snail = null, _snailNext = 0, _snailCv = null;
  function _bakeSnail() {
    const cv = document.createElement('canvas'); cv.width = 36; cv.height = 24;
    const g = cv.getContext('2d');
    g.fillStyle = '#C9A06B'; g.beginPath(); g.ellipse(16, 19, 13, 4.5, 0, 0, 6.283); g.fill();   // 身體
    g.strokeStyle = '#C9A06B'; g.lineWidth = 2; g.lineCap = 'round';                              // 觸角
    g.beginPath(); g.moveTo(27, 17); g.lineTo(31, 11); g.stroke();
    g.beginPath(); g.moveTo(29, 17); g.lineTo(33, 13); g.stroke();
    g.fillStyle = '#7A5A33';
    g.beginPath(); g.arc(31, 10.5, 1.3, 0, 6.283); g.fill();
    g.beginPath(); g.arc(33, 12.5, 1.2, 0, 6.283); g.fill();
    g.fillStyle = '#9A6A3F'; g.beginPath(); g.arc(13, 12, 8.5, 0, 6.283); g.fill();              // 殼
    g.strokeStyle = '#6E4424'; g.lineWidth = 1.4;                                                 // 螺旋
    g.beginPath(); g.arc(13, 12, 5.6, 0.6, 5.6); g.stroke();
    g.beginPath(); g.arc(14.5, 12.5, 2.6, 0.6, 5.2); g.stroke();
    g.fillStyle = 'rgba(255,255,255,.5)';                                                         // 雨天殼面反光
    g.beginPath(); g.ellipse(10, 8.5, 2.8, 1.6, -0.6, 0, 6.283); g.fill();
    return cv;
  }
  function _drawSnail(t) {
    const g = _layers.fore.ctx;
    if (!_snail) {
      if (!_snailNext) _snailNext = t + 15 + Math.random() * 45;
      if (t < _snailNext) return;
      const ltr = Math.random() < .5;
      _snail = { x: ltr ? -40 : W + 40, dir: ltr ? 1 : -1, sp: 0.10 + Math.random() * 0.05, ph: Math.random() * 6.28 };
      if (!_snailCv) _snailCv = _bakeSnail();
      _snailNext = 0;
    }
    _snail.x += _snail.sp * _snail.dir;
    const stretch = 1 + 0.08 * Math.sin(t * 2.2 + _snail.ph);     // 蠕動
    let gy = H - (_lowFx ? 92 : 30);                 // 預設：避開手機底部分頁列/桌面時間軸
    if (document.documentElement.classList.contains('landing-active')) {
      const img = document.querySelector('.landing-stage img');  // 封面：沿城牆頂爬（讀城堡圖實際位置）
      if (img) { const rc = img.getBoundingClientRect(); gy = rc.top + rc.height * 0.30; }
    }
    g.save();
    g.translate(_snail.x, gy);
    g.scale(_snail.dir * 1.6 * stretch, 1.6);
    g.drawImage(_snailCv, -18, -22);
    g.restore();
    if (_snail.dir > 0 ? _snail.x > W + 60 : _snail.x < -60) { _snail = null; _snailNext = t + 12 + Math.random() * 40; }
  }

  /* 小黃鴨：雨天水窪上漂一隻，上下浮動、隨風緩慢漂移（near 層彩蛋，漂約一分鐘） */
  let _duck = null, _duckNext = 0, _duckCv = null;
  function _bakeDuck() {
    const cv = document.createElement('canvas'); cv.width = 36; cv.height = 28;
    const g = cv.getContext('2d');
    g.fillStyle = '#FFD43B'; g.beginPath(); g.ellipse(14, 19, 11, 7, 0, 0, 6.283); g.fill();     // 身體
    g.beginPath(); g.arc(23, 9, 6, 0, 6.283); g.fill();                                          // 頭
    g.fillStyle = '#FF8C2E'; g.beginPath();                                                       // 嘴
    g.moveTo(28, 8); g.lineTo(34, 9.5); g.lineTo(28, 11); g.closePath(); g.fill();
    g.fillStyle = '#3A2E1E'; g.beginPath(); g.arc(24.5, 7.5, 1.1, 0, 6.283); g.fill();           // 眼
    g.strokeStyle = '#E8B62E'; g.lineWidth = 1.4;                                                 // 翅
    g.beginPath(); g.arc(12, 18, 6, -0.6, 1.2); g.stroke();
    return cv;
  }
  function _drawDuck(t, inten) {
    const g = _layers.near.ctx;
    if (!_duck) {
      if (!_duckNext) _duckNext = t + 6 + Math.random() * 14;
      if (t < _duckNext) return;
      _duck = { x: Math.random() * W * 0.8 + W * 0.1, drift: (Math.random() - .5) * 0.06, ph: Math.random() * 6.28, life: 0 };
      if (!_duckCv) _duckCv = _bakeDuck();
      _duckNext = 0;
    }
    _duck.life += 1 / 30;
    const vx = _duck.drift + _windDriftPx() * 0.15;
    _duck.x += vx;
    const bob = Math.sin(t * 1.7 + _duck.ph) * 1.6;               // 隨漣漪上下浮
    const rock = Math.sin(t * 1.1 + _duck.ph) * 0.06;             // 微搖晃
    g.save(); g.globalAlpha = Math.max(0.55, Math.min(1, inten * 1.6));   // 下限：雨勢漸起期間也看得到
    g.translate(_duck.x, H - (_lowFx ? 104 : 44) + bob); g.rotate(rock);   // 上移：避開手機底部分頁列
    g.scale(vx >= 0 ? 1.4 : -1.4, 1.4);
    g.drawImage(_duckCv, -18, -22);
    g.restore();
    if (_duck.life > 60 || _duck.x < -50 || _duck.x > W + 50) { _duck = null; _duckNext = t + 15 + Math.random() * 30; }
  }

  /* 月亮在弧線上的進度（0升~1落）；不在天上 → null。日夜兩分支共用 */
  function _moonProg(nowMin) {
    const rise = _wd.moonRiseMin, set = _wd.moonSetMin;
    if (rise < set) return (nowMin >= rise && nowMin <= set) ? (nowMin - rise) / (set - rise) : null;
    const dur = (1440 - rise) + set;
    if (nowMin >= rise) return (nowMin - rise) / dur;
    if (nowMin <= set) return (1440 - rise + nowMin) / dur;
    return null;
  }

  function _init() {
    const ri = Math.max(0.3, _wd.intensity);          /* precip intensity 0.3-1 */
    const ci = Math.min(1, _wd.cloudCover / 100);      /* cloud cover 0-1 */
    // 星空階層（動畫電影級）：230 顆，~8% 大亮星（會有十字光芒）+ 三色溫（暖白/冰藍/正白）
    stars  = Array.from({length:Math.round(230*_fxN)}, () => {
      const big = Math.random() < 0.08, hue = Math.random();
      return { x:Math.random()*W, y:Math.random()*H*.88,
        r: big ? 1.6+Math.random()*1.2 : .25+Math.random()*1.1,
        col: hue<.22 ? '255,226,200' : hue<.46 ? '185,215,255' : '228,238,255',
        ph:Math.random()*Math.PI*2, sp:.18+Math.random()*.42 };
    });
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
      vy: 0, slide: false, age: Math.random()*500, slideAt: 160 + Math.random()*640,
      ph: Math.random()*6.28, trail: []   // 蜿蜒相位 / 滑落水痕
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
      // （2026-06 全面縮小 ~30%：使用者回饋雲太大，整朵最寬不超過 1/3 螢幕）
      const szMul = (Math.random() < 0.33) ? (1.15 + Math.random()*0.4)  // 大雲 1.15~1.55×
                                           : (0.55 + Math.random()*0.38);// 中小 0.55~0.93×
      return {
        x: Math.random()*W,
        y: isCb ? H*(.10 + Math.random()*.16)        // 積雨雲底部偏低（塔身往上長）
                : H*(.04 + (1-z)*.32 + Math.random()*.18),  // 遠雲偏高、近雲偏低
        // 近大遠小(景深) × 尺寸分級(大/中小)；上限避免大到誇張
        sc: isCb ? scBase*(.7+z*.45)+.02
                 : Math.min(.30, scBase*(.58 + z*.62) * szMul) + Math.random()*.02,
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
  /* ── 立體雲：每朵雲烤一次「體積著色」sprite，之後每幀只 drawImage ──
     配方：雲底柔影 → 基底剪影 → 逐球頂光（source-atop 鎖在剪影內，光從上方來 → 花椰菜球狀立體）
     → 整體底部陰影。比舊版（每幀重畫 path+整片線性漸層）更快也更立體。
     shape===4 為積雨雲；depth(0遠~1近) 控制空氣透視色票；
     layerZ：3D 景深層選擇（預設＝depth）；想要近景色票但仍按 z 分層時可單獨傳（dOvercast） */
  const _cloudSpr = new WeakMap();    // puffs 陣列 → { key: {cv,ox,oy} }（同 puffs 可有 overcast 放大等多鍵）
  function _bakeCloud(puffs, w, conv, flip, depth) {
    const h = w * (conv ? 0.82 : 0.42);
    const ox = Math.ceil(w * 1.15), oy = Math.ceil(h * 1.6);   // 錨點＝呼叫時的 (cx,cy)
    const cv = document.createElement('canvas');
    cv.width = ox * 2; cv.height = oy + Math.ceil(h * 1.0);
    const g = cv.getContext('2d');
    const cx = ox, cy = oy, baseY = cy + h * 0.35;
    // 色票 [頂光, 基底, 球緣暗]：對流雲對比最強 / 遠景霧化藍灰 / 近景亮白
    const pal = conv ? ['rgba(252,254,255,.97)', 'rgba(192,206,230,.93)', 'rgba(70,86,116,.42)']
      : depth < 0.5  ? ['rgba(228,237,249,.88)', 'rgba(182,196,217,.74)', 'rgba(120,136,160,.32)']
                     : ['rgba(255,255,255,.98)', 'rgba(222,236,250,.92)', 'rgba(140,164,196,.40)'];
    // 雲底柔影
    g.globalAlpha = .5;
    const sh = g.createRadialGradient(cx, baseY + h*.16, 0, cx, baseY + h*.16, w*.5);
    sh.addColorStop(0, conv ? 'rgba(38,46,64,.6)' : 'rgba(64,84,116,.5)');
    sh.addColorStop(1, 'rgba(64,84,116,0)');
    g.fillStyle = sh; g.beginPath(); g.ellipse(cx, baseY + h*.18, w*.5, h*.34, 0, 0, 6.283); g.fill();
    g.globalAlpha = 1;
    // 1) 基底剪影
    g.beginPath();
    for (const [fx, fy, fr] of puffs) { const px = cx + fx*w*flip, py = baseY + fy*h, pr = h*fr; g.moveTo(px + pr, py); g.arc(px, py, pr, 0, 6.283); }
    g.fillStyle = pal[1]; g.fill();
    // 2) 逐球頂光（鎖在剪影內）：偏上的高光中心 + 球緣壓暗 → 每球都是立體鼓包
    g.globalCompositeOperation = 'source-atop';
    for (const [fx, fy, fr] of puffs) {
      const px = cx + fx*w*flip, py = baseY + fy*h, pr = h*fr;
      const lg = g.createRadialGradient(px - pr*.30, py - pr*.45, pr*.10, px, py, pr*1.15);
      lg.addColorStop(0, pal[0]); lg.addColorStop(.55, 'rgba(255,255,255,0)'); lg.addColorStop(1, pal[2]);
      g.fillStyle = lg; g.beginPath(); g.arc(px, py, pr, 0, 6.283); g.fill();
    }
    // 3) 整體底部陰影（大尺度體積光影）
    const vg = g.createLinearGradient(0, cy - h*1.05, 0, baseY + h*.30);
    vg.addColorStop(0, 'rgba(255,255,255,0)'); vg.addColorStop(.72, 'rgba(110,130,162,0)'); vg.addColorStop(1, conv ? 'rgba(70,86,118,.5)' : 'rgba(96,114,144,.38)');
    g.fillStyle = vg; g.fillRect(0, 0, cv.width, cv.height);
    g.globalCompositeOperation = 'source-over';
    return { cv, ox, oy };
  }
  function _cloud(cx, cy, w, alpha, shape = 0, flip = 1, depth = 1, puffsOverride = null, layerZ = null) {
    const c2 = _ctxFor(layerZ == null ? depth : layerZ);   // 依景深落 far/mid/near 層 → 相機移動時真透視分離
    const puffs = puffsOverride || _CLOUD_VARIANTS[shape % _CLOUD_VARIANTS.length];
    const conv = shape === 4;
    const key = Math.round(w) + '|' + (conv ? 1 : 0) + '|' + flip + '|' + (depth < 0.5 ? 0 : 1);
    let m = _cloudSpr.get(puffs);
    if (!m) { m = {}; _cloudSpr.set(puffs, m); }
    const e = m[key] || (m[key] = _bakeCloud(puffs, w, conv, flip, depth));
    // 雲半透日夜自適應：夜間 ×0.42（輕紗，星空/軌道透出）；白天 ×0.66（白雲在亮天色上
    // 對比本來就低，太透會直接看不見 → 曾被回報「白天沒有雲」）
    c2.globalAlpha = _wd.isDay ? Math.min(0.74, alpha * 0.66) : Math.min(0.55, alpha * 0.42);
    c2.drawImage(e.cv, cx - e.ox, cy - e.oy);
    c2.globalAlpha = 1;
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
    /* background warm glow → 天空層（最遠的大氣底光；太陽本體/光束留在 mid 層 → 相機移動時微微分離出縱深） */
    const gs = _layers.sky.ctx;
    const bg = gs.createRadialGradient(sx,sy,0,sx,sy,W*.85);
    bg.addColorStop(0,'rgba(255,240,110,.38)'); bg.addColorStop(.45,'rgba(255,165,30,.11)'); bg.addColorStop(1,'rgba(0,0,0,0)');
    gs.save(); gs.globalAlpha=.45+.55*clr; gs.fillStyle=bg; gs.fillRect(0,0,W,H); gs.restore();
    /* 太陽本體與所有光效 → 天體深景層：相機運鏡時大幅視差，前方雲層（far/mid/near）真遮擋 */
    const ga = _layers.astro.ctx;
    _sunHalo(ga, sx, sy);   // 22° 日暈（卷雲時的光環，真實大氣光學）
    /* god rays（體積光束）：自太陽放射的寬柔光錐，緩慢飄、隨晴朗度增強（lighter 疊加發光） */
    ga.save(); ga.globalCompositeOperation='lighter'; ga.translate(sx,sy);
    for (let i=0;i<7;i++){
      const a=sunAngle*0.5 + (i/7)*Math.PI*2 + Math.sin(t*0.18+i)*0.06;
      const len=W*(0.62+0.22*Math.sin(t*0.13+i*1.7)), wid=0.04+0.028*(i%3);
      const lg=ga.createLinearGradient(0,0,Math.cos(a)*len,Math.sin(a)*len);
      lg.addColorStop(0,`rgba(255,242,185,${(0.07*rk).toFixed(3)})`); lg.addColorStop(1,'rgba(255,242,185,0)');
      ga.fillStyle=lg; ga.beginPath(); ga.moveTo(0,0);
      ga.lineTo(Math.cos(a-wid)*len, Math.sin(a-wid)*len);
      ga.lineTo(Math.cos(a+wid)*len, Math.sin(a+wid)*len);
      ga.closePath(); ga.fill();
    }
    ga.restore();
    /* 10 rotating rays */
    ga.save(); ga.translate(sx,sy); ga.lineCap="round";
    for (let i=0;i<10;i++) {
      const a=sunAngle+(i/10)*Math.PI*2, even=i%2===0;
      const len=W*(.28+.05*Math.sin(t*.7+i));
      ga.strokeStyle=even?`rgba(255,230,80,${(.14*rk).toFixed(3)})`:`rgba(255,200,50,${(.07*rk).toFixed(3)})`;
      ga.lineWidth=even?2.5:1.2;
      ga.beginPath(); ga.moveTo(Math.cos(a)*32,Math.sin(a)*32); ga.lineTo(Math.cos(a)*len,Math.sin(a)*len); ga.stroke();
    }
    ga.restore();
    /* pulsing halo rings */
    [55,85,120].forEach((r,i) => {
      ga.strokeStyle=`rgba(255,220,80,${((.20-i*.05)*rk).toFixed(3)})`; ga.lineWidth=i===0?2.5:2;
      ga.beginPath(); ga.arc(sx,sy,r+Math.sin(t*1.1+i)*7,0,Math.PI*2); ga.stroke();
    });
    /* sun disc（3D：限邊減光球體 + 雙層反向慢轉電漿表面） */
    ga.shadowBlur=30; ga.shadowColor="rgba(255,200,0,1)";
    ga.fillStyle="rgba(255,214,80,.95)"; ga.beginPath(); ga.arc(sx,sy,28,0,Math.PI*2); ga.fill();
    ga.shadowBlur=0;
    _drawSun3D(ga, sx, sy, 28, t);
    /* 鏡頭光暈：沿「太陽→畫面中心」連線散布幾個半透明光點（電影感） */
    ga.save(); ga.globalCompositeOperation='lighter';
    const vx=W/2-sx, vy=H/2-sy;
    [[0.5,16,'255,220,140',0.10],[0.92,30,'170,215,255',0.07],[1.22,11,'255,182,200',0.08],[1.65,46,'190,255,210',0.045]].forEach(([d,r,col,al])=>{
      const fx=sx+vx*d, fy=sy+vy*d;
      const fg=ga.createRadialGradient(fx,fy,0,fx,fy,r);
      fg.addColorStop(0,`rgba(${col},${(al*rk).toFixed(3)})`); fg.addColorStop(1,`rgba(${col},0)`);
      ga.fillStyle=fg; ga.beginPath(); ga.arc(fx,fy,r,0,Math.PI*2); ga.fill();
    });
    ga.restore();
    /* sparkles — keep near sun */
    sparks.forEach((p,i) => {
      p.life++;
      if (p.life>p.maxLife) { sparks[i]=_newSpark(); return; }
      const a=Math.sin((p.life/p.maxLife)*Math.PI)*.88;
      if (a>.75) { ga.shadowBlur=5; ga.shadowColor="rgba(255,220,0,.9)"; }
      ga.fillStyle=`rgba(255,242,120,${a})`;
      ga.beginPath(); ga.arc(p.x,p.y,p.r,0,Math.PI*2); ga.fill(); ga.shadowBlur=0;
    });
    /* clouds — draw on top of sun when cloud cover > 0 */
    if (_wd.cloudCover > 5) dCloudy(t);
  }

  function dNight(t) {
    const ga = _layers.astro.ctx;   // 整片夜空（星雲/星星/流星）＝天文 → 天體深景層（3D 視差 + 全解析）
    /* nebula blobs (cached gradients) */
    _gc.nebula.forEach(g => { ga.fillStyle=g; ga.fillRect(0,0,W,H); });
    /* twinkling stars（加亮 + 亮星十字光芒） */
    stars.forEach(p => {
      const a=Math.max(.08, Math.min(1, .32+.72*Math.sin(t*p.sp+p.ph)));
      if (a>.85 && !_lowFx) { ga.shadowBlur=8; ga.shadowColor="rgba(205,225,255,.95)"; }
      ga.fillStyle=`rgba(${p.col||'228,238,255'},${a.toFixed(3)})`;
      ga.beginPath(); ga.arc(p.x,p.y,a>.6?p.r*1.5:p.r,0,Math.PI*2); ga.fill(); ga.shadowBlur=0;
      if (a>.78 && p.r>1.1) _starSpike(ga, p.x, p.y, p.r*4.2, a);
    });
    /* 行星/星座/銀河改由 _drawAstro 統一畫（所有夜間天氣都有），這裡不再重複 */
    /* shooting star */
    shootTimer--;
    if (shootTimer<=0) {
      shootTimer=160+Math.floor(Math.random()*280);
      shootX=Math.random()*W*.75; shootY=Math.random()*H*.35;
      const ang=Math.PI/5+(Math.random()-.5)*.4;
      shootDX=Math.cos(ang)*13; shootDY=Math.sin(ang)*13; shootLen=90+Math.random()*120;
    }
    if (shootLen>0) {
      const tl=ga.createLinearGradient(shootX,shootY,shootX-shootDX*7,shootY-shootDY*7);
      tl.addColorStop(0,"rgba(255,255,255,.93)"); tl.addColorStop(1,"rgba(255,255,255,0)");
      ga.strokeStyle=tl; ga.lineWidth=1.8; ga.shadowBlur=10; ga.shadowColor="white";
      ga.beginPath(); ga.moveTo(shootX,shootY); ga.lineTo(shootX-shootDX*6,shootY-shootDY*6); ga.stroke();
      ga.shadowBlur=0;
      shootX+=shootDX; shootY+=shootDY; shootLen-=Math.hypot(shootDX,shootDY);
    }
    /* 月亮改由 _drawAstro 畫（比例制升落弧線：會隨時間移動、跨裝置一致），這裡不再畫 */
  }

  /* 🛸 淡淡的幽浮：天氣不好時(雨/暴風/雷/冰雹/龍捲/陰/霧)偶爾飄過一隻飛碟，底部青綠微光+
     脈動燈、玻璃圓頂內有外星人剪影。整體低透明度(淡)；飄出畫面後隔一陣子再從另一側重生。 */
  const _UFO_WX = new Set(["rain", "drizzle", "storm", "thunder", "hail", "tornado", "overcast", "fog"]);
  let _ufo = null, _ufoNext = 0;
  function _drawUFO(t) {
    if (!_ufo) {
      if (!_ufoNext) _ufoNext = t + 4 + Math.random() * 10;       // 首次/重生延遲(壞天氣後幾秒現身)
      if (t < _ufoNext) return;
      const ltr = Math.random() < 0.5;
      _ufo = { x: ltr ? -90 : W + 90, dir: ltr ? 1 : -1,
               y: H * (0.10 + Math.random() * 0.22), sp: 0.5 + Math.random() * 0.4,
               ph: Math.random() * 6.28 };
      _ufoNext = 0;
    }
    _ufo.x += _ufo.sp * _ufo.dir;
    if (_ufo.dir > 0 ? _ufo.x > W + 100 : _ufo.x < -100) {        // 飄出 → 隔 14~44s 再來
      _ufo = null; _ufoNext = t + 14 + Math.random() * 30; return;
    }
    const ga = _layers.fore.ctx;   // 畫在最前天氣層 → 微光不被雲雨擋住（仍在 z:2 的 K 棒之後）
    const x = _ufo.x, y = _ufo.y + Math.sin(t * 0.6 + _ufo.ph) * 6;   // 緩慢上下浮
    const R = _lowFx ? 20 : 26;                                       // 碟身半徑（手機略小）
    const pulse = 0.6 + 0.4 * Math.sin(t * 2.2 + _ufo.ph);            // 燈光/微光脈動
    const dR = R * 0.5;                                               // 圓頂半徑
    ga.save();
    ga.globalAlpha = 0.62;                                            // 整體「淡淡」
    // 底部青綠微光（光暈，雙層：大而柔 + 內聚亮核 → 微光更明顯）
    const gl = ga.createRadialGradient(x, y + 5, 2, x, y + 5, R * 2.0);
    gl.addColorStop(0, `rgba(140,255,215,${(0.5 * pulse).toFixed(3)})`);
    gl.addColorStop(0.5, `rgba(120,255,210,${(0.18 * pulse).toFixed(3)})`);
    gl.addColorStop(1, "rgba(120,255,210,0)");
    ga.fillStyle = gl; ga.beginPath(); ga.arc(x, y + 5, R * 2.0, 0, 6.283); ga.fill();
    // 玻璃圓頂
    const dome = ga.createLinearGradient(x, y - dR, x, y);
    dome.addColorStop(0, "rgba(150,230,255,0.55)"); dome.addColorStop(1, "rgba(110,170,210,0.30)");
    ga.fillStyle = dome;
    ga.beginPath(); ga.ellipse(x, y - R * 0.12, dR, dR * 0.9, 0, Math.PI, 2 * Math.PI); ga.fill();
    // 淡淡外星人剪影（大頭）
    ga.fillStyle = "rgba(70,95,85,0.55)";
    ga.beginPath(); ga.ellipse(x, y - R * 0.24, dR * 0.42, dR * 0.52, 0, 0, 6.283); ga.fill();
    // 外星人眼睛（微光）
    ga.fillStyle = `rgba(190,255,235,${(0.7 * pulse).toFixed(3)})`;
    ga.beginPath(); ga.ellipse(x - dR * 0.22, y - R * 0.25, 1.4, 2.3, 0.5, 0, 6.283); ga.fill();
    ga.beginPath(); ga.ellipse(x + dR * 0.22, y - R * 0.25, 1.4, 2.3, -0.5, 0, 6.283); ga.fill();
    // 碟身（扁橢圓）+ 暗邊
    ga.fillStyle = "rgba(158,176,200,0.92)";
    ga.beginPath(); ga.ellipse(x, y, R, R * 0.34, 0, 0, 6.283); ga.fill();
    ga.strokeStyle = "rgba(92,112,142,0.9)"; ga.lineWidth = 1; ga.stroke();
    // 碟底脈動燈（3 顆）
    for (let i = -1; i <= 1; i++) {
      ga.fillStyle = `rgba(120,255,210,${(0.45 + 0.55 * Math.abs(Math.sin(t * 3 + i + _ufo.ph))).toFixed(3)})`;
      ga.beginPath(); ga.arc(x + i * R * 0.5, y + R * 0.17, 1.7, 0, 6.283); ga.fill();
    }
    ga.restore();
  }

  function dCloudy(t) {
    const cdir = _windVecX() >= 0 ? 1 : -1;       // 雲飄移方向跟著風（+右 -左）
    const cwf = 1 + Math.min(3, _wd.windSpeed / 15);   // ★ 雲速也隨風速：無風1×、15km/h 2×、45km/h+封頂4× → 與雨一致、強風不再「雨急雲慢」
    const margin = W*0.6;
    cloudP.forEach((c, i) => {
      c.x += c.sp * cdir * cwf;
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
    // 雨勢起伏：兩組慢週期正弦疊出「一陣大一陣小」的真實節奏（0.55~1 擺動）
    const gust = 0.5 + 0.5 * Math.sin((t||0) * 0.21) * (0.6 + 0.4 * Math.sin((t||0) * 0.047 + 2));
    const intensity = _rainRamp * (0.55 + 0.45 * gust);
    /* stormy sky overlay (cached gradient) — 天色隨雨勢加深 → 天空層 */
    const gs = _layers.sky.ctx, gn = _layers.near.ctx, gf = _layers.fore.ctx;
    gs.save(); gs.globalAlpha = 0.35 + 0.65*intensity; gs.fillStyle=_gc.rainSky; gs.fillRect(0,0,W,H); gs.restore();

    _layers.far.ctx.lineCap = _layers.mid.ctx.lineCap = gn.lineCap = "round";
    // 雨斜度＝直接跟「風速」走（有風就明顯斜、不管風偏東西南北）＋無風也保底斜；方向跟風的東西分量（≈0→預設右、與雲飄一致）
    const _wsgn = _windVecX() >= 0 ? 1 : -1;
    const lean = _wsgn * (0.28 + Math.min(1.1, _wd.windSpeed * 0.026));   // 斜率(無風~16°、20km/h~39°、45km/h+~54°封頂)；雨滴沿此斜率移動(見下)
    // ★ 批次繪製(2026-07-11)：先更新位置、把每滴線段依「層×色×粗細桶×透明桶」分組，再每組一次 stroke
    //   → 原本每滴各自 beginPath+stroke(~300次/幀) 降到 ~數十次；雨滴數/樣子不變(透明度量化 1/40、粗細4桶、肉眼無差)。
    const _rbins = new Map();
    const _wq = w => (w < 0.8 ? 0.6 : w < 1.6 ? 1.2 : w < 2.4 ? 2.0 : 3.0);
    rainP.forEach(p => {
      const n = p.z > 0.55;                          // 近景
      const pa = Math.round(p.a * intensity * 40) / 40;   // 透明度量化(1/40步)
      if (pa > 0.002) {                              // 幾乎全透明就不畫
        const sw = _wq(p.w);
        const lyr = p.z < 0.33 ? 0 : p.z < 0.66 ? 1 : 2;
        const key = lyr + '|' + (n ? 1 : 0) + '|' + sw + '|' + pa;
        let b = _rbins.get(key);
        if (!b) { b = { ctx: _ctxFor(p.z), sw, col: n ? `rgba(200,232,255,${pa})` : `rgba(130,176,224,${pa})`, s: [] }; _rbins.set(key, b); }
        b.s.push(p.x, p.y, p.x + lean * p.len, p.y + p.len);
      }
      p.y += p.spd; p.x += lean * p.spd;              // ★ 沿斜率移動：水平位移=斜率×落速 → 與斜線同向、真的斜著落(不再斜線卻直落)
      if (p.y > H + p.len) {
        if (n && ripples.length < 45 && Math.random() < intensity)   // 雨勢越大、漣漪/水花越多
          ripples.push({ x: p.x, y: H * .968, r: 0, maxR: 6 + Math.random() * 13 * p.z, a: .30 * p.z + .14 });
        if (p.z > 0.7 && splashes.length < 70 && Math.random() < intensity) {  // 近景大雨滴落地 → 向上濺起小水花
          const cnt = 2 + Math.floor(Math.random() * 2);
          for (let k = 0; k < cnt; k++) {
            const ang = -Math.PI / 2 + (Math.random() - 0.5) * 1.15, sp = 1.4 + Math.random() * 2.6 * p.z;
            splashes.push({ x: p.x, y: H * .963, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, life: 0, max: 9 + Math.random() * 8, a: .55 * p.z });
          }
        }
        p.y = -p.len; p.x = Math.random() * (W + 60) - 30;
      }
    });
    _rbins.forEach(b => {                             // 每組(同色同粗細)合成一條 path、一次 stroke
      b.ctx.strokeStyle = b.col; b.ctx.lineWidth = b.sw;
      b.ctx.beginPath();
      const s = b.s;
      for (let i = 0; i < s.length; i += 4) { b.ctx.moveTo(s[i], s[i + 1]); b.ctx.lineTo(s[i + 2], s[i + 3]); }
      b.ctx.stroke();
    });

    /* puddle ripple rings → 近景層（地面在觀者腳前） */
    for (let i=ripples.length-1;i>=0;i--) {
      const rp=ripples[i];
      gn.strokeStyle=`rgba(165,215,255,${rp.a})`; gn.lineWidth=.8;
      gn.beginPath(); gn.ellipse(rp.x,rp.y,rp.r,rp.r*.28,0,0,Math.PI*2); gn.stroke();
      rp.r+=.85; rp.a-=.026;
      if (rp.a<=0) ripples.splice(i,1);
    }

    /* 落地濺起的小水花（重力拋物線）→ 近景層 */
    for (let i=splashes.length-1;i>=0;i--) {
      const s=splashes[i]; s.life++; s.vy+=0.22; s.x+=s.vx; s.y+=s.vy;
      const al=s.a*(1-s.life/s.max);
      if (al<=0 || s.life>=s.max) { splashes.splice(i,1); continue; }
      gn.fillStyle=`rgba(205,230,255,${al.toFixed(3)})`;
      gn.beginPath(); gn.arc(s.x,s.y,1.1,0,Math.PI*2); gn.fill();
    }

    /* wet ground sheen + bottom mist（cached）— 隨雨勢漸起 → 近景層 */
    gn.save(); gn.globalAlpha = intensity;
    gn.fillStyle=_gc.rainGnd; gn.fillRect(0,H*.88,W,H*.12);
    gn.fillStyle=_gc.rainMist; gn.fillRect(0,H*.62,W,H*.38);
    gn.restore();

    /* 雨天加料：遠景雨幕 / 水窪反光 / 簷滴 / 小黃鴨 / 小蝸牛 */
    _rainCurtains(t, intensity);
    _puddles(t, intensity);
    _eaveDrips(t, intensity);
    _drawDuck(t, intensity);
    _drawSnail(t);

    /* 前景玻璃水珠（隔窗看雨）→ fore 層（貼著「窗」、相機移動時靜止 → 與後方雨形成最大反差）；隨雨勢漸起浮現 */
    gf.lineCap="round";
    gf.save(); gf.globalAlpha = Math.min(1, intensity*1.15);
    glassDrops.forEach(d => {
      d.age++;
      if (!d.slide && d.age>d.slideAt) d.slide=true;
      if (d.slide) {
        d.vy += 0.07; d.y += d.vy;
        d.x += Math.sin(d.y * 0.045 + d.ph) * 0.9;            // 蜿蜒：左右扭著流（真實玻璃水痕）
        d.trail.push({ x: d.x, y: d.y });
        if (d.trail.length > 16) d.trail.shift();
        for (let k = 0; k < d.trail.length; k++) {            // 漸淡的水痕珠串
          const tr = d.trail[k], ta = 0.12 * (k / d.trail.length);
          gf.fillStyle = `rgba(205,228,255,${ta.toFixed(3)})`;
          gf.beginPath(); gf.arc(tr.x, tr.y, d.r * 0.32, 0, 6.283); gf.fill();
        }
        if (d.y>H+d.r) { d.x=Math.random()*W; d.y=-d.r; d.vy=0; d.slide=false; d.age=0; d.slideAt=160+Math.random()*640; d.trail.length=0; }
      }
      const g=gf.createRadialGradient(d.x-d.r*0.3, d.y-d.r*0.35, d.r*0.1, d.x, d.y, d.r);
      g.addColorStop(0,'rgba(228,242,255,0.40)'); g.addColorStop(0.6,'rgba(150,186,226,0.16)'); g.addColorStop(1,'rgba(120,160,210,0.03)');
      gf.fillStyle=g; gf.beginPath(); gf.arc(d.x,d.y,d.r,0,Math.PI*2); gf.fill();
      gf.fillStyle='rgba(255,255,255,0.45)'; gf.beginPath(); gf.arc(d.x-d.r*0.32, d.y-d.r*0.36, d.r*0.2, 0, Math.PI*2); gf.fill();
    });
    gf.restore();

    /* 玻璃霧氣凝結：邊緣霧白 vignette 呼吸般淡入淡出（隔窗看雨的濕氣感） */
    if (!_gc.glassFog || _gc.glassFogKey !== W + 'x' + H) {
      _gc.glassFogKey = W + 'x' + H;
      const fg2 = gf.createRadialGradient(W/2, H/2, Math.min(W,H)*0.38, W/2, H/2, Math.max(W,H)*0.72);
      fg2.addColorStop(0, 'rgba(208,224,236,0)'); fg2.addColorStop(1, 'rgba(208,224,236,0.5)');
      _gc.glassFog = fg2;
    }
    gf.save(); gf.globalAlpha = intensity * (0.10 + 0.06 * Math.sin((t||0) * 0.13));
    gf.fillStyle = _gc.glassFog; gf.fillRect(0, 0, W, H); gf.restore();
  }

  function dSnow(t) {
    const wDrift = _windDriftPx();
    snowP.forEach(p => {
      const dx=p.x, dy=p.y;                          // 鏡頭視差交給 3D 相機/層（雪的逐粒分層待 Phase 3）
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
      // 層 ctx 帶基準縮放變換（3D 層解析度補償），不可用絕對 setTransform 蓋掉 → 改 save/translate/rotate
      ctx.save();
      ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.globalAlpha = p.a;
      ctx.drawImage(img, -img.width/2, -img.height/2);
      ctx.restore();
    }
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
    // 灰天幕改畫在最深的天空層：只當「天色」、不再像毛玻璃膜罩在雲/UI 前面（使用者回饋）
    const gsky = _layers.sky.ctx;
    gsky.fillStyle = "rgba(150,160,176,.16)"; gsky.fillRect(0,0,W,H);
    gsky.fillStyle = "rgba(118,128,144,.09)"; gsky.fillRect(0,0,W,H);
    const cdir = _windVecX() >= 0 ? 1 : -1, margin = W*0.6;
    const cwf = 1 + Math.min(3, _wd.windSpeed / 15);   // 雲速隨風速（同 dCloudy）
    cloudP.forEach((c, i) => {
      c.x += c.sp * cdir * cwf;
      if (cdir > 0 && c.x - W*c.sc > W) c.x = -margin;
      else if (cdir < 0 && c.x + W*c.sc < 0) c.x = W+margin;
      // 雲更大、更不透明 → 密雲感（漸層用近景版 depth=1，但 3D 層仍按 c.z 分 → 保有視差）
      _cloud(c.x, c.y + Math.sin(t*.14 + i*1.1)*3, W*c.sc*1.18,
             Math.min(.92, c.al + .28), c.shape, c.flip, 1, c.puffs, c.z);
    });
  }

  /* ── 毛毛雨/微雨：稀疏細小雨絲、無漣漪無暴風天幕（比 rain 輕很多）── */
  function dDrizzle() {
    // 淡灰濛改畫在天空層（同 dOvercast：去毛玻璃膜感）
    _layers.sky.ctx.fillStyle = "rgba(150,165,186,.13)"; _layers.sky.ctx.fillRect(0,0,W,H);
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

  /* ☄️ 流星雨：暗夜 + 星 + 行星，頻繁從上方輻射射出帶光尾的流星（整片夜空 → 天體深景層） */
  function dMeteor(t) {
    const ga = _layers.astro.ctx;
    _gc.nebula && _gc.nebula.forEach(g => { ga.fillStyle=g; ga.fillRect(0,0,W,H); });
    _milkyWay(0.9);   // 彩色銀河（流星雨＝夜空 showcase 模式，全亮）
    stars.forEach(p => {
      const a=Math.max(.06,.25+.7*Math.sin(t*p.sp+p.ph));
      ga.fillStyle=`rgba(${p.col||'222,232,255'},${a.toFixed(3)})`;
      ga.beginPath(); ga.arc(p.x, p.y, a>.6?p.r*1.2:p.r, 0, 6.28); ga.fill();
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
      const tg=ga.createLinearGradient(m.x,m.y,m.x-ux*m.len,m.y-uy*m.len);
      tg.addColorStop(0,`rgba(255,255,255,${(m.a*fade).toFixed(3)})`); tg.addColorStop(1,'rgba(180,210,255,0)');
      ga.strokeStyle=tg; ga.lineWidth=1.6; ga.lineCap='round';
      if (!_lowFx) { ga.shadowBlur=8; ga.shadowColor='rgba(200,225,255,0.8)'; }
      ga.beginPath(); ga.moveTo(m.x,m.y); ga.lineTo(m.x-ux*m.len,m.y-uy*m.len); ga.stroke(); ga.shadowBlur=0;
      ga.fillStyle=`rgba(255,255,255,${(m.a*fade).toFixed(3)})`; ga.beginPath(); ga.arc(m.x,m.y,1.6,0,6.28); ga.fill();
      if (m.life>=m.max || m.y>H+50 || m.x>W+60 || m.x<-60) meteors.splice(i,1);
    }
  }

  /* ── 亮麗天色底（sky 最深層）：每種天氣「白天/黑夜」雙色票，依當地真實日出日落平滑混色 ──
     d=白天、n=黑夜，各 3 個 stop（位置 0/.55/1）的 [r,g,b,a]；黃昏黎明（±40min）自動過渡 →
     雨天鐵灰藍、雨夜深墨藍、晴天蔚藍→暖金地平線、夜空靛藍紫…天色永遠符合「天氣＋時刻」。
     aurora/sunset/sunrise/meteor/tornado/quake 自帶天空 → 不在表內、自然跳過。 */
  const _SKY_BD = {
    sunny:   { d:[[46,111,216,.50],[127,184,240,.28],[255,217,160,.32]], n:[[10,16,48,.55],[22,36,84,.35],[40,30,72,.25]] },
    partly:  { d:[[58,118,205,.45],[140,188,234,.26],[252,222,178,.28]], n:[[12,18,52,.52],[26,40,88,.33],[44,34,76,.24]] },
    cloudy:  { d:[[92,127,168,.42],[159,180,204,.25],[217,201,168,.18]], n:[[18,26,52,.55],[36,48,82,.32],[58,48,80,.22]] },
    windy:   { d:[[96,138,176,.40],[150,176,200,.28],[190,206,222,.20]], n:[[20,30,56,.50],[44,60,90,.30],[70,82,108,.22]] },
    night:   { d:[[16,14,62,.62],[42,30,110,.42],[74,42,122,.30]],       n:[[16,14,62,.62],[42,30,110,.42],[74,42,122,.30]] },   // 豔紫藍動畫夜空
    rain:    { d:[[41,67,95,.50],[56,84,112,.38],[70,99,127,.30]],       n:[[12,20,38,.58],[20,32,52,.44],[30,44,66,.34]] },
    drizzle: { d:[[70,96,120,.40],[90,116,138,.30],[110,134,156,.24]],   n:[[18,28,48,.50],[32,44,64,.36],[46,60,82,.26]] },
    storm:   { d:[[22,34,58,.55],[30,44,68,.44],[38,52,78,.35]],         n:[[8,12,28,.62],[14,20,38,.50],[22,30,50,.38]] },
    thunder: { d:[[14,20,40,.60],[22,30,52,.50],[30,38,64,.40]],         n:[[6,8,24,.65],[10,16,34,.54],[18,24,44,.44]] },
    snow:    { d:[[94,127,166,.35],[150,178,205,.28],[220,233,245,.22]], n:[[24,34,60,.50],[56,74,104,.36],[96,114,144,.28]] },
    fog:     { d:[[143,163,184,.30],[170,188,204,.24],[199,211,222,.20]],n:[[30,38,58,.45],[54,64,84,.36],[82,94,114,.28]] },
    overcast:{ d:[[74,86,104,.45],[96,108,126,.34],[120,132,150,.28]],   n:[[22,28,44,.55],[34,42,60,.42],[50,58,78,.32]] },
    leaves:  { d:[[200,116,44,.28],[160,88,36,.22],[120,62,28,.18]],     n:[[44,28,22,.46],[70,42,26,.32],[96,56,32,.22]] },
    spring:  { d:[[224,143,180,.24],[240,186,212,.18],[255,228,240,.14]],n:[[42,26,50,.42],[80,52,86,.28],[120,82,116,.18]] },
    mahjong: { d:[[31,92,61,.30],[24,72,48,.24],[18,52,36,.20]],         n:[[8,28,20,.45],[12,40,28,.32],[18,52,36,.22]] },
    hail:    { d:[[52,68,92,.45],[70,86,110,.35],[88,104,128,.28]],      n:[[16,24,44,.55],[30,40,62,.40],[44,56,80,.30]] },
  };
  /* 白晝係數：1=全白天、0=全黑夜；日出/日落 ±40min 線性過渡（用當地真實時刻） */
  function _dayK() {
    const m = _locNowMin(), r = _wd.sunRiseMin ?? 360, s = _wd.sunSetMin ?? 1080, T = 40;
    const up = Math.max(0, Math.min(1, (m - (r - T)) / (2 * T)));   // 日出段 0→1
    const dn = Math.max(0, Math.min(1, ((s + T) - m) / (2 * T)));   // 日落段 1→0
    return Math.max(0, Math.min(up, dn));
  }
  /* 流動色彩光暈：每種天氣一對互補色 [colA, colB]，兩團大光暈緩慢繞行（lighter 疊加）
     → 主背景顏色隨時間柔和變化、不再是死板的單一漸層 */
  const _SKY_AC = {
    sunny:[[255,196,84],[84,170,255]],   partly:[[255,200,120],[96,170,250]],
    cloudy:[[150,190,235],[190,160,220]],windy:[[150,210,235],[170,190,230]],
    night:[[120,90,220],[60,190,255]],   rain:[[70,160,220],[90,110,220]],
    drizzle:[[110,180,220],[130,150,220]],storm:[[80,110,200],[120,90,200]],
    thunder:[[100,120,255],[160,90,230]],snow:[[140,200,255],[200,180,255]],
    fog:[[160,190,220],[190,200,230]],   overcast:[[120,150,200],[160,150,200]],
    leaves:[[255,160,70],[220,100,60]],  spring:[[255,150,200],[170,200,255]],
    mahjong:[[90,210,140],[60,170,200]], hail:[[120,170,230],[160,180,240]],
  };
  let _bdGrad = null, _bdKey = '';
  function _drawBackdrop(t) {
    const bd = _SKY_BD[type]; if (!bd) return;
    const gs = _layers.sky.ctx;
    const step = Math.round((1 - _dayK()) * 12);          // 夜化 0..12 量化 → 漸層可快取
    const key = type + '|' + H + '|' + step;
    if (key !== _bdKey) {
      _bdKey = key;
      const k = step / 12, POS = [0, .55, 1];
      _bdGrad = gs.createLinearGradient(0, 0, 0, H);
      for (let i = 0; i < 3; i++) {
        const d = bd.d[i], n = bd.n[i];
        const r = Math.round(d[0] + (n[0] - d[0]) * k), g = Math.round(d[1] + (n[1] - d[1]) * k),
              b = Math.round(d[2] + (n[2] - d[2]) * k), a = d[3] + (n[3] - d[3]) * k;
        _bdGrad.addColorStop(POS[i], `rgba(${r},${g},${b},${a.toFixed(3)})`);
      }
    }
    // 清晰度控制：主圖模式（非 landing）天色/光暈「減半」→ K 線區不蒙霧；
    // 封面（landing）天氣是主角 → 全濃。星/月/軌道/雲等場景元素不受影響、保持清晰。
    const sceneA = document.documentElement.classList.contains('landing-active') ? 1 : 0.5;
    gs.save(); gs.globalAlpha = sceneA;
    gs.fillStyle = _bdGrad; gs.fillRect(0, 0, W, H);
    gs.restore();
    // 雙色流動光暈：互補色兩團緩慢繞行 → 背景色彩持續微妙變化
    const ac = _SKY_AC[type];
    if (ac) {
      gs.save(); gs.globalCompositeOperation = 'lighter';
      const kk = (1 - _dayK() * 0.45) * sceneA;           // 白天收斂一點；主圖模式再減半（清晰）
      for (let i = 0; i < 2; i++) {
        const [r, g2, b] = ac[i];
        const ang = t * (i ? -0.018 : 0.023) + i * 2.6;
        const x = W * 0.5 + Math.cos(ang) * W * 0.33;
        const y = H * (0.32 + 0.30 * i) + Math.sin(ang * 1.3) * H * 0.18;
        const rad = Math.max(W, H) * 0.5;
        const gr = gs.createRadialGradient(x, y, 0, x, y, rad);
        gr.addColorStop(0, `rgba(${r},${g2},${b},${(0.12 * kk).toFixed(3)})`);
        gr.addColorStop(1, 'rgba(0,0,0,0)');
        gs.fillStyle = gr; gs.beginPath(); gs.arc(x, y, rad, 0, 6.283); gs.fill();
      }
      gs.restore();
    }
    // 夜間地平線城市暖光：底緣一抹橙粉（動畫電影的城市光害感）
    const nf2 = 1 - _dayK();
    if (nf2 > 0.4) {
      const hg2 = gs.createLinearGradient(0, H * 0.82, 0, H);
      hg2.addColorStop(0, 'rgba(255,145,95,0)');
      hg2.addColorStop(1, `rgba(255,150,95,${(0.15 * nf2 * sceneA).toFixed(3)})`);
      gs.fillStyle = hg2; gs.fillRect(0, H * 0.82, W, H * 0.18);
    }
    // 品牌暖調和聲：整片極淡暖橘罩 → 天氣場景色溫往主背景（暖褐橘系）靠攏，不與品牌色打架
    gs.fillStyle = `rgba(255,150,88,${(0.035 * sceneA).toFixed(3)})`;
    gs.fillRect(0, 0, W, H);
  }

  /* ── 溫度色調：熱→暖橘、冷→冷藍（全畫面極淡疊色，依實際溫度）→ fore 最前層（罩住所有景深層） ── */
  function _tempTint() {
    if (_wd.temp == null) return;
    const tmp = _wd.temp, gf = _layers.fore.ctx;
    if (tmp >= 28)      { gf.fillStyle = `rgba(255,150,40,${Math.min(.12,(tmp-28)*.012).toFixed(3)})`; gf.fillRect(0,0,W,H); }
    else if (tmp <= 6)  { gf.fillStyle = `rgba(120,170,255,${Math.min(.14,(6-tmp)*.012).toFixed(3)})`; gf.fillRect(0,0,W,H); }
  }

  // ── 「無」天氣牆紙：橘子熊縮成小磁磚 repeat 鋪滿(靜止) + 每秒隨機幾隻亮一下 ──
  let _bearImg = null, _bearReady = false, _bearPat = null, _bearTileSize = 0;
  const _GRID = 6;
  let _bearRot = [];                                   // 6×6 各格旋轉(0~3)→ 亮起時方向與牆紙一致
  let _bearFlashes = [], _bearFlashNext = 0;           // 進行中的脈衝 / 下次生成時間
  let _bearFlashOn = (localStorage.getItem("bearFlashOff") !== "1");  // 閃爍開關(預設開)；關→靜止牆紙保留、只是不亮
  let _bearTilesOn = (localStorage.getItem("bearTiles") === "1");     // 背景磁磚總開關(預設關→「無」天氣=全黑)
  let _bearGold = null;                                 // 金色版熊(亮起時用)：熊形狀填金色
  function _buildGoldBear() {
    const gc = document.createElement("canvas"); gc.width = _bearImg.width; gc.height = _bearImg.height;
    const x = gc.getContext("2d");
    x.drawImage(_bearImg, 0, 0);                        // 先畫熊
    x.globalCompositeOperation = "source-in";          // 只在熊的不透明像素上著色
    const lg = x.createLinearGradient(0, 0, 0, gc.height);
    lg.addColorStop(0, "#FFE79A"); lg.addColorStop(0.5, "#FFD24A"); lg.addColorStop(1, "#F2A93B");  // 亮金漸層
    x.fillStyle = lg; x.fillRect(0, 0, gc.width, gc.height);
    _bearGold = gc;
  }
  (function () { _bearImg = new Image(); _bearImg.onload = () => { _bearReady = true; _buildGoldBear(); }; _bearImg.src = "/static/img/bear-bg.png"; })();
  function _drawBearTiles(t) {
    if (!_bearReady) return;
    const g = _layers.mid.ctx;
    const ts = Math.round(Math.max(22, Math.min(38, Math.min(W, H) * 0.04)));    // 單格邊長(再縮半→數量再×4)
    if (_bearTileSize !== ts || !_bearPat) {
      _bearTileSize = ts;
      // 拼 6×6 區塊：每格一隻熊、隨機朝 東/南/西/北(0/90/180/270°)→ repeat 此區塊(重複週期大、不易看出)
      const bs = ts * _GRID;
      const tc = document.createElement("canvas"); tc.width = bs; tc.height = bs;
      const tcx = tc.getContext("2d");
      const bw2 = ts * 0.72, bh2 = bw2 * (_bearImg.height / _bearImg.width);
      _bearRot = [];
      for (let gy = 0; gy < _GRID; gy++) for (let gx = 0; gx < _GRID; gx++) {
        const r = Math.floor(Math.random() * 4);                                  // 隨機面向
        _bearRot[gy * _GRID + gx] = r;
        tcx.save();
        tcx.translate(gx * ts + ts / 2, gy * ts + ts / 2);                        // 格中心
        tcx.rotate(r * Math.PI / 2);
        tcx.drawImage(_bearImg, -bw2 / 2, -bh2 / 2, bw2, bh2);
        tcx.restore();
      }
      _bearPat = g.createPattern(tc, "repeat");
    }
    // 底牆紙（靜止鋪滿）
    g.save();
    g.globalAlpha = 0.28;                                                         // 疊 stage 基礎透明度(0.28) → 極淡牆紙
    g.fillStyle = _bearPat;
    g.fillRect(0, 0, W, H);
    g.restore();

    // ── 動態：每秒挑幾隻熊亮一下（脈衝發光，淡入淡出）；開關關閉→只保留靜止牆紙 ──
    if (!_bearFlashOn) { _bearFlashes.length = 0; return; }
    const cols = Math.ceil(W / ts), rows = Math.ceil(H / ts);
    if (!_bearFlashNext) _bearFlashNext = t + 0.4;
    if (t >= _bearFlashNext) {
      const n = 6 + Math.floor(Math.random() * 25);                               // 每波 6~30 隻
      for (let i = 0; i < n; i++) {
        _bearFlashes.push({
          cx: Math.floor(Math.random() * cols), cy: Math.floor(Math.random() * rows),
          born: t, dur: 0.7 + Math.random() * 0.6                                 // 0.7~1.3s 各自衰減
        });
      }
      _bearFlashNext = t + 0.6 + Math.random() * 0.5;                             // 約每 0.6~1.1s 一波
    }
    const bw2 = ts * 0.72, bh2 = bw2 * (_bearImg.height / _bearImg.width);
    g.save();
    g.globalCompositeOperation = "lighter";                                       // 加亮疊加 → 真的「亮一下」
    for (let i = _bearFlashes.length - 1; i >= 0; i--) {
      const f = _bearFlashes[i];
      const k = (t - f.born) / f.dur;
      if (k >= 1) { _bearFlashes.splice(i, 1); continue; }
      const glow = Math.sin(k * Math.PI);                                         // 0→1→0 鐘形脈衝
      const r = _bearRot[(f.cy % _GRID) * _GRID + (f.cx % _GRID)] || 0;
      g.save();
      g.globalAlpha = 0.85 * glow;
      g.translate(f.cx * ts + ts / 2, f.cy * ts + ts / 2);
      g.rotate(r * Math.PI / 2);
      const s = 1 + 0.18 * glow;                                                  // 略放大增強亮感
      g.drawImage(_bearGold || _bearImg, -bw2 * s / 2, -bh2 * s / 2, bw2 * s, bh2 * s);  // 亮起=金色熊
      g.restore();
    }
    g.restore();
  }

  // 「無」天氣背景：磁磚關 → 背景元素設純黑＝全黑（不可動 stage 不透明度，否則蓋住圖表）；
  //                  磁磚開或其他天氣 → 還原。stage 維持透明、由 draw() 決定是否鋪磁磚。
  // ⚠ charts-container/html 的背景在 style.css 是 var(--bg) !important → 必須用 inline
  //   setProperty(..., "important") 才壓得過(一般 inline 輸給 stylesheet 的 !important)。
  function _applyOffBlack() {
    const off   = (type === "off");
    const black = off && !_bearTilesOn;   // 無+磁磚關 → 全黑
    const tiles = off &&  _bearTilesOn;    // 無+磁磚開 → 圖表區透明，讓 weatherStage 磁磚牆紙透出
    const setBg = (el, val) => {
      if (!el) return;
      if (val) el.style.setProperty("background", val, "important");
      else     el.style.removeProperty("background");
    };
    const cc = black ? "#000" : tiles ? "transparent" : "";
    setBg(document.querySelector(".charts-container"), cc);
    setBg(document.documentElement, black ? "#000" : "");
    setBg(document.body,            black ? "#000" : "");
    // 磁磚顯示時 → 圖表面板也透明（同 sky-show 機制），否則不透明色帶會把磁磚蓋住
    document.documentElement.classList.toggle("bear-tiles-show", tiles);
  }

  /* ── main loop ── */
  function draw(t) {
    _LAYER_DEFS.forEach(([name]) => _layers[name].ctx.clearRect(0,0,W,H));
    // 「無」模式：磁磚開→鋪橘子熊牆紙；磁磚關→全黑（由 stage 黑底處理，畫布留空）
    if (type === "off") { if (_bearTilesOn) _drawBearTiles(t); return; }
    _applyCamera();              // 3D 相機：平滑移動 perspective-origin（純 GPU 合成、不觸發重繪）
    _drawBackdrop(t);            // 亮麗天色底 + 雙色流動光暈（sky 最深層，最先畫）
    ({sunny:dSunny,night:dNight,cloudy:dCloudy,fog:dFog,rain:dRain,snow:dSnow,storm:dStorm,thunder:dThunder,mahjong:dMahjong,leaves:dLeaves,spring:dSpring,partly:dPartly,overcast:dOvercast,drizzle:dDrizzle,windy:dWindy,hail:dHail,tornado:dTornado,quake:dQuake,aurora:dAurora,sunset:dSunset,sunrise:dSunrise,meteor:dMeteor})[type]?.(t);
    _drawRainbow();              // 雨後彩虹（far 層，白天雨轉晴觸發）
    _drawContrail(t);            // 飛機凝結尾（far 層）
    _drawBirds(t);               // 飛鳥群（far/near 層）
    _drawBalloon(t);             // 熱氣球（mid 層）
    _drawAstro(t);               // 太陽/月亮/行星 → astro 天體深景層（大視差+全解析）；雲/雨各層從前方掠過（真遮擋）
    if (_UFO_WX.has(type)) _drawUFO(t);   // 天氣不好時偶爾飄過淡淡的幽浮（發青綠微光）
    _drawOrrery();               // 太陽系即時儀：八大行星真實位置/軌道（fore 層右中 HUD，斜俯視）
    _tempTint();
  }
  let _fxPenalty = 0;   // 自適應降幀補償(ms)：手機畫不動時拉大幀間隔 → 自動降溫/減卡
  function loop(ts) {
    rafId = requestAnimationFrame(loop);
    if (document.hidden) { _lastClockTs = 0; return; }
    const _now = (performance.now ? performance.now() : Date.now());
    // 圖表移動中（平移/縮放/慣性，或手機剛觸控）→ 背景降到 ~15fps（仍正常速度、不放慢時鐘，
    // 所以看得出在動、不會像凍結），把大部分幀預算讓給圖表 → 主圖滑動順、背景又不停。
    const _moving = (window._chartMoveTs && _now - window._chartMoveTs < 220) ||
                    (_lowFx && _touchT && _now - _touchT < 350);
    const _frameGap = (_moving ? 66 : _frameMin) + _fxPenalty;   // 移動中 ~15fps；平時 桌面~30 / 手機~16(−自適應)
    if (ts - _lastFrameTs < _frameGap) return;
    // 動畫時鐘恆定 1x（正常速度）；只調幀率、不調速度 → 移動時是「低幀率正常動」而非慢動作。
    if (!_lastClockTs) _lastClockTs = ts;
    _animClock += (ts - _lastClockTs);
    _lastClockTs = ts;
    _lastFrameTs = ts;
    const _t0 = performance.now ? performance.now() : Date.now();
    draw(_animClock * 0.001);
    // 自適應降幀（僅手機）：量本幀 draw 耗時；主執行緒吃緊(畫太慢)→漸進拉大幀間隔(最低~8fps)、
    // 恢復則漸收。struggling 的手機會自動降到低幀率 → 總繪製量下降 → 不再卡/燙；順的手機幾乎不觸發。
    if (_lowFx) {
      const _cost = (performance.now ? performance.now() : Date.now()) - _t0;
      if (_cost > 20) _fxPenalty = Math.min(90, _fxPenalty + (_cost > 36 ? 9 : 3));
      else if (_fxPenalty > 0) _fxPenalty = Math.max(0, _fxPenalty - 2);
    }
  }
  let _inited = false;

  // ── 換場：淡化（cross-fade）─────────────────────────────────────
  // 兩個天氣型態之間原本是硬切（_init() 把所有粒子瞬間重隨機 → 畫面跳動）。
  // 改法：切換前把「舊場景」當前畫面同步合成快照到覆蓋層(疊最上、繼承 stage 透明度)，
  // 新場景在底下照常重建；覆蓋層純用 CSS opacity 淡出 → 舊景平滑溶入新景。
  // 關鍵：快照「同步」畫好且立即 opacity:1，只靠 CSS 動透明度、不依賴 rAF 時序 →
  //       不會出現「新場景先閃一幀、特效才接上」的問題。
  let _xfCv = null, _xfHideTimer = null;
  function _crossfade() {
    if (!W || !H) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const bw = Math.round(W * dpr), bh = Math.round(H * dpr);
    if (!_xfCv) {
      _xfCv = document.createElement("canvas");
      _xfCv.className = "wx-xfade";
      _xfCv.style.cssText = "position:absolute;inset:0;width:100%;height:100%;" +
        "transform:translateZ(0);pointer-events:none;z-index:20;";
      stage.appendChild(_xfCv);
    }
    _xfCv.width = bw; _xfCv.height = bh;
    const xc = _xfCv.getContext("2d");
    xc.setTransform(dpr, 0, 0, dpr, 0, 0);
    xc.clearRect(0, 0, W, H);
    // 依 DOM 疊放順序把每層 canvas 同步合成成「舊場景」快照
    stage.querySelectorAll("canvas.wx-layer").forEach(cv => {
      try { xc.drawImage(cv, 0, 0, W, H); } catch (e) {}
    });
    // 立即顯示舊畫面(關 transition 直接 opacity:1)，下一幀起才淡出(此時新場景已在底下重建)
    if (_xfHideTimer) { clearTimeout(_xfHideTimer); _xfHideTimer = null; }
    _xfCv.style.display = "block";
    _xfCv.style.transition = "none";
    _xfCv.style.opacity = "1";
    void _xfCv.offsetWidth;                 // 強制 reflow 套用 opacity:1
    _xfCv.style.transition = "opacity .9s ease";
    _xfCv.style.opacity = "0";
    _xfHideTimer = setTimeout(() => { if (_xfCv) _xfCv.style.display = "none"; }, 1000);
  }

  function start(wt) {
    const changed = wt !== type || !_inited;
    // 真正換型態(非首次、非進出「無」)→ 先快照舊場景做交叉溶解，遮住粒子瞬間重建的跳動
    if (changed && _inited && wt !== "off" && type !== "off") _crossfade();
    // 進入下雨類型時把雨勢 ramp 歸零 → 之後在 dRain 緩升（雨水漸起感）
    const rainy = w => w==='rain'||w==='storm'||w==='drizzle';
    if (rainy(wt) && !rainy(type)) _rainRamp = 0;
    // 雨後彩虹：雨類 → 晴/雲類（白天）→ 掛 3 分鐘漸淡彩虹
    if (['rain','storm','drizzle','thunder','hail'].includes(type) &&
        ['sunny','partly','cloudy','windy'].includes(wt) && _wd.isDay)
      _rainbowUntil = Date.now() + 180000;
    if (wt !== 'quake') document.body.style.transform = '';   // 離開地震 → 畫面歸位
    type = wt;
    // 晴朗夜空（type==='night'）→ 夜空更亮地透出（月亮/星星/行星）
    const wasNight = document.documentElement.classList.contains('sky-night');
    const isNight = wt === 'night';
    document.documentElement.classList.toggle('sky-night', isNight);
    // 全天氣透景（sky-show）：任何非 off 天氣 → 主圖容器轉透明、中央色帶半透明 →
    // 天氣是「主圖後面的 3D 場景」而非疊在 K 線上的濾鏡（generalize 自 sky-night 機制）
    const wasShow = document.documentElement.classList.contains('sky-show');
    const isShow = wt !== 'off';
    document.documentElement.classList.toggle('sky-show', isShow);
    _applyOffBlack();   // 「無」模式且磁磚關 → 全黑背景；其餘還原
    _syncBearWallBtn(); // 🐻 磁磚鈕只在「無」天氣顯示 → 隨型態切換更新
    // 透景/天氣變化時重套主圖漸層（中央色帶透明度隨 night/show、accent 雙色隨天氣型態）
    if (wasNight !== isNight || wasShow !== isShow || changed) window._applyChartBgGradient?.();
    // sky-show 切換 → 量條透明度跟著變(天氣下不透明防閃)，重畫全部量條
    if (wasShow !== isShow && typeof renderVolume === "function" && typeof volSeries !== "undefined" && volSeries
        && typeof ohlcvData !== "undefined" && ohlcvData.length) renderVolume(ohlcvData);
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
    // 手繪定位圖釘（取代 📍 emoji）：水滴 pin + 中心點，橘色 currentColor，套 #mSketch 手繪抖動→與設定面板手繪圖標同風格
    const _PIN = '<svg viewBox="0 0 24 24" width="10" height="11" style="vertical-align:-1.5px;color:var(--accent);margin-right:2px" aria-hidden="true">'+
      '<path d="M12 21.2C12 21.2 5.2 14.4 5.2 9.4 5.2 5.6 8.3 2.8 12 2.8 15.7 2.8 18.8 5.6 18.8 9.4 18.8 14.4 12 21.2 12 21.2Z" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" filter="url(#mSketch)"/>'+
      '<circle cx="12" cy="9.2" r="2.3" fill="currentColor" filter="url(#mSketch)"/></svg>';
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
    // 降雨機率：今日整天 + 當前小時兩值都顯示；浮動卡與設定面板天氣卡共用此行
    const _popLine = (_wd.pop != null || _wd.popNow != null)
      ? '降雨機率　'+(_wd.pop != null ? '今日 <b>'+_wd.pop+'%</b>' : '')+(_wd.popNow != null ? '　此刻 <b>'+_wd.popNow+'%</b>' : '')
      : '';
    // 附近雨區行：有雨(所在地/接近/附近)時橘色highlight，無雨時淡色
    const _near = _nearbyText(_wd.nearby);
    const _nearRain = _wd.nearby && (_wd.nearby.raining_here || _wd.nearby.approaching || _wd.nearby.nearest);
    const _nearLine = _near
      ? '<div style="'+(_nearRain?'color:var(--accent);font-weight:600':'opacity:.6')+'">'+_near+'</div>'
      : '';
    el.innerHTML =
      '<div style="font-size:13px;font-weight:600;letter-spacing:.3px">'+city+_wd.temp+'°C　'+desc+'</div>'+
      '<div style="opacity:.68">風 '+(_wd.windDir==null?'':_dirName(_wd.windDir)+' ')+_wd.windSpeed+' km/h　雲量 '+_wd.cloudCover+'%</div>'+
      '<div style="opacity:.68">降雨 '+_wd.precip+' mm　能見度 '+vis+'</div>'+
      (_popLine ? '<div style="opacity:.68">'+_popLine+'</div>' : '')+
      _nearLine+
      '<div style="opacity:.38;font-size:10px">'+hm+' 更新　'+(_wd.source==='cwa'?'中央氣象署':'Open-Meteo')+
        (window._wxGeoSrc ? '　'+_PIN+window._wxGeoSrc+(window._wxGeoAcc?' ±'+window._wxGeoAcc+'m':'') : '')+'</div>';
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
        (_popLine ? '<div class="wx-pop">'+_popLine+'</div>' : '')+
        (_near ? '<div class="wx-near"'+(_nearRain?' style="color:var(--accent);font-weight:600"':'')+'>'+_near+'</div>' : '')+
        '<div class="wx-foot">'+hm+' 更新　'+(_wd.source==='cwa'?'中央氣象署':'Open-Meteo')+
          (window._wxGeoSrc ? '　'+_PIN+window._wxGeoSrc+(window._wxGeoAcc?' ±'+window._wxGeoAcc+'m':'') : '')+'</div>';
    }
    // 開場首頁上方：依天氣 API 顯示所在地（城市 + 溫度 + 天氣）
    const _lloc = document.getElementById('landingLoc');
    if (_lloc && _wd.city) {                                       // 兩層：城市+天氣 / 溫度+降雨機率（雨滴符號）
      // 封面只顯示「此刻」當前小時降雨機率(沒有則退今日最大)：今日整天最大值常是午後尖峰，
      // 此刻其實 0% → 封面若標一個大「今日100%」會被誤會成現在正在下雨(完整今日/此刻兩值留在天氣卡，已標籤)。
      const _popVal = (_wd.popNow != null) ? _wd.popNow : _wd.pop;
      const _pop = (_popVal != null) ? '　<span class="lloc-pop" title="此刻降雨機率">' + _popVal + '%</span>' : '';
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
    // 「無」(nofx-active) 也是手動覆寫——漏了它 → 按無後 _applyAutoType 60s 又把天氣畫回來。
    if (document.getElementById('noFxToggleBtn')?.classList.contains('nofx-active')) return true;
    return ['leaf','rain','snow','spring','thunder','mahjong','hail','tornado','quake','aurora','meteor'].some(
      w => document.getElementById(w+'ToggleBtn')?.classList.contains(w+'-active'));
  }
  // 解析自動天氣：好天氣(晴/少雲) + 真實日落時段(±45min) → 自動晚霞；否則照後端 _autoType
  function _resolveAutoType() {
    const base = _autoType || 'sunny';
    // 附近雨量站測到「所在地正在下雨」→ 背景就下雨（雨量站比最近氣象站的天氣文字更靈敏，
    // 免「小啊說在下雨、背景卻晴天」的落差）。base 已是雨/雪類則維持不覆蓋。
    if (_wd.nearbyRaining && !['rain','drizzle','storm','thunder','snow'].includes(base)) return 'rain';
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
    _wxLat = lat; _wxLon = lon;   // 自動刷新計時器移到定位流程末尾（改為「重新定位+天氣」，見 _wxRefresh）
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
        _wd.pop         = (d.pop == null) ? null : Math.round(+d.pop);          // 今日整天降雨機率 %（各小時最大）
        _wd.popNow      = (d.pop_now == null) ? null : Math.round(+d.pop_now);  // 當前小時降雨機率 %
        _wd.forecast    = d.forecast || null;                         // 今明兩天預報（給小熊播報）：{today,tomorrow}
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
    fetchNearbyRain(lat, lon);   // 附近雨區偵測（獨立請求，晚到就重繪天氣卡）
  }

  // 附近雨區：抓在地測站網算出的「附近哪裡有雨/會不會往我移動」，存 _wd.nearby 後重繪天氣卡
  function _emitWxUpdated() { try { window.dispatchEvent(new CustomEvent('wx:updated')); } catch (e) {} }
  function fetchNearbyRain(lat, lon) {
    fetch('/api/nearby_rain?lat=' + lat + '&lon=' + lon)
      .then(r => r.json())
      .then(d => {
        _wd.nearby = d;
        _wd.nearbyRaining = !!(d && d.raining_here);   // 附近雨量站測到所在地正在下雨 → 背景跟著下雨
        _renderWeatherCard();
        if (!_isManualOn() && !window._restoreManualWxIfAny?.()) _applyAutoType();  // 背景動畫同步(非手動時)
        _emitWxUpdated();                              // 通知小啊「天氣如何」按鈕更新
      })
      .catch(() => { _emitWxUpdated(); });
  }
  // 附近雨區 → 一行文字（只講「哪個區在下雨」，方向不重要）：
  //   所在地正在下雨 ＞ 某區的雨正往你這來(含ETA) ＞ 大範圍 ＞ 最近有雨的區 ＞ 無雨
  // 雨勢趨勢後綴：增強中／減弱中(明顯減弱且已很小時附粗略轉小時間)；持平/無則空
  function _trendZh(o) {
    if (!o || !o.trend) return '';
    if (o.trend === '減弱中') return o.fade_min ? '，減弱中（約' + o.fade_min + '分內轉小）' : '，減弱中';
    if (o.trend === '增強中') return '，增強中';
    return '';
  }
  function _nearbyText(n) {
    if (!n) return '';
    // 一律先講所在地有沒有下雨，再帶附近
    if (n.raining_here) return '☔ 你所在地正在下雨' + _trendZh(n.nearest);
    const a = n.approaching;
    if (a && a.eta_min != null) {
      const from = a.area ? a.area + '的雨' : '雨';
      const est  = a.by === 'wind' ? '（順風推估）' : '';   // 風向推標不確定；雷達位移/臨近預報則不標
      return '🌂 你這沒下，' + from + '正往你這來，約 ' + a.eta_min + ' 分後到' + est + _trendZh(a);
    }
    if (n.widespread) {   // 半徑內一半以上都在下雨 → 大範圍降雨(往哪走都可能遇到)
      const pct = n.coverage != null ? '約' + Math.round(n.coverage * 10) + '成' : '大片';
      return '🌂 你這沒下，但附近' + pct + '範圍都在下雨';
    }
    const c = n.nearest;
    if (c) {
      const where = c.area || (c.dist_km + 'km外');
      return '🌂 你這沒下，' + where + '有' + (c.scale || '') + c.level + _trendZh(c);
    }
    return '☀️ 你這和附近都沒下雨';
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
  // 給小熊播報天氣預報用：今明兩天 {tmax,tmin,pop,cond} + 當前溫度/降雨機率
  window._getForecast = () => _wd.forecast
    ? { ..._wd.forecast, curTemp: _wd.temp, curPop: _wd.pop } : null;
  // 給小啊「天氣如何？」按鈕 + 每 10 分自動播報用：附近雨區「多情況」詳細（多行）。
  // 只講「哪些區在下雨」(行政區名)，方向不重要；卡片只挑一種摘要，這裡把幾種狀況全列。
  window._getNearbyDetail = function () {
    const n = _wd.nearby;
    if (!n) return null;
    const L = [];
    // ① 先講所在地有沒有下雨
    if (n.raining_here) L.push('☔ 你所在地正在下雨' + _trendZh(n.nearest));
    else L.push('🌂 你所在地目前沒下雨');
    const a = n.approaching;
    if (a && a.eta_min != null) {
      const from = a.area ? a.area + '的雨' : '雨';
      const est = a.by === 'wind' ? '（順風推估）' : '';
      L.push('🛵 ' + from + '正往你這來，約 ' + a.eta_min + ' 分後到' + est + _trendZh(a));
    }
    if (n.widespread) {
      const pct = n.coverage != null ? '約' + Math.round(n.coverage * 10) + '成' : '一大片';
      L.push('🌧️ 附近' + pct + '範圍都在下雨，出門很可能遇到');
    }
    // ② 附近有雨的「區」：只列行政區名（去重、最多 6 個），方向不重要
    const seen = new Set();
    if (n.raining_here && n.nearest && n.nearest.area) seen.add(n.nearest.area);
    if (a && a.area) seen.add(a.area);
    const areas = [];
    for (const c of (n.cells || [])) {
      const nm = c.area || (c.dist_km + 'km外');
      if (seen.has(nm)) continue;
      seen.add(nm);
      areas.push(nm);
      if (areas.length >= 6) break;
    }
    if (areas.length) L.push('🌧️ 附近下雨的區：' + areas.join('、'));
    else if (!n.raining_here && !a && !n.widespread) L.push('☀️ 附近 ' + (n.radius_km || 30) + 'km 內也沒有下雨');
    return L.join('\n');
  };

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
  // 背景磁磚開關（topbar「1M」左側 🐻 按鈕）：開→「無」天氣鋪橘子熊磁磚牆紙(含金色閃爍)；關→全黑。
  // 只在「無」天氣時顯示此鈕（其他天氣型態時磁磚用不到 → 隱藏）。
  function _syncBearWallBtn() {
    const b = document.getElementById("bearWallToggleBtn");
    if (!b) return;
    b.classList.toggle("bearwall-off", !_bearTilesOn);
    b.style.display = (type === "off") ? "" : "none";
  }
  window._bearWallToggle = function () {
    _bearTilesOn = !_bearTilesOn;
    try { localStorage.setItem("bearTiles", _bearTilesOn ? "1" : "0"); } catch (e) {}
    _bearFlashes = [];                                   // 關閉立即清掉殘餘脈衝
    _applyOffBlack();                                    // 立即套用全黑/牆紙背景
    _syncBearWallBtn();
  };
  _syncBearWallBtn();
  window._sunsetToggle  = () => _toggleWx("sunset");
  window._sunriseToggle = () => _toggleWx("sunrise");
  window._meteorToggle  = () => _toggleWx("meteor");

  window.addEventListener("resize", resize);
  resize();
  _initParallax();
  setInterval(_applyAutoType, 60000);   // 每分鐘重評自動天氣（讓晚霞在日落時段自動出現/退場）
  // 立刻先畫一個背景，別等 fetchWeather（定位+API 冷啟動可達 5 秒）才 start()——
  // 否則「刷新後天氣背景空白好幾秒」。優先恢復上次手動選擇，否則用時段自動預設(晴/夜)。
  // 拿到真實天氣後 fetchWeather 會再 start() 一次平滑切換（start 同型即 no-op，型別不同才重建，不位移）。
  if (!_isManualOn() && !window._restoreManualWxIfAny?.()) {
    const _m0 = _locNowMin();   // 本地時段(經度近似)：夜間先起 night 而非亮晴空，避免亮閃
    _wd.isDay = (_m0 >= _wd.sunRiseMin && _m0 < _wd.sunSetMin);
    start(_wd.isDay ? _resolveAutoType() : 'night');
  }

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
        window._wxGeoSrc = 'IP約略'; window._wxGeoAcc = null;   // IP 粗定位：不寫入 wxCoords，避免污染 GPS 快取基準（先前會 IP→存快取→下次先畫IP→GPS超時又IP 惡性循環）
        fetchWeather(g.lat, g.lon);
      } else if (!painted) {
        window._wxGeoSrc = 'IP查無·台北'; fetchWeather(25.04, 121.51);   // 連 IP 都查不到 → 台北預設
      }
    }).catch(() => { if (!painted) { window._wxGeoSrc = 'IP失敗·台北'; fetchWeather(25.04, 121.51); } });
  };
  const _hasCache = _wxCoordCache && typeof _wxCoordCache === 'object' && _wxCoordCache.lat != null;
  if (_hasCache) { window._wxGeoSrc = '快取'; fetchWeather(_wxCoordCache.lat, _wxCoordCache.lon); }   // ① 有快取先即時畫（免空白）

  // ② 取真實定位 — 用 watchPosition「收斂精度」，根治「有時候定位到附近的區」：
  //    根因：getCurrentPosition 就算開 enableHighAccuracy，第一筆常是 WiFi/基地台的粗略網路定位
  //          (accuracy 數百~數千公尺)，GPS 晶片還沒鎖定就先回來→被當 GPS 採用甚至寫進快取→落在鄰近的區。
  //    解法：watchPosition 持續收，永遠保留「最準的一筆」；夠準(≤_GOOD_ACC)立刻採用，否則給幾秒讓 GPS 收斂後再用。
  //    (一律直接定位、不查 Permissions API：iOS standalone PWA 對 permissions.query 常誤報→已授權卻被擋去走 IP。)
  const _GOOD_ACC = 150;   // accuracy ≤150m 視為精準GPS，立即採用、不再等
  const _onPos = (p) => {
    window._wxGeoSrc = 'GPS'; window._wxGeoAcc = Math.round(p.coords.accuracy);   // 記來源/精度→天氣卡顯示，方便診斷
    _saveCoords(p.coords.latitude, p.coords.longitude); fetchWeather(p.coords.latitude, p.coords.longitude);
  };
  // settle：拿到第一筆(粗略)定位後，再給 settle ms 讓 GPS 收斂，到時採用期間「最準的一筆」。
  // 完全拿不到定位(perFix 內無回應/被拒) → onFail。
  function _locate(onOk, onFail, settle, perFix) {
    if (!navigator.geolocation) { onFail(); return; }
    let best = null, done = false, watchId = null, timer = null;
    const finish = () => {
      if (done) return; done = true;
      try { if (watchId != null) navigator.geolocation.clearWatch(watchId); } catch (e) {}
      if (timer) clearTimeout(timer);
      best ? onOk(best) : onFail();
    };
    watchId = navigator.geolocation.watchPosition(
      p => {
        if (!best || p.coords.accuracy < best.coords.accuracy) best = p;   // 永遠保留最準的一筆
        if (p.coords.accuracy <= _GOOD_ACC) { finish(); return; }          // 已夠準→不再等
        if (!timer) timer = setTimeout(finish, settle);                    // 第一筆粗略定位→給 settle 讓 GPS 收斂
      },
      () => finish(),                                                      // 出錯/逾時→用期間最佳(沒有則 onFail)
      { enableHighAccuracy: true, timeout: perFix, maximumAge: 0 }         // maxAge:0→不吃可能是IP的舊快取
    );
  }
  if (!navigator.geolocation) _ipFallback(_hasCache);
  else                        _locate(_onPos, () => _ipFallback(_hasCache), 8000, 20000);   // 冷啟動給 20s 拿首筆，再 8s 收斂

  // 每 5 分鐘自動刷新：重新定位（移動換區→首頁/主圖的所在地與天氣都更新）+ 重抓天氣。
  // 定位失敗 → 沿用上次座標只更新天氣（不退 IP、不把已準的所在地弄丟）。切到背景分頁時瀏覽器會自動暫停此計時器。
  // 刷新一樣走 _locate(maxAge:0 收斂精度)→不再吃可能粗略的舊定位快取。
  function _wxRefresh() {
    if (!navigator.geolocation) { if (_wxLat != null) fetchWeather(_wxLat, _wxLon); return; }
    _locate(_onPos, () => { if (_wxLat != null) fetchWeather(_wxLat, _wxLon); }, 6000, 15000);
  }
  if (!_wxTimer) _wxTimer = setInterval(_wxRefresh, 5*60*1000);   // 預覽模式(?wxlat/?wxloc)已在上方 return，不會自動刷新

  // 手機「設定」分頁開啟時呼叫（main.js setTab）→ 天氣卡即時更新，不必等下一輪 5 分鐘刷新。
  //  · 先用現有資料即時重繪 #mSetWeather（秒顯、無空白）
  //  · 再背景重新定位+抓天氣；10s 節流→快速來回切分頁不會狂打定位/天氣 API
  let _wxManualTs = 0;
  window._wxRefreshNow = function () {
    _renderWeatherCard();                          // 先用現有資料即時重繪（有溫度才會顯示，見 _renderWeatherCard）
    const now = Date.now();
    if (now - _wxManualTs < 10000) return;         // 10s 內剛刷過→不重打定位/API，只重繪
    _wxManualTs = now;
    _wxRefresh();                                  // 重新定位 + 重抓天氣 → 完成後 _renderWeatherCard 會再更新一次
  };
})();
