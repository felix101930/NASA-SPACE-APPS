import * as THREE from 'three';

/* Artemis IV launch inset: NASA SLS model (painted by part), boosters peel off, Orion heads for the Moon.
   sls.bin parts: 0 core, 1 engines, 2 adapter, 3 upper stage + Orion, 4/5 booster -x (+nozzle), 6/7 booster +x (+nozzle). */
const COL = [[.62, .24, .06], [.22, .22, .23], [.70, .71, .73], [.90, .89, .86], [.90, .89, .86], [.22, .22, .23], [.90, .89, .86], [.22, .22, .23]];
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

function parse(buf) {
  const dv = new DataView(buf); let o = 0; const n = dv.getUint32(o, true); o += 4; const parts = [];
  for (let p = 0; p < n; p++) {
    const nV = dv.getUint32(o, true), nI = dv.getUint32(o + 4, true); o += 8;
    const q = new Int16Array(buf, o, nV * 3); o += nV * 6; o = (o + 3) & ~3;
    const idx = nV < 65536 ? new Uint16Array(buf, o, nI) : new Uint32Array(buf, o, nI); o += nI * idx.BYTES_PER_ELEMENT; o = (o + 3) & ~3;
    const pos = new Float32Array(nV * 3);
    for (let i = 0; i < nV; i++) { pos[i * 3] = q[i * 3] / 100; pos[i * 3 + 1] = q[i * 3 + 2] / 100; pos[i * 3 + 2] = -q[i * 3 + 1] / 100; } // z-up -> y-up
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex(new THREE.BufferAttribute(idx.slice(), 1));
    g.computeVertexNormals(); parts.push(g);
  }
  return parts;
}

function plume(r, h) {
  const g = new THREE.CylinderGeometry(r * .7, r * 1.7, h, 24, 1, true); g.translate(0, -h / 2, 0);   // from the nozzle down
  const m = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, uniforms: { k: { value: 1 } },
    vertexShader: 'varying float vY; varying vec3 vN; varying vec3 vV; void main(){ vY = position.y; vN = normalize(normalMatrix*normal); vec4 mv = modelViewMatrix*vec4(position,1.); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }',
    fragmentShader: `uniform float k; varying float vY; varying vec3 vN; varying vec3 vV;
      void main(){ float t = clamp(-vY / ${h.toFixed(1)}, 0., 1.); float f = pow(abs(dot(normalize(vN), vV)), 1.5);
        vec3 c = mix(vec3(1.,.97,.85), vec3(1.,.55,.15), smoothstep(.0,.35,t));
        gl_FragColor = vec4(c * f * (1.-t) * (1.-t) * 1.6 * k, 1.); }`,
  });
  const mesh = new THREE.Mesh(g, m); mesh.frustumCulled = false; return mesh;
}

