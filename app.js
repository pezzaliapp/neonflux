/* AURA LAB — 3 Visual Modes (WebGL1, client-side only) — MIT 2025 */
(()=>{
  'use strict';

  const canvas = document.getElementById('view');
  const btnPlay = document.getElementById('btnPlay');
  const btnMic  = document.getElementById('btnMic');
  const btnGyro = document.getElementById('btnGyro');
  const btnFull = document.getElementById('btnFull');
  const selMode = document.getElementById('modeSel');
  const elFps   = document.getElementById('fps');
  const elHudM  = document.getElementById('hudMode');

  let gl, program, loc = {};
  let start=performance.now(), running=true;
  let DPR = Math.min(1.5, window.devicePixelRatio||1); // più leggero su mobile
  let lastFpsTime=0, frames=0;

  // state
  let mode = 0; // 0=Liquid,1=Tunnel,2=Aurora
  let touch = {x:0.5, y:0.5};
  let audioLevel = 0.0, micOn=false, audioCtx=null, analyser=null, dataArray=null;
  let gyroOn=false, gyro={x:0,y:0};

  // 2D context per particelle leggere additive
  const ctx2d = canvas.getContext('2d');

  function resize(){
    const w = canvas.clientWidth|0, h = canvas.clientHeight|0;
    canvas.width = Math.max(1,(w*DPR)|0);
    canvas.height= Math.max(1,(h*DPR)|0);
    gl.viewport(0,0,canvas.width,canvas.height);
    gl.uniform2f(loc.u_res, canvas.width, canvas.height);
  }

  function shader(type, src){
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if(!gl.getShaderParameter(s, gl.COMPILE_STATUS)){
      throw new Error(gl.getShaderInfoLog(s)||'shader compile error');
    }
    return s;
  }

  // Unico fragment con 3 scene
  const frag = `
  precision highp float;
  uniform vec2  u_res;    // pixel
  uniform float u_time;   // secondi
  uniform vec2  u_touch;  // 0..1
  uniform float u_audio;  // 0..1
  uniform int   u_mode;   // 0,1,2
  uniform vec2  u_gyro;   // -1..1

  #define PI 3.141592653589793
  float hash(vec2 p){ return fract(sin(dot(p,vec2(41.3,289.1)))*43758.5453); }

  // --- noise (simplex-like) ---
  vec2 n2(vec2 p){
    vec2 i=floor(p), f=fract(p);
    vec2 u=f*f*(3.0-2.0*f);
    float a=hash(i);
    float b=hash(i+vec2(1.,0.));
    float c=hash(i+vec2(0.,1.));
    float d=hash(i+vec2(1.,1.));
    return vec2(mix(mix(a,b,u.x),mix(c,d,u.x),u.y), u.x);
  }
  float noise(vec2 p){ return n2(p).x; }

  // --- camera helpers ---
  mat2 rot(float a){ float s=sin(a), c=cos(a); return mat2(c,-s,s,c); }

  // --- Scene 0: Liquid Metal (metaballs + fake reflection) ---
  float metaballs(vec3 p){
    float d=0.0;
    for(int i=0;i<6;i++){
      float fi = float(i);
      vec3 c = vec3(sin(fi*1.7+u_time*0.8), cos(fi*1.3-u_time*0.6), sin(fi*0.9+u_time*0.7))*0.6;
      d += 0.35 / (0.2 + length(p-c));
    }
    return d-1.2;
  }
  vec3 sceneLiquid(vec2 uv){
    // camera orbit + gyro/touch
    float tm = u_time*0.6;
    vec3 ro = vec3(0.0,0.0,2.5);
    vec3 la = vec3(0.0,0.0,0.0);
    vec3 ww = normalize(la-ro);
    vec3 uu = normalize(cross(vec3(0,1,0), ww));
    vec3 vv = cross(ww, uu);
    vec3 rd = normalize(uv.x*uu + uv.y*vv + 1.6*ww);

    // raymarch
    float t=0.0; vec3 p;
    float glow=0.0;
    for(int i=0;i<64;i++){
      p = ro + rd*t;
      float d = metaballs(p);
      glow += exp(-6.0*abs(d))*0.015;
      if(d<0.001 || t>6.0) break;
      t += d*0.6;
    }

    // normal
    vec3 n = normalize(vec3(
      metaballs(p+vec3(0.001,0,0))-metaballs(p-vec3(0.001,0,0)),
      metaballs(p+vec3(0,0.001,0))-metaballs(p-vec3(0,0.001,0)),
      metaballs(p+vec3(0,0,0.001))-metaballs(p-vec3(0,0,0.001))
    ));

    // fake env reflection
    vec3 ref = reflect(rd,n);
    float m = 0.5 + 0.5*sin(6.0*ref.y + u_time*2.0);
    vec3 env = mix(vec3(0.05,0.08,0.15), vec3(0.2,0.3,0.6), m);
    vec3 base = env * (0.3 + 0.7*pow(max(dot(n,normalize(vec3(0.2,0.7,0.3))),0.0),2.0));

    // spec + chroma
    float spec = pow(max(dot(ref, normalize(vec3(0.3,0.6,0.9))), 0.0), 32.0);
    vec3 col = base + spec*vec3(1.0,0.9,0.8);

    // audio pulse + glow
    col += glow*vec3(0.6+0.6*u_audio, 0.5, 0.9);
    // chromatic aberration
    float ca = 0.002 + 0.008*u_audio;
    vec2 uvR = uv*(1.0+ca), uvB = uv*(1.0-ca);
    col.r += 0.08*noise(uvR*2.0+u_time);
    col.b += 0.08*noise(uvB*2.0-u_time);
    return col;
  }

  // --- Scene 1: HyperTunnel ---
  vec3 sceneTunnel(vec2 uv){
    // polar tunnel
    float a = atan(uv.y, uv.x);
    float r = length(uv);
    float stripes = 0.5 + 0.5*cos(10.0*a + u_time*3.0) * sin(8.0/r + u_time*2.0);
    float depth = 1.0/(0.2 + r);
    float pulse = 0.5 + 0.5*sin(u_time*4.0 + u_audio*8.0);
    vec3 col = vec3(0.1,0.2,0.6)*depth + vec3(0.9,0.3,0.8)*stripes*pulse;

    // spiral glow
    float s = 0.0;
    for(int i=0;i<3;i++){
      float fi=float(i);
      float g = abs(sin(6.0*(a + fi*2.0) + u_time*1.8))/max(0.3, r*6.0);
      s += g*0.25;
    }
    col += s*vec3(0.8,0.6,1.0);

    // vignette
    float vig = smoothstep(1.3, 0.25, r);
    col *= vig;
    return col;
  }

  // --- Scene 2: Aurora Sky ---
  vec3 sceneAurora(vec2 uv){
    uv.x += (u_touch.x-0.5)*0.4 + u_gyro.x*0.15;
    uv.y += (u_touch.y-0.5)*0.2 + u_gyro.y*0.15;
    float t = u_time*0.12;

    float layer=0.0;
    vec3 col = vec3(0.02,0.03,0.08); // night
    for(int i=0;i<4;i++){
      float fi=float(i);
      vec2 q = uv* (1.4 + fi*0.35);
      float band = noise(q*3.0 + vec2(0,t*2.0)) * 0.6;
      float wave = smoothstep(0.35, 0.0, abs(uv.y - (0.1+0.15*fi) - 0.3*noise(vec2(uv.x*2.0, t+fi))));
      vec3 c = mix(vec3(0.1,0.5,0.9), vec3(0.8,0.2,0.9), band);
      col += c * wave * (0.6/(1.0+fi*0.7));
      layer += wave;
    }
    // stars
    float star = step(0.995, noise(uv*vec2(900.0,400.0)+t*10.0));
    col += star*vec3(1.0);

    // glow & tone
    col += vec3(0.08,0.06,0.12)*(layer);
    col = pow(col, vec3(0.9));
    return col;
  }

  void main(){
    vec2 frag = gl_FragCoord.xy;
    vec2 uv = (frag / u_res) * 2.0 - 1.0;
    uv.x *= u_res.x/u_res.y;

    // lieve pan in base ad audio
    uv += (u_audio*0.03)*vec2(sin(u_time*0.7), cos(u_time*0.6));

    vec3 col;
    if(u_mode==0) col = sceneLiquid(uv);
    else if(u_mode==1) col = sceneTunnel(uv*rot(0.2*sin(u_time*0.3))+0.03*u_gyro);
    else col = sceneAurora(uv);

    // grain sottile
    col += (hash(frag)*0.015);
    gl_FragColor = vec4(col,1.0);
  }`;

  const vert = `
  attribute vec2 a_pos;
  void main(){ gl_Position = vec4(a_pos,0.0,1.0); }`;

  function initGL(){
    gl = canvas.getContext('webgl',{antialias:false,preserveDrawingBuffer:false});
    if(!gl) throw new Error('WebGL non disponibile');

    const vs = shader(gl.VERTEX_SHADER, vert);
    const fs = shader(gl.FRAGMENT_SHADER, frag);
    program = gl.createProgram();
    gl.attachShader(program,vs); gl.attachShader(program,fs); gl.linkProgram(program);
    if(!gl.getProgramParameter(program, gl.LINK_STATUS)){ throw new Error(gl.getProgramInfoLog(program)||'link error'); }
    gl.useProgram(program);

    // quad
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1,-1, 1,-1, -1,1,
       1,-1, 1,1, -1,1
    ]), gl.STATIC_DRAW);
    const locPos = gl.getAttribLocation(program,'a_pos');
    gl.enableVertexAttribArray(locPos);
    gl.vertexAttribPointer(locPos,2,gl.FLOAT,false,0,0);

    // uniforms
    loc.u_res   = gl.getUniformLocation(program,'u_res');
    loc.u_time  = gl.getUniformLocation(program,'u_time');
    loc.u_touch = gl.getUniformLocation(program,'u_touch');
    loc.u_audio = gl.getUniformLocation(program,'u_audio');
    loc.u_mode  = gl.getUniformLocation(program,'u_mode');
    loc.u_gyro  = gl.getUniformLocation(program,'u_gyro');

    resize();
  }

  // particles (leggere, additive su 2D)
  const MAXP=450, P=[];
  function spawn(x,y){
    for(let i=0;i<10;i++){
      if(P.length>MAXP) P.shift();
      const a = Math.random()*Math.PI*2, s=0.5+Math.random()*2.2;
      P.push({x,y, vx:Math.cos(a)*s, vy:Math.sin(a)*s, life:1, dec:0.02+Math.random()*0.02});
    }
  }
  function stepParticles(dt){
    for(let i=P.length-1;i>=0;i--){
      const p=P[i]; p.x+=p.vx*dt*60; p.y+=p.vy*dt*60; p.vy+=0.02*dt*60; p.life-=p.dec*dt*60;
      if(p.life<=0) P.splice(i,1);
    }
  }
  function drawParticles(){
    ctx2d.save(); ctx2d.globalCompositeOperation='lighter';
    const W=canvas.width,H=canvas.height;
    for(const p of P){
      const r = (mode===1? 1:2) + (1-p.life)*6;
      const g = ctx2d.createRadialGradient(p.x*W,p.y*H,0,p.x*W,p.y*H,r);
      g.addColorStop(0,`rgba(200,220,255,${0.55*p.life})`);
      g.addColorStop(1,`rgba(0,0,0,0)`);
      ctx2d.fillStyle=g; ctx2d.beginPath(); ctx2d.arc(p.x*W,p.y*H,r,0,Math.PI*2); ctx2d.fill();
    }
    ctx2d.restore();
  }

  // input
  function setTouch(e){
    const r = canvas.getBoundingClientRect();
    const cx = ( (e.touches? e.touches[0].clientX : e.clientX) - r.left ) / r.width;
    const cy = ( (e.touches? e.touches[0].clientY : e.clientY) - r.top ) / r.height;
    touch.x = Math.max(0,Math.min(1,cx));
    touch.y = Math.max(0,Math.min(1,cy));
    spawn(touch.x,touch.y);
  }
  canvas.addEventListener('pointerdown', setTouch);
  canvas.addEventListener('pointermove', (e)=>{ if(e.buttons) setTouch(e); });
  canvas.addEventListener('touchstart', setTouch, {passive:true});
  canvas.addEventListener('touchmove',  setTouch, {passive:true});

  // mic
  btnMic.addEventListener('click', async ()=>{
    try{
      if(micOn){ micOn=false; audioLevel=0; btnMic.textContent='Mic OFF'; if(audioCtx) audioCtx.close(); return; }
      if(!navigator.mediaDevices?.getUserMedia) throw new Error('getUserMedia non disponibile');
      const stream = await navigator.mediaDevices.getUserMedia({audio:true, video:false});
      audioCtx = new (window.AudioContext||window.webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser(); analyser.fftSize=256;
      dataArray = new Uint8Array(analyser.frequencyBinCount); source.connect(analyser);
      micOn=true; btnMic.textContent='Mic ON';
      (function tick(){
        if(!micOn) return;
        analyser.getByteFrequencyData(dataArray);
        let sum=0,n=0; for(let i=2;i<24;i++){ sum+=dataArray[i]; n++; }
        audioLevel = Math.min(1, (sum/(n*255))*1.8);
        requestAnimationFrame(tick);
      })();
    }catch(e){ console.warn(e); micOn=false; audioLevel=0; btnMic.textContent='Mic OFF'; }
  });

  // gyro
  btnGyro.addEventListener('click', async ()=>{
    try{
      if(gyroOn){ gyroOn=false; btnGyro.textContent='Gyro OFF'; return; }
      if(typeof DeviceMotionEvent!=='undefined' && typeof DeviceMotionEvent.requestPermission==='function'){
        const st = await DeviceMotionEvent.requestPermission(); if(st!=='granted') throw new Error('Permesso negato');
      }
      window.addEventListener('deviceorientation', (e)=>{
        // normalizza in -1..1
        gyro.x = Math.max(-1,Math.min(1, (e.gamma||0)/45));
        gyro.y = Math.max(-1,Math.min(1, (e.beta ||0)/45));
      });
      gyroOn=true; btnGyro.textContent='Gyro ON';
    }catch(err){ console.warn(err); gyroOn=false; btnGyro.textContent='Gyro OFF'; }
  });

  // controls
  btnPlay.addEventListener('click', ()=>{
    running=!running; btnPlay.textContent = running? 'Pause':'Play';
  });
  btnFull.addEventListener('click', ()=>{
    if(document.fullscreenElement) document.exitFullscreen(); else canvas.requestFullscreen?.();
  });
  selMode.addEventListener('change', ()=>{
    mode = selMode.selectedIndex; elHudM.textContent = 'Mode: ' + selMode.value;
  });

  // RAF
  function raf(){
    const now=performance.now(), t=(now-start)/1000;
    // clear 2D layer per frame
    ctx2d.clearRect(0,0,canvas.width,canvas.height);

    if(running){
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(loc.u_time, t);
      gl.uniform2f(loc.u_touch, touch.x, touch.y);
      gl.uniform1f(loc.u_audio, audioLevel);
      gl.uniform1i(loc.u_mode, mode);
      gl.uniform2f(loc.u_gyro, gyro.x, gyro.y);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // particles
      stepParticles(Math.min(0.033, (now-(raf._last||now))/1000));
      raf._last = now;
      drawParticles();
    }

    frames++;
    if(now-lastFpsTime>500){
      const fps = (frames*1000/(now-lastFpsTime))|0;
      elFps.textContent='fps: '+fps; frames=0; lastFpsTime=now;
    }
    requestAnimationFrame(raf);
  }

  // init
  try{
    // Proviamo prima il contesto WebGL, poi uniform e viewport
    gl = canvas.getContext('webgl',{antialias:false,preserveDrawingBuffer:false});
    if(!gl) throw new Error('WebGL non disponibile');
    // compila
    const vs=shader(gl.VERTEX_SHADER, vert), fs=shader(gl.FRAGMENT_SHADER, frag);
    program=gl.createProgram(); gl.attachShader(program,vs); gl.attachShader(program,fs); gl.linkProgram(program);
    if(!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program)||'link error');
    gl.useProgram(program);
    // quad
    const buf=gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1, 1,-1,1,1,-1,1]), gl.STATIC_DRAW);
    const locPos=gl.getAttribLocation(program,'a_pos'); gl.enableVertexAttribArray(locPos); gl.vertexAttribPointer(locPos,2,gl.FLOAT,false,0,0);
    // uniforms
    loc.u_res   = gl.getUniformLocation(program,'u_res');
    loc.u_time  = gl.getUniformLocation(program,'u_time');
    loc.u_touch = gl.getUniformLocation(program,'u_touch');
    loc.u_audio = gl.getUniformLocation(program,'u_audio');
    loc.u_mode  = gl.getUniformLocation(program,'u_mode');
    loc.u_gyro  = gl.getUniformLocation(program,'u_gyro');
    // viewport
    resize();
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', resize);
    // avvia
    requestAnimationFrame(raf);
  }catch(err){
    console.error('[AURA LAB] Fallback 2D:', err);
    // Fallback 2D animato
    const ctx = canvas.getContext('2d');
    function draw2D(t){
      if(!running){ requestAnimationFrame(draw2D); return; }
      const W=canvas.width,H=canvas.height;
      ctx.fillStyle='#0b1022'; ctx.fillRect(0,0,W,H);
      const gx = touch.x*W, gy=touch.y*H, r=100+60*Math.sin(t*0.002);
      const g = ctx.createRadialGradient(gx,gy,10,gx,gy,r);
      g.addColorStop(0,'#88aaff'); g.addColorStop(1,'#000'); ctx.fillStyle=g; ctx.fillRect(0,0,W,H);
      requestAnimationFrame(draw2D);
    }
    requestAnimationFrame(draw2D);
  }

})();
