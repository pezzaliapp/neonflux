/* Quantum Mirror — WebGL1 liquid mirror with touch-driven waves
 * MIT 2025 — 100% client-side, no deps
 */
(()=>{
  'use strict';

  // DOM
  const cvsGL = document.getElementById('gl');
  const cvsFX = document.getElementById('fx');
  const btnPlay = document.getElementById('btnPlay');
  const btnQuality = document.getElementById('btnQuality');
  const btnExport = document.getElementById('btnExport');
  const btnFull = document.getElementById('btnFull');
  const elFps = document.getElementById('fps');

  // State
  let running = true;
  let DPR = Math.min(2, window.devicePixelRatio||1);
  let QUALITY = 1; // 0=Low (fast), 1=Med, 2=High
  let start = performance.now(), frames=0, lastFpsTime=0;

  // Wave sources (decadono nel tempo)
  const MAX_SRC = 8;
  const sources = Array.from({length:MAX_SRC}, ()=>({x:0.5,y:0.5,amp:0,age:1}));

  // Flash FX
  const ctxFX = cvsFX.getContext('2d');

  // WebGL
  /** @type {WebGLRenderingContext} */ let gl;
  let program, loc={};

  function resize(){
    const w = cvsGL.clientWidth|0, h = cvsGL.clientHeight|0;
    const scale = QUALITY===0? 1: QUALITY===1? 1.25: 1.5;
    const dpr = Math.min(DPR, scale);
    cvsGL.width  = Math.max(1,(w*dpr)|0);
    cvsGL.height = Math.max(1,(h*dpr)|0);
    cvsFX.width  = cvsGL.width;
    cvsFX.height = cvsGL.height;
    if(gl){
      gl.viewport(0,0,cvsGL.width,cvsGL.height);
      gl.uniform2f(loc.u_res, cvsGL.width, cvsGL.height);
    }
  }

  // Shaders
  const VERT = `
  attribute vec2 a_pos;
  void main(){ gl_Position = vec4(a_pos,0.0,1.0); }`;

  // FRAG: height field procedurale + normal da gradiente → riflessione ambiente procedurale
  const FRAG = `
  precision highp float;

  uniform vec2  u_res;
  uniform float u_time;
  uniform vec2  u_srcPos[8];   // pos 0..1
  uniform float u_srcAmp[8];   // ampiezza residua
  uniform float u_srcAge[8];   // 0..1 (0 = appena creato)
  uniform float u_rough;       // rugosità base

  // hash / noise
  float hash(vec2 p){ return fract(sin(dot(p,vec2(41.3,289.1)))*43758.5453); }
  float noise(vec2 p){
    vec2 i=floor(p), f=fract(p);
    vec2 u=f*f*(3.0-2.0*f);
    float a=hash(i);
    float b=hash(i+vec2(1.,0.));
    float c=hash(i+vec2(0.,1.));
    float d=hash(i+vec2(1.,1.));
    return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);
  }

  // env map procedurale (cielo + gradiente)
  vec3 envColor(vec3 dir){
    float h = clamp(dir.y*0.5+0.5, 0.0, 1.0);
    vec3 top = vec3(0.08,0.12,0.25);
    vec3 mid = vec3(0.12,0.20,0.45);
    vec3 bot = vec3(0.02,0.03,0.08);
    vec3 sky = mix(bot, mix(mid, top, smoothstep(0.25,0.9,h)), h);
    // leggere “strisce” neon
    float bands = 0.04*sin(dir.x*8.0 + u_time*0.7) + 0.03*sin(dir.z*11.0 - u_time*0.9);
    return sky + vec3(bands*0.6, bands*0.3, bands*0.9);
  }

  // calcola altezza superficie (somma di onde radiali + rugosità)
  float heightField(vec2 uv){
    float h = 0.0;
    for(int i=0;i<8;i++){
      vec2 p = u_srcPos[i];
      float amp = u_srcAmp[i];
      float age = u_srcAge[i]; // 0..1
      if(amp<=0.0) continue;
      float d = distance(uv, p);
      // onda radiale: sinusoide attenuata, fronto d'onda che si allarga nel tempo
      float w = sin(24.0*d - (1.0-age)*18.0) * exp(-8.0*d) * amp * (0.25 + 0.75*(1.0-age));
      h += w;
    }
    // micro-rugosità (noise fine)
    h += (noise(uv*vec2(600.0,420.0)) - 0.5) * u_rough;
    return h;
  }

  void main(){
    vec2 frag = gl_FragCoord.xy;
    vec2 uv = frag / u_res;           // 0..1
    vec2 p  = (uv - 0.5);
    p.x *= u_res.x/u_res.y;

    // Height field & normals (finite difference)
    float e = 1.0 / u_res.y; // passo
    float h  = heightField(uv);
    float hx = heightField(uv + vec2(e,0.0)) - h;
    float hy = heightField(uv + vec2(0.0,e)) - h;

    // normale dalla mappa di altezza
    vec3 n = normalize(vec3(-hx, -hy, 1.0));

    // vettore vista & riflessione
    vec3 v = normalize(vec3(p, 1.5));
    vec3 r = reflect(-v, n);

    // colore ambiente + fresnel + spec
    vec3 env = envColor(r);
    float fres = pow(1.0 - max(dot(n, v), 0.0), 3.0);
    float spec = pow(max(dot(reflect(v, n), vec3(0.0,0.0,1.0)), 0.0), 32.0);

    vec3 base = env * (0.55 + 0.45*fres);
    vec3 col  = base + spec*vec3(1.0,0.95,0.9);

    // vignette dolce
    float rad = length(p);
    float vig = smoothstep(1.2, 0.35, rad);
    col *= vig;

    gl_FragColor = vec4(col, 1.0);
  }`;

  function compile(type, src){
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src); gl.compileShader(sh);
    if(!gl.getShaderParameter(sh, gl.COMPILE_STATUS)){
      throw new Error(gl.getShaderInfoLog(sh)||'shader error');
    }
    return sh;
  }

  function initGL(){
    gl = cvsGL.getContext('webgl', {antialias:false, preserveDrawingBuffer:true});
    if(!gl) throw new Error('WebGL non disponibile');

    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    program = gl.createProgram();
    gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program);
    if(!gl.getProgramParameter(program, gl.LINK_STATUS)){
      throw new Error(gl.getProgramInfoLog(program)||'link error');
    }
    gl.useProgram(program);

    // quad fullscreen
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1,-1, 1,-1, -1, 1,
       1,-1, 1, 1, -1, 1
    ]), gl.STATIC_DRAW);
    const locPos = gl.getAttribLocation(program,'a_pos');
    gl.enableVertexAttribArray(locPos);
    gl.vertexAttribPointer(locPos,2,gl.FLOAT,false,0,0);

    // uniforms
    loc.u_res   = gl.getUniformLocation(program,'u_res');
    loc.u_time  = gl.getUniformLocation(program,'u_time');
    loc.u_srcPos= gl.getUniformLocation(program,'u_srcPos[0]');
    loc.u_srcAmp= gl.getUniformLocation(program,'u_srcAmp[0]');
    loc.u_srcAge= gl.getUniformLocation(program,'u_srcAge[0]');
    loc.u_rough = gl.getUniformLocation(program,'u_rough');

    resize();
  }

  // Touch handling
  function pushSource(nx, ny){
    // trova slot meno energico
    let k=0, minAmp=Infinity;
    for(let i=0;i<MAX_SRC;i++){
      if(sources[i].amp < minAmp){ minAmp = sources[i].amp; k=i; }
    }
    sources[k].x = nx; sources[k].y = ny;
    sources[k].amp = 1.0; // energia iniziale
    sources[k].age = 0.0;

    // piccolo flash 2D
    flash(nx, ny);
  }

  function onPoint(e){
    const r = cvsGL.getBoundingClientRect();
    const x = ( (e.touches? e.touches[0].clientX : e.clientX) - r.left ) / r.width;
    const y = ( (e.touches? e.touches[0].clientY : e.clientY) - r.top  ) / r.height;
    const nx = Math.max(0, Math.min(1, x));
    const ny = Math.max(0, Math.min(1, y));
    pushSource(nx, ny);
  }

  cvsGL.addEventListener('pointerdown', onPoint);
  cvsGL.addEventListener('touchstart', onPoint, {passive:true});

  // FX flash
  function flash(nx, ny){
    const W=cvsFX.width, H=cvsFX.height;
    const x=nx*W, y=ny*H;
    const g=ctxFX.createRadialGradient(x,y,0,x,y,Math.min(W,H)*0.15);
    g.addColorStop(0,'rgba(200,220,255,0.35)');
    g.addColorStop(1,'rgba(0,0,0,0)');
    ctxFX.save();
    ctxFX.globalCompositeOperation='lighter';
    ctxFX.fillStyle=g; ctxFX.fillRect(0,0,W,H);
    ctxFX.restore();
  }

  // Controls
  btnPlay.addEventListener('click', ()=>{
    running = !running;
    btnPlay.textContent = running? 'Pause':'Play';
  });
  btnQuality.addEventListener('click', ()=>{
    QUALITY = (QUALITY+1)%3;
    btnQuality.textContent = 'Qualità: ' + (QUALITY===0?'Low':QUALITY===1?'Med':'High');
    resize();
  });
  btnExport.addEventListener('click', ()=>{
    // Esporta PNG dal canvas GL (preserveDrawingBuffer:true)
    const url = cvsGL.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url; a.download = 'quantum_mirror.png'; a.click();
  });
  btnFull.addEventListener('click', ()=>{
    if(document.fullscreenElement) document.exitFullscreen(); else cvsGL.requestFullscreen?.();
  });

  // RAF
  function raf(t){
    // decay fisico sorgenti + pulizia FX
    const now = performance.now();
    const dt = Math.min(0.033, (now - (raf._last || now))/1000);
    raf._last = now;

    ctxFX.globalCompositeOperation='source-over';
    ctxFX.fillStyle='rgba(0,0,0,0.06)'; // dissolve del flash
    ctxFX.fillRect(0,0,cvsFX.width,cvsFX.height);

    for(const s of sources){
      if(s.amp>0){
        s.age = Math.min(1, s.age + dt*0.7);
        s.amp *= Math.exp(-dt*1.2); // decadimento esponenziale
      }
    }

    if(running){
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(loc.u_time, (now - start)/1000);
      // pos/amp/age in array flat
      const pos = new Float32Array(MAX_SRC*2);
      const amp = new Float32Array(MAX_SRC);
      const age = new Float32Array(MAX_SRC);
      for(let i=0;i<MAX_SRC;i++){
        pos[i*2] = sources[i].x;
        pos[i*2+1] = sources[i].y;
        amp[i] = sources[i].amp;
        age[i] = sources[i].age;
      }
      gl.uniform2fv(loc.u_srcPos, pos);
      gl.uniform1fv(loc.u_srcAmp, amp);
      gl.uniform1fv(loc.u_srcAge, age);
      gl.uniform1f(loc.u_rough, QUALITY===2? 0.08 : QUALITY===1? 0.05 : 0.03);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    // fps
    frames++;
    if(now - lastFpsTime > 500){
      const fps = (frames*1000/(now-lastFpsTime))|0;
      elFps.textContent = 'fps: ' + fps;
      frames=0; lastFpsTime = now;
    }

    requestAnimationFrame(raf);
  }

  // Init
  try{
    initGL();
    resize();
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', resize);

    // primo tocco “gentile” al centro
    pushSource(0.5,0.5);

    requestAnimationFrame(raf);
  }catch(err){
    console.error('[Quantum Mirror] Fallback 2D:', err);
    // fallback 2D molto semplice
    const ctx = cvsGL.getContext('2d');
    function draw2D(t){
      const W=cvsGL.width,H=cvsGL.height;
      ctx.fillStyle='#0b1022'; ctx.fillRect(0,0,W,H);
      const g=ctx.createRadialGradient(W/2,H/2,20,W/2,H/2,Math.min(W,H)/2);
      g.addColorStop(0,'#88aaff'); g.addColorStop(1,'#000'); ctx.fillStyle=g; ctx.fillRect(0,0,W,H);
      requestAnimationFrame(draw2D);
    }
    requestAnimationFrame(draw2D);
  }
})();
