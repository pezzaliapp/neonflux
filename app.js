/* NeonFlux — WebGL + Particles (client-side only) — MIT */
(()=>{
  'use strict';

  const canvas = document.getElementById('view');
  const btnPlay = document.getElementById('btnPlay');
  const btnMic  = document.getElementById('btnMic');
  const btnFull = document.getElementById('btnFull');
  const elFps   = document.getElementById('fps');
  const elMode  = document.getElementById('mode');

  let gl, program, timeLoc, resLoc, touchLoc, audioLoc;
  let start=performance.now(), running=true;
  let DPR = Math.min(2, window.devicePixelRatio || 1);
  let lastFpsTime=0, frames=0;

  // touch state
  let touchX=0.5, touchY=0.5;

  // audio reactive (optional)
  let micOn=false, audioLevel=0; // 0..1
  let audioCtx, analyser, dataArray;

  // particles (CPU canvas overlay using same canvas via post-render additive points)
  const MAX_P = 600;
  const particles = [];

  function resize(){
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const W = Math.max(1, (w|0)), H = Math.max(1, (h|0));
    canvas.width = (W*DPR)|0; canvas.height = (H*DPR)|0;
    gl.viewport(0,0,canvas.width,canvas.height);
    gl.uniform2f(resLoc, canvas.width, canvas.height);
  }

  function makeShader(type, src){
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if(!gl.getShaderParameter(sh, gl.COMPILE_STATUS)){
      throw new Error(gl.getShaderInfoLog(sh)||'shader error');
    }
    return sh;
  }

  // Minimal neon fragment shader: distance fields + palette, touch as attractor, audio as pulse
  const frag = `
  precision highp float;
  uniform vec2 u_res;
  uniform float u_time;
  uniform vec2 u_touch;
  uniform float u_audio;
  #define PI 3.141592653589793

  // palette
  vec3 palette(float t){
    return 0.5 + 0.5*cos(6.28318*(vec3(0.0,0.15,0.33)+t));
  }

  float ring(vec2 p, float r, float w){
    return abs(length(p)-r)-w;
  }

  void main(){
    vec2 uv = (gl_FragCoord.xy / u_res.xy);
    vec2 p = (uv - 0.5) * vec2(u_res.x/u_res.y, 1.0);

    // touch attractor
    vec2 t = (u_touch - 0.5) * vec2(u_res.x/u_res.y,1.0);

    // swirl coords
    float a = atan(p.y - t.y, p.x - t.x);
    float d = length(p - t);

    // audio pulsazione
    float beat = 0.5 + 0.5*sin(u_time*2.0 + u_audio*6.0);

    // neon rings
    float r1 = ring(p - t, 0.15 + 0.10*sin(u_time*0.8) + beat*0.06, 0.015 + 0.01*u_audio);
    float r2 = ring(p + t*0.5, 0.38 + 0.08*cos(u_time*0.6), 0.020);
    float r3 = ring(p + vec2(sin(u_time),cos(u_time))*0.2, 0.62 + 0.05*sin(a*3.0+u_time), 0.012);

    float m = 0.0;
    m += 0.009 / (abs(r1)+0.003);
    m += 0.008 / (abs(r2)+0.003);
    m += 0.006 / (abs(r3)+0.003);

    // glow
    float glow = 0.08 / (d+0.02);

    vec3 col = palette(0.3 + 0.2*sin(u_time*0.3) + a*0.05);
    col *= (m + glow);

    // vignette
    float vig = smoothstep(1.2, 0.35, length(uv-0.5));
    col *= vig;

    gl_FragColor = vec4(col, 1.0);
  }`;

  const vert = `
  attribute vec2 a_pos;
  void main(){ gl_Position = vec4(a_pos, 0.0, 1.0); }`;

  function initGL(){
    gl = canvas.getContext('webgl',{antialias:false,preserveDrawingBuffer:false});
    if(!gl) throw new Error('WebGL non disponibile');

    const vs = makeShader(gl.VERTEX_SHADER, vert);
    const fs = makeShader(gl.FRAGMENT_SHADER, frag);
    program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if(!gl.getProgramParameter(program, gl.LINK_STATUS)){
      throw new Error(gl.getProgramInfoLog(program)||'link error');
    }
    gl.useProgram(program);

    // quad
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1,-1,  1,-1, -1, 1,
       1,-1,  1, 1, -1, 1
    ]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program,'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc,2,gl.FLOAT,false,0,0);

    // uniforms
    timeLoc  = gl.getUniformLocation(program,'u_time');
    resLoc   = gl.getUniformLocation(program,'u_res');
    touchLoc = gl.getUniformLocation(program,'u_touch');
    audioLoc = gl.getUniformLocation(program,'u_audio');

    resize();
  }

  // Particles: simple additive points drawn after WebGL pass using 2D context overlay technique (fallback inside same canvas)
  const ctx2d = canvas.getContext('2d');

  function spawnParticles(x,y){
    for(let i=0;i<12;i++){
      if(particles.length>MAX_P) particles.shift();
      const a = Math.random()*Math.PI*2;
      const s = 0.5 + Math.random()*2.5;
      particles.push({
        x, y, vx: Math.cos(a)*s, vy: Math.sin(a)*s,
        life: 1.0, decay: 0.015+Math.random()*0.02
      });
    }
  }

  function stepParticles(dt){
    for(let i=particles.length-1;i>=0;i--){
      const p = particles[i];
      p.x += p.vx*dt*60; p.y += p.vy*dt*60;
      p.vy += 0.02*dt*60; // gravity
      p.life -= p.decay*dt*60;
      if(p.life<=0) particles.splice(i,1);
    }
  }

  function drawParticles(){
    // draw over WebGL using 2D (same canvas) with additive small glows
    ctx2d.save();
    ctx2d.globalCompositeOperation='lighter';
    const W = canvas.width, H = canvas.height;
    for(const p of particles){
      const r = 2 + (1-p.life)*6;
      const g = ctx2d.createRadialGradient(p.x*W, p.y*H, 0, p.x*W, p.y*H, r*DPR);
      g.addColorStop(0, `rgba(180,200,255,${0.55*p.life})`);
      g.addColorStop(1, `rgba(0,0,0,0)`);
      ctx2d.fillStyle=g;
      ctx2d.beginPath();
      ctx2d.arc(p.x*W, p.y*H, r*DPR, 0, Math.PI*2);
      ctx2d.fill();
    }
    ctx2d.restore();
  }

  function raf(t){
    if(!running){ requestAnimationFrame(raf); return; }

    const now = performance.now();
    const uTime = (now - start)/1000;

    // render shader
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(timeLoc, uTime);
    gl.uniform2f(touchLoc, touchX, touchY);
    gl.uniform1f(audioLoc, audioLevel);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // particles
    const dt = Math.min(0.033, (now - (raf._last||now))/1000);
    raf._last = now;
    stepParticles(dt);
    drawParticles();

    // fps
    frames++;
    if(now-lastFpsTime>500){
      const fps = (frames*1000/(now-lastFpsTime))|0;
      elFps.textContent = 'fps: ' + fps;
      frames=0; lastFpsTime=now;
    }

    requestAnimationFrame(raf);
  }

  // input
  function setTouchFromEvent(e){
    const r = canvas.getBoundingClientRect();
    const x = ( (e.touches? e.touches[0].clientX : e.clientX) - r.left ) / r.width;
    const y = ( (e.touches? e.touches[0].clientY : e.clientY) - r.top ) / r.height;
    touchX = Math.max(0, Math.min(1, x));
    touchY = Math.max(0, Math.min(1, y));
    spawnParticles(touchX, touchY);
  }

  canvas.addEventListener('pointerdown', setTouchFromEvent);
  canvas.addEventListener('pointermove', e=>{ if(e.buttons) setTouchFromEvent(e); });
  canvas.addEventListener('touchstart', setTouchFromEvent, {passive:true});
  canvas.addEventListener('touchmove',  setTouchFromEvent, {passive:true});

  // controls
  btnPlay.addEventListener('click', ()=>{
    running = !running;
    btnPlay.textContent = running? 'Pause' : 'Play';
  });

  btnMic.addEventListener('click', async ()=>{
    try{
      if(micOn){
        micOn=false; audioLevel=0; btnMic.textContent='Mic OFF';
        if(audioCtx) audioCtx.close();
        return;
      }
      if(!navigator.mediaDevices?.getUserMedia) throw new Error('getUserMedia non disponibile');
      const stream = await navigator.mediaDevices.getUserMedia({audio:true, video:false});
      audioCtx = new (window.AudioContext||window.webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      dataArray = new Uint8Array(analyser.frequencyBinCount);
      source.connect(analyser);
      micOn=true; btnMic.textContent='Mic ON';
      // polling
      (function pull(){
        if(!micOn) return;
        analyser.getByteFrequencyData(dataArray);
        // focus su basse-medie frequenze
        let sum=0, n=0;
        for(let i=2;i<24;i++){ sum+=dataArray[i]; n++; }
        audioLevel = Math.min(1, (sum/(n*255))*1.8);
        requestAnimationFrame(pull);
      })();
    }catch(err){
      console.warn(err);
      micOn=false; audioLevel=0; btnMic.textContent='Mic OFF';
      // niente alert invasivi: degradazione silenziosa
    }
  });

  btnFull.addEventListener('click', ()=>{
    if(document.fullscreenElement){ document.exitFullscreen(); }
    else{ canvas.requestFullscreen?.(); }
  });

  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);

  // init
  try{
    initGL();
    resize();
    requestAnimationFrame(raf);
    elMode.textContent='Mode: Neon';
  }catch(err){
    console.error(err);
    // fallback 2D
    const ctx = canvas.getContext('2d');
    function draw2D(t){
      if(!running){ requestAnimationFrame(draw2D); return; }
      const W=canvas.width, H=canvas.height;
      ctx.fillStyle='#0b1022'; ctx.fillRect(0,0,W,H);
      const r = 100 + 60*Math.sin(t*0.001);
      const gx = touchX*W, gy = touchY*H;
      const g = ctx.createRadialGradient(gx,gy,10, gx,gy,r);
      g.addColorStop(0,'#88aaff'); g.addColorStop(1,'#000000');
      ctx.fillStyle=g; ctx.fillRect(0,0,W,H);
      requestAnimationFrame(draw2D);
    }
    requestAnimationFrame(draw2D);
  }
})();