export function buildLaunch(canvas, buf, moonModel) {
  const R = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  R.setPixelRatio(Math.min(devicePixelRatio, 1.5)); R.toneMapping = THREE.ACESFilmicToneMapping; R.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0);
  const cam = new THREE.PerspectiveCamera(32, .75, 1, 40000);
  scene.add(new THREE.HemisphereLight(0x9ab0d8, 0x101010, .35));
  const sun = new THREE.DirectionalLight(0xffffff, 3.3); sun.position.set(-1, .35, .9); scene.add(sun);
  // stars
  { const n = 2500, p = new Float32Array(n * 3); for (let i = 0; i < n; i++) { const v = new THREE.Vector3().randomDirection().multiplyScalar(30000); p.set([v.x, v.y, v.z], i * 3); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xc8cfe0, size: 1.3, sizeAttenuation: false, transparent: true, opacity: .9 }))); }
  const starsMat = scene.children[scene.children.length - 1].material;

  const parts = parse(buf);
  const mk = i => new THREE.Mesh(parts[i], new THREE.MeshStandardMaterial({ color: new THREE.Color(...COL[i]), roughness: .62, metalness: .05 }));
  const rocket = new THREE.Group(); scene.add(rocket);
  const core = new THREE.Group(), upper = new THREE.Group(), bL = new THREE.Group(), bR = new THREE.Group();
  core.add(mk(0), mk(1), mk(2)); upper.add(mk(3)); bL.add(mk(4), mk(5)); bR.add(mk(6), mk(7));
  rocket.add(core, upper, bL, bR);
  // booster axes (x) for their plumes
  const bx = new THREE.Box3().setFromObject(bR.children[0]); const bxc = (bx.min.x + bx.max.x) / 2;
  const pCore = plume(9, 150); pCore.position.set(0, 3, 0); core.add(pCore);
  const pL = plume(5.5, 190), pR = plume(5.5, 190); pL.position.set(-bxc, 3, 0); pR.position.set(bxc, 3, 0); bL.add(pL); bR.add(pR);
  const pUp = plume(3, 50); pUp.position.set(0, 148, 0); upper.add(pUp);

  // the Moon, ahead and up-right
  const moon = new THREE.Group(); scene.add(moon);
  // this inset is its own WebGL context, so it gets its own 2048 copy of the Moon map instead of a second 4096 upload
  const small = map => {
    if (!map || !map.image || !map.image.width) return map || null;
    const c = document.createElement('canvas'); c.width = Math.min(2048, map.image.width); c.height = Math.round(c.width * map.image.height / map.image.width);
    c.getContext('2d').drawImage(map.image, 0, 0, c.width, c.height);
    const t = new THREE.CanvasTexture(c); t.colorSpace = map.colorSpace; t.flipY = map.flipY; t.anisotropy = 4; return t;
  };
  { const m = moonModel.clone(true); m.traverse(o => { if (o.isMesh) o.material = new THREE.MeshStandardMaterial({ map: small(o.material.map), color: o.material.map ? 0xffffff : 0x9a9894, roughness: 1 }); });
    moon.add(m); moon.scale.setScalar(520 / 1737.4); }

  // flight path: pitch over toward the Moon; distance grows as p^2
  const pitch = p => lerp(0, 52, sstep(.06, .85, p)) * Math.PI / 180;
  const path = p => { let x = 0, y = 0; const N = 60; for (let i = 0; i < N; i++) { const a = (i + .5) / N * p; const ds = 2 * 2600 * a * p / N; x += Math.sin(pitch(a)) * ds; y += Math.cos(pitch(a)) * ds; } return new THREE.Vector3(x, y, 0); };
  const end = path(1), endDir = new THREE.Vector3(Math.sin(pitch(1)), Math.cos(pitch(1)), 0);
  moon.position.copy(end).addScaledVector(endDir, 3600).add(new THREE.Vector3(0, 300, -500));

  const SEP_B = .34, SEP_C = .62;
  const place = (g, p0, p, out, rot) => {
    // a stage released at p0 keeps the path up to p0, then falls behind and drifts sideways
    const d = Math.max(0, p - p0), P = path(p0), a = pitch(p0);
    const back = d * d * 2600 * .9 + d * 400;
    g.position.set(P.x - Math.sin(a) * back + Math.cos(a) * out * d * 120, P.y - Math.cos(a) * back - Math.sin(a) * out * d * 120, out * d * 30);
    g.rotation.set(0, 0, -a + rot * d * 3.2);
  };
  let w = 0, h = 0;
  function render(p) {
    if (canvas.clientWidth !== w || canvas.clientHeight !== h) {
      w = canvas.clientWidth; h = canvas.clientHeight;
      R.setPixelRatio(Math.min(devicePixelRatio, 1.5, Math.sqrt(4.2e6 / Math.max(1, w * h))));   // same budget as the main view
      R.setSize(w, h, false); cam.aspect = w / h;
      // full screen on a wide display: keep the rocket in the right half, clear of the title
      if (w / h > 1.2) cam.setViewOffset(w, h, -w * .2, 0, w, h); else cam.clearViewOffset();
      cam.updateProjectionMatrix();
    }
    const P = path(p), a = pitch(p);
    // the whole stack follows the path; released stages are re-parented in world terms each frame
    rocket.position.set(0, 0, 0); rocket.rotation.set(0, 0, 0);
    const setLive = g => { g.position.copy(P); g.rotation.set(0, 0, -a); g.updateMatrixWorld(); };
    p < SEP_B ? (setLive(bL), setLive(bR)) : (place(bL, SEP_B, p, -1, .6), place(bR, SEP_B, p, 1, -.6));
    p < SEP_C ? setLive(core) : place(core, SEP_C, p, 0, .25);
    setLive(upper);
    if (p >= SEP_C) { const d = p - SEP_C; upper.position.add(new THREE.Vector3(Math.sin(a), Math.cos(a), 0).multiplyScalar(d * d * 1200)); upper.updateMatrixWorld(); }
    const flame = sstep(0, .03, p);
    pL.material.uniforms.k.value = pR.material.uniforms.k.value = flame * (1 - sstep(SEP_B - .01, SEP_B + .02, p)) * (.9 + .1 * Math.sin(p * 900));
    pCore.material.uniforms.k.value = flame * (1 - sstep(SEP_C - .01, SEP_C + .01, p)) * (.8 + .1 * Math.sin(p * 700));
    pUp.material.uniforms.k.value = sstep(SEP_C + .02, SEP_C + .05, p);
    // camera: side view on the stack, then swings behind Orion and looks ahead to the Moon
    const focus = p < SEP_C ? upper.localToWorld(new THREE.Vector3(0, 110, 0)) : upper.localToWorld(new THREE.Vector3(0, 172, 0));
    const fwd = new THREE.Vector3(Math.sin(a), Math.cos(a), 0);
    const side = new THREE.Vector3(lerp(-60, 120, sstep(0, .6, p)), lerp(-40, -140, sstep(0, .6, p)), lerp(380, 560, sstep(0, .6, p)));
    const chase = fwd.clone().multiplyScalar(-400).add(new THREE.Vector3(0, 0, 120)).add(new THREE.Vector3(-fwd.y, fwd.x, 0).multiplyScalar(-40));
    const ks = sstep(SEP_C - .02, SEP_C + .2, p);
    cam.position.copy(focus).add(side.lerp(chase, ks));
    const tO = focus.clone().sub(cam.position).normalize(), tM = moon.position.clone().sub(cam.position).normalize();
    cam.lookAt(cam.position.clone().add(tO.add(tM.multiplyScalar(sstep(SEP_C + .12, SEP_C + .26, p) * .9))));    // sky: blue at liftoff, black within seconds
    const k = 1 - sstep(.02, .22, p);
    scene.background.setRGB(.03 * k, .09 * k, .21 * k);
    starsMat.opacity = sstep(.08, .3, p);
    R.render(scene, cam);
  }
  // upload textures and compile shaders up front (called behind the loader)
  function warm() {
    scene.traverse(o => { if (o.material && o.material.map) R.initTexture(o.material.map); });
    R.compile(scene, cam);
  }
  return { render, warm };
}
