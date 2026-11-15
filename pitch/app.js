import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { buildLaunch } from './launch.js';
import { buildGround } from './earth_ground.js';
import { buildFlyup } from './kohler_flyup.js';

/* =========================================================================
   Rehearse Here: one continuous descent to the lunar south pole.
   Units: 1 world unit = 1 km. Polar stereographic (x east, z = -north).
   ========================================================================= */

const R_MOON = 1737.4;
const EX = 1.5;                       // vertical exaggeration (stated in credits)
const PLATE_W = 400;                  // km, LOLA overview window
const TILE_W = 15;                    // km, Mons Mouton tile
const TILE_N = 500;
const TILE_ORIGIN = [65520, 125520];  // Mons Mouton tile west / north edges (m), from regions.json
const TILE_C = [(TILE_ORIGIN[0] + 7500) / 1000, -(TILE_ORIGIN[1] - 7500) / 1000];
// ?demo= overrides; on localhost the button opens the local app, anywhere else the deployed one
const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
const DEMO_URL = new URLSearchParams(location.search).get('demo') || (LOCAL ? 'http://localhost:5173/' : 'https://moon-on-earth.vercel.app/');

const TEX = 'assets/img/earth/';   // three-globe 2.31.0 example images (NASA Blue Marble), served locally
const ATH = [77.108, -137.993];       // Athena, 84.7906 S 29.1957 E (LROC), in world km

/* the nine Artemis candidate landing regions: axis-aligned boxes in polar stereographic metres (USGS A3 outlines) */
const REGIONS = [
  ['Nobile Rim 2', 146998, 166998, 85001, 105001], ['Mons Mouton', 65000, 81000, 110000, 126000],
  ['Malapert Massif', -11000, 10000, 111000, 132000], ['Mons Mouton Plateau', 49053, 125947, 119053, 176948],
  ['de Gerlache Rim 2', -58500, -38500, 13000, 33000], ['Slater Plain', 60002, 79997, -59997, -40002],
  ['Peak near Cabeus B', -189998, -170002, 60002, 79998], ['Nobile Rim 1', 73994, 93994, 100070, 120070],
  ['Haworth', -52900, -23100, 75600, 105400],
];
const HOT = 3; // Mons Mouton Plateau: Athena's point lies inside this box

/* ---------------------------------------------------------------- beats */
const BEATS = [
  ['open', 1.4], ['descent', 1.6], ['photo', 2.4], ['athena', 1.0], ['lowsun', 1.6], ['money', 1.4], ['tally', 1.3],
  ['people', 3.6], ['regions', 1.7], ['slope', 0.01], ['turn', 0.8], ['earth', 1.4], ['handoff', 1.1], ['gaps', 1.6],
  ['outro', 3.4], ['close', 3.2],
];
const B = {}; let acc = 0;
for (const [n, l] of BEATS) { B[n] = { s: acc, l, e: acc + l }; acc += l; }
const TOTAL = acc;
const at = (n, f) => B[n].s + B[n].l * f;

const CAPS = [
  { beat: 'open', a: .18, b: .92, cls: 'center kinetic', html: 'TEAM KINETIC' },
  { beat: 'descent', a: .45, b: .97, html: 'March 2025.<br>The Moon’s south pole.' },
  { beat: 'photo', a: .30, b: .54, cls: 'center', html: 'Recognize this?' },
  { beat: 'photo', a: .60, b: .99, html: 'Those are its <em>feet.</em>', src: 'Lander on its side · Mons Mouton · 6 March 2025' },
  { beat: 'athena', a: .06, b: .96, html: 'Athena. NASA-funded.<br>Landed on its side.', src: 'NASA CLPS delivery · Intuitive Machines IM-2' },
  { beat: 'lowsun', a: .04, b: .42, html: 'Low sun.<br>Long shadows.' },
  { beat: 'lowsun', a: .50, b: .98, cls: 'top', html: 'Craters didn’t look like<br>its reference maps.', src: 'Intuitive Machines post-mission review, May 2025' },
  { beat: 'people', a: .1, b: .36, html: 'Next landing has<br><em>people</em> on board.', src: 'Artemis IV · targeted early 2028 · ~$4.1B per launch (NASA OIG, 2021)' },
  { beat: 'regions', a: .40, b: .98, html: 'Nine candidate regions.<br>Athena fell in <em>one.</em>', src: 'NASA, Oct 2024 · Athena’s LROC position lies inside Mons Mouton Plateau' },
  { beat: 'turn', a: .06, b: .97, html: 'You can’t rehearse<br>on the Moon.' },
  { beat: 'earth', a: .74, b: .995, html: 'So we found<br>where <em>you can.</em>', src: 'Kohler Coulee · NASA HLS satellite image, 9 Oct 2025 · Copernicus GLO-30 terrain' },
  { beat: 'handoff', a: .10, b: .98, cls: 'center', html: 'Let us show you.' },
  { beat: 'outro', a: .05, b: .31, html: 'Next time,<br>we land safely<br>on the Moon.' },
  { beat: 'outro', a: .40, b: .62, html: 'Gotcha.<br>This is <em>Alberta.</em>', src: 'Same hills, same camera, real colours · Copernicus GLO-30 terrain + NASA HLS image, 9 Oct 2025' },
  { beat: 'outro', a: .70, b: .985, html: 'Kohler Coulee.<br>100 km south of Calgary.', src: 'Best Alberta match to the shadows at Mons Mouton Plateau · the world’s best is in Chile' },
  { beat: 'close', a: .8, b: 1.2, html: 'Rehearse here.<br>Land there.' },   // once Earth and Moon are both in frame; stays to the very end
];

/* ---------------------------------------------------------------- helpers */
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const local = (u, n) => clamp((u - B[n].s) / B[n].l);
const inBeat = (u, n, pad = 0) => u >= B[n].s - pad && u <= B[n].e + pad;
const D2R = Math.PI / 180;

/* ---------------------------------------------------------------- loading */
const loaderBar = document.querySelector('#loader-bar i');
let loaded = 0; const toLoad = 8;
const tick = () => { loaded++; loaderBar.style.width = `${(loaded / toLoad) * 100}%`; };
const bin = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(url); const b = await r.arrayBuffer(); tick(); return new Float32Array(b); };
const gltf = new GLTFLoader();
const draco = new DRACOLoader(); draco.setDecoderPath('assets/vendor/draco/');
gltf.setDRACOLoader(draco);
const glb = url => new Promise((res, rej) => gltf.load(url, g => { tick(); res(g.scene); }, undefined, rej));
const texL = new THREE.TextureLoader(); texL.setCrossOrigin('anonymous');
// a missing texture must not stop the pitch, but it must be visible before going on stage
const missing = [];
const tex = url => new Promise(res => texL.load(url, t => res(t), undefined, () => { missing.push(url.split('/').pop()); res(null); }));
const raw = async url => { const r = await fetch(url); if (!r.ok) throw new Error(url); return r.arrayBuffer(); };

/** Flip rows so row 0 is south (texture v = 0), convert m -> km. */
function toKmSouthUp(a, n) {
  const o = new Float32Array(n * n);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) o[r * n + c] = a[(n - 1 - r) * n + c] / 1000;
  return o;
}
function dataTex(a, n) {
  const t = new THREE.DataTexture(a, n, n, THREE.RedFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.LinearFilter; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true; return t;
}
function bilinear(a, n, u, v) {
  const x = clamp(u) * (n - 1), y = clamp(v) * (n - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(n - 1, x0 + 1), y1 = Math.min(n - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  return lerp(lerp(a[y0 * n + x0], a[y0 * n + x1], fx), lerp(a[y1 * n + x0], a[y1 * n + x1], fx), fy);
}
const mean = a => { let s = 0; for (const v of a) s += v; return s / a.length; };

/* ---------------------------------------------------------------- renderer */
const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
// drawing-buffer budget: a 4K projector at full density would be 8+ million pixels a frame; cap it so every scene
// keeps a smooth frame rate on any screen (the browser scales the canvas up)
const MAX_PX = 4.2e6;
const pixelRatio = () => Math.min(devicePixelRatio, 1.6, Math.sqrt(MAX_PX / Math.max(1, innerWidth * innerHeight)));
renderer.setPixelRatio(pixelRatio());
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.extensions.get('OES_texture_float_linear');
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;  // only the Earth ground casts shadows

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.00002, 80000);
scene.add(camera);

const sun = new THREE.DirectionalLight(0xffffff, 3.2);
scene.add(sun); scene.add(sun.target);
const hemi = new THREE.HemisphereLight(0x8fb4ff, 0x2a2018, 0.0);
scene.add(hemi);
const amb = new THREE.AmbientLight(0x9aa6c8, 0.03);
scene.add(amb);

/* stars */
const stars = (() => {
  const n = 6000, p = new Float32Array(n * 3), s = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(40000);
    p.set([v.x, v.y, v.z], i * 3); s[i] = Math.pow(Math.random(), 6) * 3 + 0.6;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  g.setAttribute('size', new THREE.BufferAttribute(s, 1));
  const m = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, uniforms: { op: { value: 1 } },
    vertexShader: `attribute float size; varying float vS;
#include <common>
#include <logdepthbuf_pars_vertex>
void main(){ vS=size; vec4 mv=modelViewMatrix*vec4(position,1.); gl_Position=projectionMatrix*mv; gl_PointSize=size;
#include <logdepthbuf_vertex>
}`,
    fragmentShader: `uniform float op; varying float vS;
#include <logdepthbuf_pars_fragment>
void main(){
#include <logdepthbuf_fragment>
float d=length(gl_PointCoord-.5); float a=smoothstep(.5,.0,d); gl_FragColor=vec4(vec3(.85,.88,1.)*min(1.,vS*.5),a*op); }`,
  });
  const pts = new THREE.Points(g, m); pts.frustumCulled = false; scene.add(pts); return pts;
})();

/* sky dome (only shows on Earth) */
const sky = new THREE.Mesh(new THREE.SphereGeometry(50000, 32, 16), new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, uniforms: { k: { value: 0 } },
  vertexShader: `varying vec3 vD;
#include <common>
#include <logdepthbuf_pars_vertex>
void main(){ vD=normalize(position); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);
#include <logdepthbuf_vertex>
}`,
  fragmentShader: `uniform float k; varying vec3 vD;
#include <logdepthbuf_pars_fragment>
void main(){
#include <logdepthbuf_fragment>
    float y=vD.y; vec3 gnd=vec3(.70,.62,.55)*.85; vec3 hor=vec3(.86,.68,.52); vec3 mid=vec3(.48,.62,.82); vec3 top=vec3(.12,.24,.47);
    vec3 c=mix(hor,mid,smoothstep(0.,.14,y)); c=mix(c,top,smoothstep(.14,.7,y)); c=mix(gnd,c,smoothstep(-.02,.005,y));
    gl_FragColor=vec4(c*k,1.); }`,
}));
sky.renderOrder = -10; scene.add(sky);

/* ---------------------------------------------------------------- terrain shader */
const TERRAIN_VS = `
uniform sampler2D hA; uniform sampler2D hB; uniform float morph; uniform float offB; uniform float ex; uniform float R;
varying vec2 vUv; varying vec3 vW;
#include <common>
#include <logdepthbuf_pars_vertex>
float H(vec2 uv){ return mix(texture2D(hA,uv).r, texture2D(hB,uv).r + offB, morph); }
void main(){
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position.x, H(uv)*ex, position.z, 1.);
  wp.y -= dot(wp.xz, wp.xz) / (2.*R);
  vW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}`;
const TERRAIN_FS = `
uniform sampler2D hA; uniform sampler2D hB; uniform float morph; uniform float offB; uniform float ex;
uniform float sizeKm; uniform float texel; uniform vec3 sunDir; uniform float tanEl; uniform vec2 sunH;
uniform float shadowOn; uniform float split; uniform vec3 refDir; uniform float slopeMode; uniform float bright;
uniform vec3 sunCol; uniform vec3 astro; uniform float astroOn; uniform float plate; uniform vec4 tileRect; uniform float hideTile;
uniform float alpha; uniform vec3 camPos; uniform float haze; uniform float reveal;
uniform float sweep; uniform float edgeDark;
uniform float detail; uniform vec2 dO; uniform vec2 fpP0; uniform vec2 fpDir; uniform float fpLen;
uniform vec4 boxes[9]; uniform float boxOp[9]; uniform float hotFill; uniform float boxesOn;
varying vec2 vUv; varying vec3 vW;
#include <common>
#include <logdepthbuf_pars_fragment>
float H(vec2 uv){ return mix(texture2D(hA,uv).r, texture2D(hB,uv).r + offB, morph); }
float hsh(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x*p.y); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.-2.*f);
  return mix(mix(hsh(i), hsh(i+vec2(1.,0.)), u.x), mix(hsh(i+vec2(0.,1.)), hsh(i+vec2(1.,1.)), u.x), u.y); }
float fbm(vec2 p){ float a = .5, s = 0.; for (int i = 0; i < 4; i++){ s += a*vn(p); p = p*2.03 + 17.1; a *= .5; } return s; }
// bowl-shaped craters with raised rims, one candidate per cell
float crat(vec2 p){
  vec2 i = floor(p), f = fract(p); float h = 0.;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++){
    vec2 g = vec2(float(x), float(y));
    if (hsh(i+g+11.3) > .38) continue;
    vec2 c = g + vec2(hsh(i+g), hsh(i+g+7.7));
    float r = .07 + .38*pow(hsh(i+g+3.1), 2.2); float d = length(c - f) / r;
    h += d < 1. ? (d*d - 1.)*r : .35*r*(1. - smoothstep(1., 1.5, d));
  }
  return h;
}
// metre-scale relief the 30 m data cannot show: regolith ripples, small craters, clods
float micro(vec2 m){ return fbm(m*.3)*.5 + fbm(m*2.2)*.06 + crat(m*.045)*1.8 + crat(m*.21 + 3.7)*.3; }
void main(){
  #include <logdepthbuf_fragment>
  if (hideTile > .5 && vW.x > tileRect.x && vW.x < tileRect.z && vW.z > tileRect.y && vW.z < tileRect.w) discard;
  float e = texel;
  float hl=H(vUv-vec2(e,0.)), hr=H(vUv+vec2(e,0.)), hd=H(vUv-vec2(0.,e)), hu=H(vUv+vec2(0.,e));
  float gx=(hr-hl)/(2.*e*sizeKm), gv=(hu-hd)/(2.*e*sizeKm);
  float slopeDeg = degrees(atan(length(vec2(gx,gv))));
  vec3 n = vec3(-gx*ex, 1., gv*ex);
  float tone = 1.;
  float dpx = detail * (1. - smoothstep(.03, .45, length(vW - camPos)));
  if (dpx > .01) {
    vec2 m = (vW.xz - dO) * 1000.;
    float k = .12;
    float dx = (micro(m + vec2(k,0.)) - micro(m - vec2(k,0.))) / (2.*k);
    float dz = (micro(m + vec2(0.,k)) - micro(m - vec2(0.,k))) / (2.*k);
    n.xz -= vec2(dx, dz) * dpx;
    tone = mix(1., .9 + .16*fbm(m*.05) + .1*fbm(m*1.7), dpx);
  }
  // brightness variation at 25 m to 1 km scale (fresh ejecta, darker patches), fades with distance so it never shimmers
  float pxw = fwidth(vW.x) + fwidth(vW.z);
  if (plate < .5) tone *= mix(1., .84 + .3*fbm(vW.xz*1.3 + 3.), .6) * mix(1., .86 + .28*fbm(vW.xz*22. + 9.), .7*(1. - smoothstep(.004, .02, pxw)));
  n = normalize(n);
  float lam = max(dot(n, sunDir), 0.);
  // cast shadow: march toward the sun over the true-scale heightfield
  float sh = 1.;
  if (shadowOn > .5 && sunDir.y < .6) {
    float h0 = H(vUv);
    for (int i = 0; i < 72; i++) {
      float f = (float(i)+1.)/72.;
      float t = sizeKm * .95 * f * f + sizeKm * .0015;
      vec2 q = vUv + sunH * t / sizeKm;
      if (q.x < 0. || q.y < 0. || q.x > 1. || q.y > 1.) break;
      float d = (h0 + t*tanEl) - H(q);
      sh = min(sh, clamp(d/(t*.0094) + .5, 0., 1.));
      if (sh <= 0.) break;
    }
  }
  // astronaut's long shadow (vertical capsule, 1.8 m)
  if (astroOn > .5) {
    vec2 sw = normalize(vec2(sunDir.x, sunDir.z));
    vec2 rel = vW.xz - astro.xz;
    float along = -dot(rel, sw);
    float L = .0018 / max(tanEl, .005);
    vec2 perp = rel + sw * along;
    float w = .00028 * (1. - .5*clamp(along/L,0.,1.));
    float inS = step(0., along) * (1.-smoothstep(L*.85, L, along)) * (1.-smoothstep(w*.6, w, length(perp)));
    sh *= 1. - .92*inS;
    // boot prints behind the walk
    vec2 fr = vW.xz - fpP0; vec2 fq = vec2(-fpDir.y, fpDir.x);
    float al = dot(fr, fpDir), la = dot(fr, fq);
    if (al > 0. && al < fpLen - .0005) {
      float kk = floor(al / .00042); float side = mod(kk, 2.) * 2. - 1.;
      vec2 fp = vec2((al - (kk + .5)*.00042) / .00015, (la - side*.00012) / .00006);
      tone *= 1. - .35*(1. - smoothstep(.7, 1., length(fp)));
    }
  }
  vec3 albMoon = vec3(.50,.49,.47);
  vec3 albEarth = mix(vec3(.74,.58,.38), vec3(.52,.50,.30), smoothstep(6.,18.,slopeDeg));
  vec3 alb = mix(albMoon, albEarth, morph) * tone;
  vec3 col = alb * (lam * sh * sunCol + mix(vec3(.018,.020,.026), vec3(.20,.24,.30), morph));
  if (slopeMode > 0.) {
    // readable relief, red hatching only where the ground is steeper than 8 degrees
    vec3 base = col * .9 + albMoon * .03;
    float on = step(vW.x, sweep);
    float steep = smoothstep(7.6, 8.4, slopeDeg) * on;
    float s = (vW.x - vW.z) / .11;
    float aa = fwidth(s);
    float stripe = 1. - smoothstep(.34 - aa, .34 + aa, abs(fract(s) - .5) * 2.);
    vec3 sc = mix(base, mix(base*.7, vec3(.95,.2,.1) * (.55 + .6*lam*sh), stripe), steep);
    float fw = max(fwidth(slopeDeg), 1e-3);
    float edge = (1. - smoothstep(.0, 1.2, abs(slopeDeg - 8.) / fw)) * on;
    sc = mix(sc, vec3(1.,.42,.28), edge * .9);
    sc = mix(sc, vec3(1.), (1. - smoothstep(0., .05, abs(vW.x - sweep))) * .8 * step(sweep, tileRect.z));
    col = mix(col, sc, slopeMode);
  }
  if (gl_FragCoord.x < split) {
    col = albMoon * (max(dot(n, refDir),0.)*.85 + .04);
  }
  if (boxesOn > 0.) {
    vec2 p = vW.xz; float px = max(fwidth(p.x), fwidth(p.y));
    for (int i = 0; i < 9; i++) {
      vec4 b = boxes[i];
      float ins = step(b.x, p.x) * step(p.x, b.z) * step(b.y, p.y) * step(p.y, b.w);
      float d = min(min(p.x - b.x, b.z - p.x), min(p.y - b.y, b.w - p.y));
      float line = ins * (1. - smoothstep(px * 1.2, px * 2.4, d));
      vec3 lc = i == ${HOT} ? vec3(1.2,.3,.16) : vec3(1.05,1.03,1.);
      col = mix(col, lc, line * boxOp[i] * boxesOn);
      if (i == ${HOT}) col = mix(col, col * vec3(1.5, .55, .45) + vec3(.07, .012, .006), ins * hotFill * boxesOn);
    }
  }
  float dist = length(vW - camPos);
  col = mix(col, vec3(.70,.62,.55), (1.-exp(-dist*haze))*morph*.85);
  float a = alpha;
  if (plate > .5) {
    float rr = length(vW.xz - vec2(30.,-60.));
    float pedge = 1. - smoothstep(150., 199., max(abs(vW.x), abs(vW.z)));
    // late in the film the far edge goes black instead of see-through, so ridges never float
    a = (1. - smoothstep(reveal - 70., reveal, rr)) * mix(pedge, 1., edgeDark);
    col *= mix(1., pedge, edgeDark);
    // a thin scanning ring at the reveal front
    col += vec3(.9,.95,1.) * .25 * (1. - smoothstep(0., 3., abs(rr - reveal + 35.))) * step(reveal, 330.) * bright;
  }
  gl_FragColor = vec4(col * bright, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function terrainMaterial(texA, texB, sizeKm, n, isPlate) {
  return new THREE.ShaderMaterial({
    vertexShader: TERRAIN_VS, fragmentShader: TERRAIN_FS, transparent: isPlate,
    uniforms: {
      hA: { value: texA }, hB: { value: texB }, morph: { value: 0 }, offB: { value: 0 }, ex: { value: EX }, R: { value: R_MOON },
      sizeKm: { value: sizeKm }, texel: { value: 1 / n }, sunDir: { value: new THREE.Vector3(0, 1, 0) }, tanEl: { value: .05 },
      sunH: { value: new THREE.Vector2(0, 1) }, shadowOn: { value: 1 }, split: { value: -1 }, refDir: { value: new THREE.Vector3(.4, .8, .4).normalize() },
      slopeMode: { value: 0 }, bright: { value: 1 }, sunCol: { value: new THREE.Color(1, 1, 1) }, astro: { value: new THREE.Vector3() },
      astroOn: { value: 0 }, plate: { value: isPlate ? 1 : 0 }, tileRect: { value: new THREE.Vector4() }, hideTile: { value: 0 },
      alpha: { value: 1 }, camPos: { value: new THREE.Vector3() }, haze: { value: 0 }, reveal: { value: 400 },
      sweep: { value: 1e9 }, edgeDark: { value: 0 },
      detail: { value: 0 }, dO: { value: new THREE.Vector2() }, fpP0: { value: new THREE.Vector2() }, fpDir: { value: new THREE.Vector2(1, 0) }, fpLen: { value: 0 },
      boxes: { value: REGIONS.map(([, x0, x1, y0, y1]) => new THREE.Vector4(x0 / 1000, -y1 / 1000, x1 / 1000, -y0 / 1000)) },
      boxOp: { value: REGIONS.map(() => 0) }, hotFill: { value: 0 }, boxesOn: { value: 0 },
    },
  });
}
function planeGeo(w, seg) { const g = new THREE.PlaneGeometry(w, w, seg, seg); g.rotateX(-Math.PI / 2); return g; }

/* ---------------------------------------------------------------- walking astronaut (vertex shader on the NASA model) */
const walkU = { wPh: { value: 0 }, wSw: { value: 0 } };
function makeWalker(mat) {
  mat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, walkU);
    const hasN = sh.vertexShader.includes('#include <beginnormal_vertex>') && !/#ifdef USE_DISPLACEMENTMAP\s*#include <beginnormal_vertex>/.test(sh.vertexShader);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
uniform float wPh; uniform float wSw;
vec3 rX(vec3 v, float a){ float c = cos(a), s = sin(a); return vec3(v.x, c*v.y - s*v.z, s*v.y + c*v.z); }
vec3 rY(vec3 v, float a){ float c = cos(a), s = sin(a); return vec3(c*v.x + s*v.z, v.y, -s*v.x + c*v.z); }
void walk(inout vec3 p, inout vec3 n){
  float side = p.x >= 0. ? 1. : -1.;
  float ph = sin(wPh + (side > 0. ? 0. : 3.14159));
  // legs swing from the hip (z = -12); fade over the crotch to avoid tearing
  float wl = smoothstep(-9., -15., p.z) * smoothstep(.5, 3.5, abs(p.x));
  float a = .42 * wSw * ph * wl;
  vec3 piv = vec3(0., 0., -12.);
  p = rX(p - piv, a) + piv; n = rX(n, a);
  float wk = smoothstep(-22., -28., p.z) * wl * max(0., -ph) * wSw;
  vec3 kp = vec3(0., 0., -25.);
  p = rX(p - kp, -.5*wk) + kp; n = rX(n, -.5*wk);
  // arms: down from the T-pose, then swing against the legs
  float wa = smoothstep(13., 17., abs(p.x)) * smoothstep(6., 10., p.z) * smoothstep(26., 22., p.z);
  vec3 sp = vec3(side*14.5, 0., 18.);
  float down = side * 1.25 * wa;
  p = rY(p - sp, down) + sp; n = rY(n, down);
  float sa = -.35 * wSw * ph * wa;
  p = rX(p - sp, sa) + sp; n = rX(n, sa);
}`);
    sh.vertexShader = hasN
      ? sh.vertexShader.replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nvec3 wPos = position; walk(wPos, objectNormal);').replace('#include <begin_vertex>', 'vec3 transformed = wPos;')
      : sh.vertexShader.replace('#include <begin_vertex>', 'vec3 wPos = position; vec3 wN = vec3(0., 0., 1.); walk(wPos, wN); vec3 transformed = wPos;');
  };
  mat.needsUpdate = true;
}

/* ---------------------------------------------------------------- Earth in the lunar sky */
const RE = 300, E_DIST = 18000, E_EL = 9 * D2R;   // right angular size (~1.9°) from the Moon
const EARTH_ROT = new THREE.Euler(51.5 * D2R, 22.5 * D2R, 0, 'XYZ'); // turns Alberta toward +z
const EARTH_VS = `varying vec2 vUv; varying vec3 vN; varying vec3 vV;
#include <common>
#include <logdepthbuf_pars_vertex>
void main(){ vUv = uv; vN = normalize(mat3(modelMatrix) * normal); vec4 wp = modelMatrix * vec4(position, 1.);
  vV = normalize(cameraPosition - wp.xyz); gl_Position = projectionMatrix * viewMatrix * wp;
#include <logdepthbuf_vertex>
}`;
function earthMaterial(day, water) {
  return new THREE.ShaderMaterial({
    uniforms: { day: { value: day }, water: { value: water }, hasTex: { value: day && water ? 1 : 0 }, L: { value: new THREE.Vector3(.55, .35, .76).normalize() } },
    vertexShader: EARTH_VS,
    fragmentShader: `uniform sampler2D day; uniform sampler2D water; uniform float hasTex; uniform vec3 L; varying vec2 vUv; varying vec3 vN; varying vec3 vV;
#include <logdepthbuf_pars_fragment>
void main(){
#include <logdepthbuf_fragment>
  vec3 c = hasTex > .5 ? texture2D(day, vUv).rgb : vec3(.08,.18,.42);
  float w = hasTex > .5 ? texture2D(water, vUv).r : 1.;
  vec3 n = normalize(vN); float d = max(dot(n, L), 0.);
  float spec = pow(max(dot(n, normalize(L + vV)), 0.), 38.) * w * .7;
  float rim = pow(1. - max(dot(n, vV), 0.), 3.);
  vec3 col = c * (d * 1.5 + .015) + spec * vec3(1., .93, .8) + vec3(.3, .55, 1.) * rim * (.1 + d) * .6;
  gl_FragColor = vec4(col, 1.);
#include <tonemapping_fragment>
#include <colorspace_fragment>
}`,
  });
}
const halo = new THREE.ShaderMaterial({
  side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  uniforms: { L: { value: new THREE.Vector3(.55, .35, .76).normalize() } },
  vertexShader: EARTH_VS,
  fragmentShader: `uniform vec3 L; varying vec2 vUv; varying vec3 vN; varying vec3 vV;
#include <logdepthbuf_pars_fragment>
void main(){
#include <logdepthbuf_fragment>
  float k = -dot(normalize(vN), vV);
  float i = pow(smoothstep(0., .29, k), 2.);
  float lit = .25 + .75 * max(dot(normalize(vN), L), 0.);
  gl_FragColor = vec4(vec3(.35, .62, 1.) * i * lit * .9, 1.);
}`,
});

/* ---------------------------------------------------------------- caption DOM */
const capRoot = document.getElementById('captions');
for (const c of CAPS) {
  const el = document.createElement('div'); el.className = `cap ${c.cls || ''}`;
  const h = document.createElement('h2');
  // split into words, keep <br> and <em>
  const tmp = document.createElement('div'); tmp.innerHTML = c.html;
  let wi = 0;
  const walk = (node, into) => {
    for (const ch of node.childNodes) {
      if (ch.nodeType === 3) {
        for (const w of ch.textContent.split(/(\s+)/)) {
          if (!w) continue;
          if (/^\s+$/.test(w)) { into.appendChild(document.createTextNode(' ')); continue; }
          const s = document.createElement('span'); s.className = 'word'; s.dataset.i = wi++; s.textContent = w; into.appendChild(s);
        }
      } else if (ch.nodeName === 'BR') into.appendChild(document.createElement('br'));
      else { const e = document.createElement(ch.nodeName); walk(ch, e); into.appendChild(e); }
    }
  };
  walk(tmp, h); el.appendChild(h);
  if (c.src) { const s = document.createElement('div'); s.className = 'src'; s.textContent = c.src; el.appendChild(s); }
  capRoot.appendChild(el); c.el = el; c.words = [...el.querySelectorAll('.word')]; c.srcEl = el.querySelector('.src');
}

/* split-view labels */
const splitUI = document.createElement('div');
splitUI.style.cssText = 'position:fixed;top:0;bottom:0;width:2px;background:#fc3d21;z-index:4;opacity:0;pointer-events:none';
const sL = document.createElement('div'), sR = document.createElement('div');
for (const [d, t] of [[sL, 'Orbital reference · sun 40°'], [sR, 'At landing · sun 1.5°']]) {
  d.textContent = t; d.style.cssText = 'position:absolute;top:44vh;font:11px "IBM Plex Mono",monospace;letter-spacing:.08em;text-transform:uppercase;color:#f2efe9;white-space:nowrap';
  splitUI.appendChild(d);
}
sL.style.right = '16px'; sR.style.left = '16px';
document.body.appendChild(splitUI);

/* ---------------------------------------------------------------- main */
let state;
let posReady = false; // true once init() has resumed the saved slide; only then is the position saved again
let rewarm = null;   // set by init(): re-upload textures and recompile after a lost WebGL context comes back
async function init() {
  const [plateRaw, tileRaw, abRaw, moon, lro, astro, slsBuf, satTex, day, water] = await Promise.all([
    bin('assets/data/polar_768.f32'), bin('assets/data/mons_mouton.bin'), bin('assets/data/AB_073_027.bin'),
    glb('assets/models/moon.glb'), glb('assets/models/lro.glb'), glb('assets/models/astronaut.glb'),
    raw('assets/models/sls.bin'), tex('assets/img/kohler_hls_20251009.jpg'),
    tex(TEX + 'earth-blue-marble.jpg'), tex(TEX + 'earth-water.png'),
  ]);
  tick(); tick();
  const PN = 768;
  const plateH = toKmSouthUp(plateRaw, PN), tileH = toKmSouthUp(tileRaw, TILE_N), abH = toKmSouthUp(abRaw, TILE_N);
  const offAB = mean(tileH) - mean(abH);
  const zero = dataTex(new Float32Array(4), 2);

  /* plate (400 km LOLA overview) */
  const plateTex = dataTex(plateH, PN);
  const plateMat = terrainMaterial(plateTex, zero, PLATE_W, PN, true);
  const plate = new THREE.Mesh(planeGeo(PLATE_W, 383), plateMat); plate.frustumCulled = false; scene.add(plate);

  /* Mons Mouton tile */
  const tileTex = dataTex(tileH, TILE_N), abTex = dataTex(abH, TILE_N);
  const tileMat = terrainMaterial(tileTex, abTex, TILE_W, TILE_N, false);
  tileMat.uniforms.offB.value = offAB;
  const tile = new THREE.Mesh(planeGeo(TILE_W, 499), tileMat); tile.position.set(TILE_C[0], 0, TILE_C[1]); tile.frustumCulled = false; scene.add(tile);
  const rect = new THREE.Vector4(TILE_C[0] - 7.4, TILE_C[1] - 7.4, TILE_C[0] + 7.4, TILE_C[1] + 7.4);
  plateMat.uniforms.tileRect.value.copy(rect);

  const heightTile = (x, z, m = 0) => {
    const u = (x - (TILE_C[0] - 7.5)) / TILE_W, v = ((TILE_C[1] + 7.5) - z) / TILE_W;
    const h = lerp(bilinear(tileH, TILE_N, u, v), bilinear(abH, TILE_N, u, v) + offAB, m);
    return h * EX - (x * x + z * z) / (2 * R_MOON);
  };
  const heightPlate = (x, z) => bilinear(plateH, PN, (x + 200) / PLATE_W, (200 - z) / PLATE_W) * EX - (x * x + z * z) / (2 * R_MOON);

  /* slope statistics on the true 30 m tile (for the gauge caption) */
  // lit test on the true grid for the astronaut's sun (el 2.2, az 250)
  const litAt = (r, c, el = 4.5, az = 250) => {
    const du = Math.sin(az * D2R), dv = Math.cos(az * D2R), te = Math.tan(el * D2R), h0 = tileH[r * TILE_N + c];
    for (let k = 1; k < 600; k++) {
      const cc = Math.round(c + du * k), rr = Math.round(r + dv * k);
      if (cc < 0 || rr < 0 || cc >= TILE_N || rr >= TILE_N) return true;
      if (tileH[rr * TILE_N + cc] > h0 + k * 0.03 * te) return false;
    }
    return true;
  };
  let steep = 0, best = { s: 1e9, r: 250, c: 250 };
  for (let r = 1; r < TILE_N - 1; r++) for (let c = 1; c < TILE_N - 1; c++) {
    const gx = (tileH[r * TILE_N + c + 1] - tileH[r * TILE_N + c - 1]) / 0.06;
    const gy = (tileH[(r + 1) * TILE_N + c] - tileH[(r - 1) * TILE_N + c]) / 0.06;
    const s = Math.atan(Math.hypot(gx, gy)) / D2R;
    if (s > 8) steep++;
    if (r > 120 && r < 380 && c > 120 && c < 380 && r % 3 === 0 && c % 3 === 0) {
      let acc2 = 0;
      for (let dr = -4; dr <= 4; dr++) for (let dc = -4; dc <= 4; dc++) acc2 += Math.abs(tileH[(r + dr) * TILE_N + c + dc] - tileH[r * TILE_N + c]);
      // prefer flat, high ground that the low sun actually reaches
      const score = acc2 - tileH[r * TILE_N + c] * 0.02;
      if (score < best.s && litAt(r, c) && litAt(r + 4, c) && litAt(r - 4, c)) best = { s: score, r, c };
    }
  }
  const steepPct = Math.round(100 * steep / ((TILE_N - 2) ** 2));
  document.getElementById('g-limit').textContent = `Mons Mouton, LOLA 30 m: ${steepPct}% steeper than 8° · limit 8°`;

  /* astronaut on the flattest spot near the tile centre */
  const A = new THREE.Vector3(TILE_C[0] - 7.5 + (best.c / (TILE_N - 1)) * TILE_W, 0, (TILE_C[1] + 7.5) - (best.r / (TILE_N - 1)) * TILE_W);
  const astroG = new THREE.Group(); scene.add(astroG);
  {
    const box = new THREE.Box3().setFromObject(astro); const size = box.getSize(new THREE.Vector3());
    const s = 0.0018 / size.y; astro.scale.setScalar(s);
    const b2 = new THREE.Box3().setFromObject(astro); const c2 = b2.getCenter(new THREE.Vector3());
    astro.position.set(-c2.x, -b2.min.y, -c2.z);
    astro.traverse(o => { if (o.isMesh) { o.frustumCulled = false; if (o.material) { o.material.envMapIntensity = 0; makeWalker(o.material); } } });
    astroG.add(astro);
  }
  const WALK_DIR = new THREE.Vector2(1, 0);   // walks east from the flat spot

  /* Moon globe (NASA SVS, LRO colour) with its south pole pointing up at the origin */
  const globe = new THREE.Group(); scene.add(globe);
  {
    const box = new THREE.Box3().setFromObject(moon); const size = box.getSize(new THREE.Vector3()); const c = box.getCenter(new THREE.Vector3());
    const s = (2 * R_MOON) / Math.max(size.x, size.y, size.z);
    moon.position.copy(c).multiplyScalar(-s); moon.scale.setScalar(s);
    globe.add(moon); globe.rotation.x = Math.PI; globe.position.set(0, -R_MOON, 0);
    moon.traverse(o => {
      if (!o.isMesh) return;
      o.frustumCulled = false;
      const old = o.material;
      o.material = new THREE.MeshStandardMaterial({ map: old.map || null, color: old.map ? 0xffffff : 0x9a9894, roughness: 1, metalness: 0, transparent: true });
    });
  }
  const globeMats = []; moon.traverse(o => { if (o.isMesh) globeMats.push(o.material); });

  /* LRO flies past the lens */
  {
    const box = new THREE.Box3().setFromObject(lro); const size = box.getSize(new THREE.Vector3()); const c = box.getCenter(new THREE.Vector3());
    const s = 0.55 / Math.max(size.x, size.y, size.z); lro.scale.setScalar(s); lro.position.copy(c).multiplyScalar(-s);
  }
  const lroG = new THREE.Group(); lroG.add(lro); camera.add(lroG);

  /* region labels at the north edge of each box */
  const labRoot = document.getElementById('labels');
  const labels = REGIONS.map(([name, x0, x1, y0, y1], i) => {
    const el = document.createElement('div'); el.className = 'rl' + (i === HOT ? ' hot' : '');
    el.textContent = name; labRoot.appendChild(el);
    const wx = (x0 + x1) / 2000, wz = -y1 / 1000;
    return { el, p: new THREE.Vector3(wx, heightPlate(wx, wz) + 1.2, wz), i };
  });

  /* Earth, up in the lunar sky to the north of the astronaut */
  if (day) day.colorSpace = THREE.SRGBColorSpace;
  const EP = new THREE.Vector3(A.x, Math.sin(E_EL) * E_DIST, A.z - Math.cos(E_EL) * E_DIST);
  const earth = new THREE.Group(); earth.position.copy(EP); scene.add(earth);
  const earthTilt = new THREE.Group(); earthTilt.rotation.x = E_EL; earth.add(earthTilt);  // face North America toward the Moon-side viewer
  const earthBall = new THREE.Mesh(new THREE.SphereGeometry(RE, 96, 64), earthMaterial(day, water));
  earthBall.rotation.copy(EARTH_ROT); earthTilt.add(earthBall);
  earth.add(new THREE.Mesh(new THREE.SphereGeometry(RE * 1.045, 64, 32), halo));
  earth.traverse(o => { o.frustumCulled = false; });

  /* closing zoom-out: the whole Earth centred on Kohler Coulee (its own scene, in Earth radii) */
  const KC = [50.18, -113.91];
  const kPhi = (KC[1] + 180) * D2R, kTh = (90 - KC[0]) * D2R;   // SphereGeometry's equirectangular layout
  const kN = new THREE.Vector3(-Math.cos(kPhi) * Math.sin(kTh), Math.cos(kTh), Math.sin(kPhi) * Math.sin(kTh));
  const zScene = new THREE.Scene(); zScene.background = new THREE.Color(0x000000);
  const zMat = earthMaterial(day, water);
  // Alberta in daylight, sun from the north-west so the ocean glint falls on land (no glint there), not the Pacific
  const kEast = new THREE.Vector3().crossVectors(kN, new THREE.Vector3(0, 1, 0)).normalize();
  zMat.uniforms.L.value.copy(kN).applyAxisAngle(kEast, .55).applyAxisAngle(new THREE.Vector3(0, 1, 0), -.25).normalize();
  zScene.add(new THREE.Mesh(new THREE.SphereGeometry(1, 192, 96), zMat));
  const zHalo = halo.clone(); zHalo.uniforms.L.value.copy(zMat.uniforms.L.value);
  zScene.add(new THREE.Mesh(new THREE.SphereGeometry(1.045, 96, 48), zHalo));
  // the Moon beside the Earth for "Rehearse here. Land there." (drawn larger and closer than true scale so both fit)
  const kRight = new THREE.Vector3().crossVectors(kN.clone().negate(), new THREE.Vector3(0, 1, 0)).normalize();
  const zMoon = new THREE.Group();
  if (moon) {
    const m = moon.clone(true);
    // own materials: the opening globe fades its (shared) materials to opacity 0 after the descent
    m.traverse(o => { if (o.isMesh) { o.material = o.material.clone(); o.material.transparent = false; o.material.opacity = 1; o.material.depthWrite = true; o.frustumCulled = false; } });
    const bb = new THREE.Box3().setFromObject(m);
    const c = bb.getCenter(new THREE.Vector3()), sz = bb.getSize(new THREE.Vector3()).x;
    m.position.sub(c); zMoon.add(m); zMoon.scale.setScalar(2 * .42 / sz);
  }
  zMoon.position.copy(kRight).multiplyScalar(3.1).addScaledVector(kN, -1.2);
  zScene.add(zMoon);
  const zSun = new THREE.DirectionalLight(0xffffff, 3); zSun.position.copy(zMat.uniforms.L.value).multiplyScalar(10);
  zScene.add(zSun, new THREE.AmbientLight(0xffffff, .04));
  const zoomOut = { scene: zScene, cam: new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 1e-5, 50), n: kN, right: kRight };
  // sharper ground for the zoom-out: NASA Blue Marble Next Generation tiles from GIBS (EPSG:4326, 512 px; a level-z tile
  // spans 288/2^z degrees), stitched into one texture per level and laid over the globe with soft edges and the globe's light
  const bmng = async (z, r0, r1, c0, c1, fadeLo, fadeHi) => {
    const span = 288 / 2 ** z, nc = c1 - c0 + 1, nr = r1 - r0 + 1;
    const cv = document.createElement('canvas'); cv.width = nc * 512; cv.height = nr * 512;
    const g2 = cv.getContext('2d');
    const ok = await Promise.all(Array.from({ length: nc * nr }, (_, i) => new Promise(res => {
      const r = r0 + Math.floor(i / nc), c = c0 + (i % nc), im = new Image();
      im.onload = () => { g2.drawImage(im, (c - c0) * 512, (r - r0) * 512); res(true); };
      im.onerror = () => { missing.push(`bmng/z${z}_${r}_${c}.jpg`); res(false); };
      im.src = `assets/img/earth/bmng/z${z}_${r}_${c}.jpg`;
    })));
    if (!ok.some(Boolean)) return null;
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { map: { value: t }, L: { value: zMat.uniforms.L.value }, fade: { value: 1 } },
      vertexShader: EARTH_VS,
      fragmentShader: `uniform sampler2D map; uniform vec3 L; uniform float fade; varying vec2 vUv; varying vec3 vN; varying vec3 vV;
#include <logdepthbuf_pars_fragment>
void main(){
#include <logdepthbuf_fragment>
  vec3 n = normalize(vN); float d = max(dot(n, L), 0.);
  float rim = pow(1. - max(dot(n, vV), 0.), 3.);
  vec3 col = texture2D(map, vUv).rgb * (d * 1.5 + .015) + vec3(.3, .55, 1.) * rim * (.1 + d) * .6;
  float e = min(min(vUv.x, 1. - vUv.x), min(vUv.y, 1. - vUv.y));
  gl_FragColor = vec4(col, fade * smoothstep(0., .15, e));
#include <tonemapping_fragment>
#include <colorspace_fragment>
}`,
    });
    const lonW = -180 + c0 * span, latN = 90 - r0 * span;
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1.0004, 128, 96, (lonW + 180) * D2R, nc * span * D2R, (90 - latN) * D2R, nr * span * D2R), mat);
    mesh.renderOrder = z;   // the finer level draws on top
    zScene.add(mesh);
    return { mat, fadeLo, fadeHi };
  };
  // 2 km/px over western North America (135-90 W, 63-36 N), 500 m/px around Kohler (121.5-108 W, 56.25-42.75 N);
  // each fades out (km of altitude) once the camera is high enough for the next level to look sharp
  zoomOut.patches = (await Promise.all([bmng(5, 3, 5, 5, 9, 2500, 6000), bmng(7, 15, 20, 26, 31, 500, 1200)])).filter(Boolean);

  /* Earth ground (its own scene, metres) and the Artemis IV inset (its own canvas) */
  const ground = satTex ? buildGround(abRaw, satTex, astro, makeWalker) : null;
  // the Kohler Coulee outro's live fly-up (same terrain and image as the ground, its own scene)
  const flyup = satTex ? buildFlyup(abRaw, satTex) : null;
  const launch = buildLaunch(document.getElementById('sls'), slsBuf, moon);

  const MM = new THREE.Vector3(TILE_C[0], heightTile(TILE_C[0], TILE_C[1]), TILE_C[1]);
  const RC = new THREE.Vector3(-5, 0, -60);
  const G = new THREE.Vector3(0, -R_MOON, 0);
  state = { zoomOut, plate, plateMat, tile, tileMat, globe, globeMats, lroG, astroG, A, WALK_DIR, labels, MM, RC, G, EP, earth, ground, flyup, launch, heightTile, heightPlate, stars, steepPct,
    walkT: 0, walkLast: 0, walkPos: A.clone() };

  document.getElementById('demo-link').href = DEMO_URL;

  /* upload every texture and compile every shader now, behind the loader, so nothing stalls or flashes the first
     time it comes on screen (three.js otherwise does both lazily on first draw) */
  document.getElementById('loader-t').textContent = 'Warming up';
  const warm = (scn, cam) => {
    scn.traverse(o => {
      for (const m of [].concat(o.material || [])) {
        for (const v of Object.values(m)) if (v && v.isTexture) renderer.initTexture(v);
        if (m.uniforms) for (const u of Object.values(m.uniforms)) if (u.value && u.value.isTexture) renderer.initTexture(u.value);
      }
    });
    renderer.compile(scn, cam);
  };
  rewarm = () => {
    warm(scene, camera);
    warm(zScene, zoomOut.cam);
    if (ground) warm(ground.scene, ground.cam);
    if (flyup) warm(flyup.scene, flyup.cam);
    launch.warm();
  };
  rewarm();
  // the three photos shown full screen are decoded here too, not on their first appearance
  await Promise.all([...document.querySelectorAll('#outro img[src], #photo img')].map(im => im.decode().catch(() => {})));
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  if (missing.length) {
    console.warn('Missing textures:', missing);
    const w = document.createElement('div');
    w.textContent = `Missing: ${missing.join(', ')}`;
    w.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:30;font:11px var(--mono, monospace);color:#fc3d21;background:#000c;padding:4px 8px;pointer-events:none';
    document.body.appendChild(w);
  }
  // a reload in the same tab (Cmd+R, or the automatic one after a lost WebGL context) resumes on the same slide
  const resumeAt = readPos();
  if (resumeAt > 0) window.__go(resumeAt);
  posReady = true;
  document.getElementById('loader').classList.add('done');
  setTimeout(() => document.getElementById('loader').remove(), 1400);
}

/* ---------------------------------------------------------------- camera path */
const n3 = (x, y, z) => new THREE.Vector3(x, y, z).normalize();
function keyframes(S) {
  const A = () => new THREE.Vector3(S.walkPos.x, S.heightTile(S.walkPos.x, S.walkPos.z, S.morph) + 0.0012, S.walkPos.z);
  return [
    { u: 0, t: () => S.G, d: n3(.35, -.12, 1), r: 6400 },
    { u: B.open.e, t: () => new THREE.Vector3(10, -140, -30), d: n3(.25, .8, .55), r: 1500 },
    { u: B.descent.s + .9, t: () => S.MM, d: n3(.2, .86, .45), r: 240 },
    { u: B.descent.e, t: () => S.MM, d: n3(-.55, .30, .78), r: 27 },
    { u: B.photo.e, t: () => S.MM, d: n3(-.62, .27, .74), r: 24 },
    { u: B.athena.e, t: () => S.MM, d: n3(.82, .17, .55), r: 18 },
    { u: B.lowsun.e, t: () => S.MM, d: n3(.86, .15, .49), r: 15 },
    { u: B.money.e, t: () => S.MM, d: n3(.9, .13, .42), r: 13.5 },
    { u: B.tally.e, t: () => S.MM, d: n3(.9, .13, .42), r: 13.5 },   // hold through the tally, then
    { u: B.people.s + .02, t: A, d: n3(.45, .10, 1), r: 0.016, o: .004 },   // hard cut to the astronaut under the dip to black
    { u: at('people', .34), t: A, d: n3(.55, .12, 1), r: 0.016, o: .004 },
    { u: at('people', .46), t: A, d: n3(.55, .12, 1), r: 0.016, o: .004, ly: 38 },   // look up: the next crew comes from up there
    { u: at('people', .93), t: A, d: n3(.58, .13, 1), r: 0.016, o: .004, ly: 40 },   // same distance: the camera only pans up
    { u: at('regions', .35), t: () => S.RC, d: n3(0, 1, .32), r: 600 },   // one slow rise from the launch to the region overview
    { u: B.regions.e, t: () => S.RC, d: n3(.05, 1, .36), r: 560 },
    // hard cut to the astronaut, hidden under the dip to black: no zoom, sun swing or tile swap on screen
    { u: B.turn.s, t: A, d: n3(-.32, .12, 1), r: 0.009 },
    { u: B.turn.e, t: A, d: n3(-.4, .14, 1), r: 0.009 },   // hold on the astronaut: no pull-back before the Earth
    { u: TOTAL, t: A, d: n3(-.4, .14, 1), r: 0.009 },   // after this the Earth ground scene takes over
  ];
}
function camAt(u, K) {
  let i = 0; while (i < K.length - 2 && u > K[i + 1].u) i++;
  const a = K[i], b = K[i + 1]; const t = ease(clamp((u - a.u) / (b.u - a.u)));
  const tgt = a.t().clone().lerp(b.t(), t);
  const dir = a.d.clone().lerp(b.d, t).normalize();
  const r = Math.exp(lerp(Math.log(a.r), Math.log(b.r), t));
  const o = lerp(a.o || 0, b.o || 0, t);
  if (o) { const right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize(); tgt.addScaledVector(right, o); }
  const pos = tgt.clone().addScaledVector(dir, r);
  // optional look-up (degrees): pitch the view up about the camera's own right axis
  const ly = lerp(a.ly || 0, b.ly || 0, t) * D2R;
  if (ly) {
    const f = tgt.clone().sub(pos), right = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0)).normalize();
    tgt.copy(pos).add(f.applyAxisAngle(right, ly));
  }
  return { tgt, pos, r };
}

/* ---------------------------------------------------------------- sun per beat */
function sunAt(u) {
  // returns elevation (deg), azimuth (deg from north, clockwise)
  const k = [
    [0, 4, 72], [B.open.e - .3, 6, 100], [B.descent.s, 8, 120], [B.descent.e, 5, 128], [B.athena.e, 4, 132], [B.lowsun.s + .5, 1.4, 136],
    [B.money.e, 1.4, 136], [B.tally.e, 1.4, 136], [B.people.s + .02, 4.5, 250], [B.people.e, 4.5, 250], [B.regions.s + .9, 1.6, 140],
    [B.regions.e, 1.6, 140], [B.turn.s, 4.5, 250],
    [TOTAL, 4.5, 250],
  ];
  let i = 0; while (i < k.length - 2 && u > k[i + 1][0]) i++;
  const [ua, ea, aa] = k[i], [ub, eb, ab] = k[i + 1]; const t = sstep(ua, ub, u);
  return [lerp(ea, eb, t), lerp(aa, ab, t)];
}

/* ---------------------------------------------------------------- scroll */
const lenis = new Lenis({ lerp: 0.075, smoothWheel: true, wheelMultiplier: 0.8 });
const scrollEl = document.getElementById('scroll');
const setH = () => { scrollEl.style.height = `${TOTAL * 100 + 100}vh`; };
setH();
const uNow = () => (lenis.limit > 0 ? lenis.scroll / lenis.limit : 0) * TOTAL;

// one click per caption, plus money, tally, and a stop on the Artemis IV launch (no caption of their own)
const anchors = [0, ...CAPS.map(c => B[c.beat].s + B[c.beat].l * Math.min(.98, c.a + Math.min(.4, (c.b - c.a) * .55))),
  at('money', .55), at('tally', .62), at('people', .7), at('gaps', .5)].sort((a, b) => a - b);
// gaps and next steps, after the live demo (text from the team's pipeline_frame.json)
fetch('assets/data/pipeline_frame.json').then(r => r.json()).then(P => {
  // items are {t: title, d: detail} (plain strings still work)
  const item = (x, i) => typeof x === 'string'
    ? `<li><span class="pn">${String(i + 1).padStart(2, '0')}</span><span class="pt">${x}</span></li>`
    : `<li><span class="pn">${String(i + 1).padStart(2, '0')}</span><span class="pt">${x.t}</span><span class="pd">${x.d}</span></li>`;
  const col = (k, label, cls) => `<div class="pcol ${cls}"><h3>${label}</h3><ul>${(P[k] || []).map(item).join('')}</ul></div>`;
  document.getElementById('pipe-in').innerHTML =
    `<header class="phead"><div class="pkick">Rehearse here · what’s next</div><h2>Honest about the gaps.<br><em>Clear</em> on what’s next.</h2></header>`
    + col('gaps', 'What we haven’t solved', 'gap') + col('next', 'What we do next', 'next');
}).catch(() => {});
const goto = dir => {
  const u = uNow(); const list = dir > 0 ? anchors.filter(a => a > u + 0.03) : anchors.filter(a => a < u - 0.03).reverse();
  if (!list.length) return;
  // presenter mode: one steady speed (about 3.2 s per beat unit), never under 3 s, never a rapid jump
  const dist = Math.abs(list[0] - u);
  lenis.scrollTo((list[0] / TOTAL) * lenis.limit, { duration: clamp(dist * 3.2, 3, 8) / speed, easing: t => .5 - .5 * Math.cos(Math.PI * t) });
};
window.__go = u => lenis.scrollTo((u / TOTAL) * lenis.limit, { immediate: true });
window.__B = B;

// presenter speed (1×, 1.5×, 2×): scales click durations and the wheel; remembered per browser
const SPEEDS = [1, 1.5, 2];
let speed = 1;
const speedBtns = [...document.querySelectorAll('#speed button')];
const setSpeed = s => {
  if (!SPEEDS.includes(s)) return;
  speed = s;
  // Lenis copies wheelMultiplier into its VirtualScroll at construction, so set it there too (that copy is the one read per wheel event)
  lenis.options.wheelMultiplier = 0.8 * s;
  if (lenis.virtualScroll?.options) lenis.virtualScroll.options.wheelMultiplier = 0.8 * s;
  speedBtns.forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.speed === s)));
  try { localStorage.setItem('pitch-speed', String(s)); } catch (_) {}
};
try { setSpeed(+localStorage.getItem('pitch-speed') || 1); } catch (_) { setSpeed(1); }
speedBtns.forEach(b => b.addEventListener('click', () => { setSpeed(+b.dataset.speed); b.blur(); }));

addEventListener('keydown', e => {
  if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); goto(1); }
  if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) { e.preventDefault(); goto(-1); }
  if (e.key === 'Home') { e.preventDefault(); window.__go(0); }
  if (!e.ctrlKey && !e.metaKey && !e.altKey && ['1', '2', '3'].includes(e.key)) setSpeed(SPEEDS[+e.key - 1]);
});
addEventListener('click', e => { if (!e.target.closest('a, button')) goto(1); });
/* Screen changes (plugging in a projector, mirroring, moving the window to another display): one debounced resize
   that keeps the presenter on the same slide (the scroll height depends on the window height) and re-applies the
   pixel budget, including when only the pixel density changes. */
let resizeT = 0;
const onResize = () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => {
    const u = uNow();
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
    renderer.setPixelRatio(pixelRatio()); renderer.setSize(innerWidth, innerHeight);
    setH();
    if (typeof lenis.resize === 'function') lenis.resize();
    window.__go(u);
    requestAnimationFrame(() => window.__go(u));
  }, 120);
};
addEventListener('resize', onResize);
const watchDpr = () => matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', () => { onResize(); watchDpr(); }, { once: true });
watchDpr();

/* Lost WebGL context: a display reconfiguration (HDMI plugged in, GPU reset) can make the browser drop the 3D
   context, which freezes or blanks the 3D while the captions carry on. three.js restores it if the browser hands
   it back; if that hasn't happened within 2.5 s, reload onto the same slide (at most 3 times a minute). */
const glNote = document.createElement('div');
glNote.textContent = 'Reconnecting graphics…';
glNote.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:40;font:11px var(--mono, monospace);letter-spacing:.08em;text-transform:uppercase;color:#9a968e;background:#000c;padding:6px 10px;border-radius:4px;opacity:0;transition:opacity .3s;pointer-events:none';
document.body.appendChild(glNote);
let lostT = 0;
const onLost = () => {
  savePos();
  glNote.style.opacity = 1;
  clearTimeout(lostT);
  lostT = setTimeout(() => { if (reloadAllowed()) location.reload(); else glNote.textContent = 'Graphics lost: press Cmd+R to resume'; }, 2500);
};
const onRestored = () => { clearTimeout(lostT); glNote.style.opacity = 0; if (rewarm) rewarm(); };
for (const c of [canvas, document.getElementById('sls')]) {
  if (!c) continue;
  c.addEventListener('webglcontextlost', onLost);
  c.addEventListener('webglcontextrestored', onRestored);
}

/* Where the presenter is, kept for this tab only: a reload resumes there, a fresh tab starts at the top. */
function savePos() {
  if (!posReady) return;   // still loading: keep the saved slide for init() to resume
  try { sessionStorage.setItem('pitch-u', String(uNow())); } catch { /* storage blocked: no resume */ }
}
function readPos() { try { const v = parseFloat(sessionStorage.getItem('pitch-u') || ''); return Number.isFinite(v) ? v : 0; } catch { return 0; } }
function reloadAllowed() {
  try {
    const now = Date.now(), recent = JSON.parse(sessionStorage.getItem('pitch-reloads') || '[]').filter(t => now - t < 60000);
    if (recent.length >= 3) return false;
    sessionStorage.setItem('pitch-reloads', JSON.stringify([...recent, now]));
    return true;
  } catch { return false; }
}
setInterval(savePos, 500);
addEventListener('pagehide', savePos);

/* ---------------------------------------------------------------- DOM refs */
const $ = id => document.getElementById(id);
const photo = $('photo'), photoInner = $('photo-inner'), rings = [...document.querySelectorAll('.ring')];
const money = $('money'), moneyNum = $('money-num'), moneyLine = $('money-line'), moneySrc = $('money-src');
const pin = $('athena-pin'), flash = $('flash'), dip = $('dip'), launchEl = $('launch');
const gauge = $('gauge'), gNeedle = $('g-needle'), gVal = $('g-val'), gOk = $('g-ok'), gBad = $('g-bad');
const tally = $('tally'), outro = $('outro'), oMoonCard = $('o-mooncard'), oReal = $('o-real'), oPull = $('o-pull');
// the live fly-up (kohler_flyup.js) ends straight down over Kohler Coulee at this altitude (km); the close's
// zoom-out starts from it
const FLY_TOP_KM = 10;   // keep equal to FLYUP_TOP_ALT / 1000 in kohler_flyup.js
// o-snap: a copy of the fly-up's last frame, taken from the WebGL canvas the moment it is drawn (so it is exactly the
// frame the close starts from); in the close it shrinks with the altitude over the globe. snapKey = canvas size it
// was taken at (retaken after a resize). o-pull (pull_23, a still from 20 km) is only the fallback without the fly-up.
const oSnap = $('o-snap'), snapCtx = oSnap.getContext('2d');
let snapKey = '';
const hud2 = $('hud-l2'), hud3 = $('hud-l3'), railFill = $('rail-fill'), hint = $('hint'), handoff = $('handoff'), credits = $('credits'), speedEl = $('speed');

function arc(a0, a1) { // degrees 0..25 mapped to 180..0 on the gauge
  const p = d => { const th = Math.PI * (1 - d / 25); return [160 + 140 * Math.cos(th), 160 - 140 * Math.sin(th)]; };
  const [x0, y0] = p(a0), [x1, y1] = p(a1); return `M${x0.toFixed(1)} ${y0.toFixed(1)} A140 140 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
}
gOk.setAttribute('d', arc(0, 8));

function placePhoto(fx, fy, s) {
  const W = photoInner.offsetWidth, H = photoInner.offsetHeight;
  photoInner.style.transform = `translate(${-fx * W * s}px, ${-fy * H * s}px) scale(${s})`;
}
const EARTH = [862 / 1536, 92 / 806];

const project = (p, el) => {
  _v.copy(p).project(camera);
  el.style.left = `${(_v.x * .5 + .5) * innerWidth}px`; el.style.top = `${(-_v.y * .5 + .5) * innerHeight}px`;
  return _v.z < 1 && Math.abs(_v.x) < 1.2 && Math.abs(_v.y) < 1.2;
};

/* ---------------------------------------------------------------- frame */
const _v = new THREE.Vector3();
function frame(time) {
  lenis.raf(time);
  requestAnimationFrame(frame);
  update(time);
}
let uForce = null;
window.__shot = u => { uForce = u; __go(u); update(performance.now()); return u; };
function update(time) {
  if (!state) return;
  window.__S = state; window.__sun = sun;
  const S = state; const u = uForce ?? uNow();
  S.K = S.K || keyframes(S);

  /* the Moon tile no longer morphs; Earth is its own scene after the zoom */
  const morph = 0;
  S.morph = morph;
  const ea = local(u, 'earth');
  const onGround = S.ground && u >= at('earth', .62);

  /* astronaut walk clock: runs while he is on screen, restarts when he is off */
  const showA = (u > B.people.s - .1 && u < at('people', .95)) || (u > B.slope.e - .2 && !onGround);
  const dt = Math.min(.05, Math.max(0, (time - S.walkLast) / 1000)); S.walkLast = time;
  S.walkT = (showA || onGround) ? S.walkT + dt : 0;
  if (onGround !== S.wasGround) { S.walkT = 0; S.wasGround = onGround; }
  const walked = Math.min(S.walkT * 0.0007, 0.03);                 // km on the Moon (0.7 m/s, at most 30 m)
  const striding = onGround ? (S.walkT * .7 < 14 ? 1 : 0) : (S.walkT * 0.0007 < 0.03 ? 1 : 0);
  S.walkPos.set(S.A.x + S.WALK_DIR.x * walked, 0, S.A.z + S.WALK_DIR.y * walked);
  const wph = S.walkT * Math.PI * 2 * .85;
  walkU.wPh.value = wph; walkU.wSw.value = lerp(walkU.wSw.value, striding, .08);

  /* camera */
  const c = camAt(u, S.K);
  camera.position.copy(c.pos);
  // Earth beat: look up from the astronaut to the Earth, then zoom the lens all the way in
  const lookE = inBeat(u, 'earth') ? ease(sstep(.02, .3, ea)) : 0;
  const look = c.tgt.clone();
  if (lookE > 0) {
    const toE = S.EP.clone().sub(c.pos).normalize(), toT = c.tgt.clone().sub(c.pos).normalize();
    look.copy(c.pos).add(toT.lerp(toE, lookE).normalize());
  }
  camera.lookAt(look);
  const fov = inBeat(u, 'earth') ? Math.exp(lerp(Math.log(42), Math.log(1.7), ease(sstep(.3, .62, ea)))) : 42;
  if (Math.abs(camera.fov - fov) > 1e-4) { camera.fov = fov; camera.updateProjectionMatrix(); }
  // gentle handheld drift (scaled down with the zoom so the Earth stays put)
  const tt = time * 0.0001; camera.rotation.z += Math.sin(tt * 2.1) * 0.002 * (fov / 42);

  /* sun */
  const [el, az] = sunAt(u);
  const sd = new THREE.Vector3(Math.cos(el * D2R) * Math.sin(az * D2R), Math.sin(el * D2R), -Math.cos(el * D2R) * Math.cos(az * D2R));
  sun.position.copy(c.tgt).addScaledVector(sd, 50); sun.target.position.copy(c.tgt);
  const warm = new THREE.Color(1, 1, 1).lerp(new THREE.Color(1, .82, .62), morph);
  sun.color.copy(warm); sun.intensity = 3.2 + morph;
  hemi.intensity = morph * 1.2; amb.intensity = 0.03 + morph * .15;

  /* globe vs plate vs tile */
  const gOp = 1 - sstep(B.open.e - .4, B.descent.s + .5, u);
  S.globe.visible = gOp > 0.001;
  for (const m of S.globeMats) { m.opacity = gOp; m.depthWrite = gOp > .99; }
  const pOp = sstep(B.open.e - .55, B.descent.s + .35, u);
  S.plate.visible = pOp > 0.001 && morph < 0.05;
  const tileOn = c.r < 320 && !(inBeat(u, 'regions') && c.r > 200);
  S.tile.visible = tileOn;
  S.earth.visible = u > B.turn.e - .05 && !onGround;

  for (const M of [S.plateMat, S.tileMat]) {
    const U = M.uniforms;
    U.sunDir.value.copy(sd); U.tanEl.value = Math.tan(Math.max(el, .2) * D2R);
    U.sunH.value.set(Math.sin(az * D2R), Math.cos(az * D2R));
    U.sunCol.value.copy(warm).multiplyScalar(1.15);
    U.camPos.value.copy(camera.position);
    U.morph.value = M === S.tileMat ? morph : 0;
    U.haze.value = 0.06;
    U.slopeMode.value = sstep(.1, .22, local(u, 'slope')) * (1 - sstep(.9, 1, local(u, 'slope'))) * (inBeat(u, 'slope') ? 1 : 0);
    U.sweep.value = lerp(TILE_C[0] - 7.6, TILE_C[0] + 7.7, sstep(.2, .6, local(u, 'slope')));
  }
  const TU0 = S.tileMat.uniforms;
  TU0.detail.value = 1 - sstep(.04, .6, c.r); TU0.dO.value.set(S.A.x, S.A.z);
  TU0.fpP0.value.set(S.A.x, S.A.z); TU0.fpDir.value.copy(S.WALK_DIR); TU0.fpLen.value = walked;
  S.plateMat.uniforms.alpha.value = 1;
  S.plateMat.uniforms.reveal.value = lerp(0, 400, sstep(B.open.e - .55, B.descent.s + .6, u));
  S.plateMat.uniforms.hideTile.value = tileOn ? 1 : 0;
  S.plateMat.uniforms.edgeDark.value = u > B.people.s ? 1 : 0;

  /* region boxes draw one by one, then Athena's box fills */
  const rg = local(u, 'regions');
  S.plateMat.uniforms.boxesOn.value = inBeat(u, 'regions') ? 1 - sstep(.95, 1, rg) : 0;
  // boxes start once the camera has finished rising (regions .35); boxes, fill and pin are all done before the click stop (.72)
  S.plateMat.uniforms.boxOp.value = REGIONS.map((_, i) => sstep(.36 + i * .025, .42 + i * .025, rg));
  S.plateMat.uniforms.hotFill.value = sstep(.6, .68, rg) * (.75 + .25 * Math.sin(time * .006));
  // darken the scene under overlays
  const mtL = clamp((u - B.money.s) / (B.tally.e - B.money.s));   // money + lander tally share one dimmed stretch
  const dimMoney = u >= B.money.s && u <= B.tally.e ? 1 - .72 * sstep(0, .08, mtL) * (1 - sstep(.95, 1, mtL)) : 1;
  const dimHand = 1;
  S.tileMat.uniforms.bright.value = S.plateMat.uniforms.bright.value = dimMoney * dimHand;

  /* split view: reference map vs landing light */
  const ls = local(u, 'lowsun');
  const splitT = inBeat(u, 'lowsun') ? sstep(.45, .62, ls) * (1 - sstep(.95, 1, ls)) : 0;
  const splitX = splitT * innerWidth * .5;
  S.tileMat.uniforms.split.value = splitT > 0.001 ? splitX * renderer.getPixelRatio() : -1;
  splitUI.style.opacity = splitT > .02 ? 1 : 0; splitUI.style.left = `${splitX}px`;

  /* astronaut: feet on the ground (no sinking), small bob while striding */
  S.astroG.visible = showA;
  const ay = S.heightTile(S.walkPos.x, S.walkPos.z, morph) + Math.abs(Math.sin(wph)) * 0.00004 * walkU.wSw.value;
  S.astroG.position.set(S.walkPos.x, ay, S.walkPos.z);
  S.astroG.rotation.y = Math.atan2(S.WALK_DIR.x, -S.WALK_DIR.y);
  S.tileMat.uniforms.astro.value.set(S.walkPos.x, ay, S.walkPos.z); S.tileMat.uniforms.astroOn.value = showA ? 1 : 0;

  /* LRO pass */
  const lo = local(u, 'open');
  S.lroG.visible = u < B.open.e;
  S.lroG.position.set(lerp(1.4, -1.6, lo), lerp(-.25, .35, lo), -2.4);
  S.lroG.rotation.set(.4 + lo * .6, lo * 1.8, .2);

  /* stars + sky */
  S.stars.material.uniforms.op.value = 1 - morph;
  sky.material.uniforms.k.value = morph; sky.visible = morph > 0.001;

  /* photo overlay */
  const ph = local(u, 'photo'), atl = local(u, 'athena'), cl = local(u, 'close');
  let pOpac = 0;
  if (inBeat(u, 'photo') || inBeat(u, 'athena')) {
    pOpac = u < B.athena.s ? sstep(0, .12, ph) : 1 - sstep(.55, .95, atl);
    const z = ease(sstep(.05, .55, ph));
    const s = Math.exp(lerp(Math.log(4.2), 0, z));
    placePhoto(lerp(EARTH[0], .5, z), lerp(EARTH[1], .5, z), s);
    const ring = sstep(.62, .78, ph);
    rings.forEach((r, i) => r.style.strokeDashoffset = 280 * (1 - clamp(ring * 1.3 - i * .3)));
    photoInner.style.filter = '';
  } else if (false) {   // old close (zoom to Earth in the photo) replaced by the Kohler outro
    pOpac = sstep(0, .2, cl);
    const z = ease(sstep(.15, .95, cl));
    const s = Math.exp(lerp(0, Math.log(4.5), z));
    placePhoto(lerp(.5, EARTH[0], z), lerp(.5, EARTH[1], z), s);
    rings.forEach(r => r.style.strokeDashoffset = 280);
    photoInner.style.filter = `blur(${(z * .6).toFixed(2)}px)`;
  }
  photo.style.opacity = pOpac;

  /* money */
  const mo = local(u, 'money');
  const mOp = inBeat(u, 'money') ? sstep(0, .12, mo) * (1 - sstep(.9, 1, mo)) : 0;
  money.style.opacity = mOp;
  if (mOp > 0) {
    // $138 million: 95% of NASA's $145M for IM-2, since Athena worked about 12 of 240 planned hours
    const v = Math.round(138 * ease(sstep(.06, .36, mo)));
    moneyNum.textContent = `$${v} million`;
    moneyNum.style.transform = `scale(${lerp(1.06, 1, sstep(.3, .42, mo)).toFixed(3)})`;
    moneyLine.style.opacity = sstep(.36, .46, mo);
    moneySrc.style.opacity = sstep(.46, .56, mo);
  }

  /* Athena crosshair inside its region box */
  let pinOp = inBeat(u, 'regions') ? sstep(.62, .7, rg) * (1 - sstep(.86, .92, rg)) : 0;
  if (pinOp > 0) pinOp *= project(new THREE.Vector3(ATH[0], S.heightPlate(ATH[0], ATH[1]) + .3, ATH[1]), pin) ? 1 : 0;
  pin.style.opacity = pinOp;

  /* Artemis IV launch inset */
  const pl = local(u, 'people');
  const lOp = inBeat(u, 'people') ? sstep(.42, .48, pl) * (1 - sstep(.94, .975, pl)) : 0;
  launchEl.style.opacity = lOp;
  if (lOp > 0) S.launch.render(clamp((pl - .48) / .44));

  /* dips to black (the camera cuts while it is dark): tally -> astronaut, region overview -> astronaut */
  const dipAt = (outS, outE, inS) => sstep(outS, outE, u) * (1 - sstep(inS, inS + .22, u));
  dip.style.opacity = Math.max(dipAt(at('tally', .86), B.tally.e, B.people.s + .02), dipAt(at('regions', .86), B.regions.e, B.turn.s));

  /* white-out between the Earth zoom and the ground */
  flash.style.opacity = inBeat(u, 'earth') ? sstep(.5, .615, ea) * (1 - sstep(.625, .74, ea)) : 0;

  /* gauge */
  const sl = local(u, 'slope');
  const gOpac = inBeat(u, 'slope') ? sstep(.15, .3, sl) * (1 - sstep(.92, 1, sl)) : 0;
  gauge.style.opacity = 0;   // slope view cut from the clicked version
  if (gOpac > 0) {
    const deg = 20 * ease(sstep(.3, .7, sl));
    const th = Math.PI * (1 - deg / 25);
    gNeedle.setAttribute('x2', (160 + 120 * Math.cos(th)).toFixed(1)); gNeedle.setAttribute('y2', (160 - 120 * Math.sin(th)).toFixed(1));
    gVal.textContent = `${deg.toFixed(0)}°`; gVal.style.fill = deg > 8 ? '#fc3d21' : '#f2efe9';
    gBad.setAttribute('d', deg > 8 ? arc(8, deg) : '');
  }

  /* region labels */
  const labOn = inBeat(u, 'regions');
  for (const L of S.labels) {
    // labels draw with their boxes, the others dim as Athena's box fills, all gone before the dip
    const op = labOn ? sstep(.36 + L.i * .025, .42 + L.i * .025, rg) * (1 - sstep(.86, .92, rg)) * (L.i === HOT ? 1 : 1 - .6 * sstep(.6, .68, rg)) : 0;
    L.el.style.opacity = op > 0 && project(L.p, L.el) ? op : 0;
  }

  /* lander tally */
  const ta = local(u, 'tally');
  tally.style.opacity = inBeat(u, 'tally') ? sstep(0, .12, ta) * (1 - sstep(.9, 1, ta)) : 0;
  tally.querySelectorAll('.lander').forEach((el, i) => el.classList.toggle('on', ta > .14 + i * .03));
  tally.querySelector('.t-line').style.opacity = sstep(.55, .65, ta);


  /* outro: Kohler Coulee as the Moon, then real colours, then a live 3D fly-up to the map view */
  const ou = local(u, 'outro');
  const oOp = u >= B.outro.s ? sstep(0, .05, ou) : 0;
  outro.style.opacity = oOp;
  const inClose = u >= B.close.s;
  // the whole outro is one live scene and one camera: Kohler drawn as the Moon, the same frame turning into real
  // colours ("Gotcha"), then the fly-up from ou .64. It starts once the black dip from the hand-off is complete (ou .03).
  const flyOn = !!S.flyup && u >= B.outro.s && ou >= .03 && !inClose;
  const oLook = sstep(.32, .42, ou);   // 0 = Moon, 1 = real colours (the old real-colour still used the same timing)
  // linear: buildFlyup's update() eases both ends of the move itself
  const flyT = inClose ? 1 : clamp((ou - .64) / .36);
  // closing zoom-out: altitude (km) over Kohler Coulee, from the top of the fly-up to the whole Earth (the fly-up
  // eases to a stop and this eases off from rest, so the hand-off has no jolt)
  // (^.6: rise quickly through the low altitudes where the Blue Marble is soft, slow down near the whole Earth)
  const h0 = S.flyup ? FLY_TOP_KM : 20;
  const zoomH = inClose ? Math.exp(lerp(Math.log(h0), Math.log(22000), Math.pow(sstep(0, .6, cl), .6))) : 0;
  if (oOp > 0) {
    const live = flyOn || inClose;   // the 3D canvas shows through the outro
    if (S.flyup) {
      // live scene: of the old Moon card only the Apollo 8 Earth stays (over the black sky), fading as the colours come in
      oMoonCard.classList.add('live');
      // gone before the sky leaves black (the photo's own black surround would show against a lighter sky)
      oMoonCard.style.opacity = inClose ? 0 : 1 - sstep(.30, .345, ou);
      oReal.style.opacity = 0;
      // dip to black from the hand-off, then the black lifts off the live Moon view
      outro.style.background = inClose ? 'transparent' : ou < .03 ? '' : `rgba(0,0,0,${(1 - sstep(.03, .09, ou)).toFixed(3)})`;
    } else {
      oMoonCard.style.opacity = live ? 0 : 1;
      oReal.style.opacity = inClose ? 0 : sstep(.32, .42, ou);
      outro.style.background = live ? 'transparent' : '';
    }
    // in the close, the straight-down still (the fly-up's last frame, else pull_23) is scaled by its altitude, starting
    // at 1 (the exact frame on screen when the close begins), then shrinks with the zoom-out and fades into the globe
    const still = S.flyup ? oSnap : oPull, other = S.flyup ? oPull : oSnap;
    const s = inClose ? h0 / zoomH : 1;
    // soft edges grow in as it shrinks: full frame for s >= 1, a soft oval (no hard rectangle edges) by s = .4
    const me = sstep(.4, 1, s);
    const mask = inClose ? `radial-gradient(ellipse ${lerp(50, 72, me).toFixed(1)}% ${lerp(50, 72, me).toFixed(1)}% at 50% 50%, #000 ${lerp(30, 100, me).toFixed(1)}%, transparent 100%)` : '';
    still.style.maskImage = still.style.webkitMaskImage = mask;
    still.style.transform = `scale(${s.toFixed(4)})`;
    still.style.opacity = inClose ? sstep(.06, .3, s) : 0;
    other.style.opacity = 0;
  }

  /* captions */
  for (const C of CAPS) {
    const t = local(u, C.beat);
    const on = inBeat(u, C.beat) && t >= C.a - .02 && t <= C.b + .02;
    if (!on) { if (C.el.style.opacity !== '0') C.el.style.opacity = 0; continue; }
    const rin = clamp((t - C.a) / .14), rout = clamp((C.b - t) / .07);
    C.el.style.opacity = 1;
    C.words.forEach((w, i) => {
      const k = clamp(rin * 1.6 - i * .12) * rout;
      w.style.opacity = k; w.style.transform = `translateY(${(1 - k) * 0.5}em)`; w.style.filter = `blur(${((1 - k) * 8).toFixed(1)}px)`;
    });
    if (C.srcEl) C.srcEl.style.opacity = clamp(rin * 1.2 - .4) * rout;
  }

  /* gaps and next steps */
  const gp = local(u, 'gaps');
  $('pipe').style.opacity = inBeat(u, 'gaps') ? sstep(0, .12, gp) * (1 - sstep(.88, 1, gp)) : 0;

  /* handoff */
  const ho = local(u, 'handoff');
  const hOp = inBeat(u, 'handoff') ? sstep(.25, .45, ho) * (1 - sstep(.9, 1, ho)) : 0;
  handoff.style.opacity = hOp; handoff.style.pointerEvents = hOp > .5 ? 'auto' : 'none';
  credits.style.opacity = inBeat(u, 'close') ? sstep(.86, .95, cl) : 0;
  // the speed control shares the bottom-left corner with the credits, so it steps aside before they fade in
  const spOp = inBeat(u, 'close') ? 1 - sstep(.6, .72, cl) : 1;
  speedEl.style.opacity = spOp; speedEl.style.visibility = spOp < .02 ? 'hidden' : 'visible';

  /* HUD */
  hud2.textContent = `Sun el ${el.toFixed(1)}° · az ${az.toFixed(0)}°`;
  const alt = c.r;
  const zoomed = inBeat(u, 'earth') && ea > .3 && !onGround;
  hud3.textContent = onGround ? 'Earth · on foot' : zoomed ? `Lens ${fov.toFixed(1)}° · Earth` : `Range ${alt >= 1 ? alt.toFixed(alt > 100 ? 0 : 1) + ' km' : (alt * 1000).toFixed(alt < .1 ? 1 : 0) + ' m'}`;
  $('hud-l1').textContent = onGround ? 'NASA HLS · Copernicus GLO-30 · Earth' : 'LOLA 20 m · PGDA · Moon';
  if (onGround) hud2.textContent = 'Sun el 13.0° · az 230°';
  railFill.style.height = `${(u / TOTAL) * 100}%`;
  hint.style.opacity = u < .15 ? 1 : 0;
  $('hud').style.opacity = u >= B.gaps.s ? 0 : 1;   // the readout would give away the Kohler reveal

  if (flyOn) {
    // Kohler Coulee: the Moon look, real colours, then the fly-up rising to straight down at FLY_TOP_KM
    S.flyup.update(flyT, camera.aspect, oLook);
    renderer.render(S.flyup.scene, S.flyup.cam);
  } else if (zoomH > 0) {
    if (S.flyup) {
      // copy the fly-up's top view into o-snap (drawImage in the same task as the render, so the WebGL buffer is
      // still there); once per canvas size, then the globe is drawn over it as usual
      const cv = renderer.domElement, key = `${cv.width}x${cv.height}`;
      if (key !== snapKey) {
        S.flyup.update(1, camera.aspect, 1);
        renderer.render(S.flyup.scene, S.flyup.cam);
        oSnap.width = cv.width; oSnap.height = cv.height;
        snapCtx.drawImage(cv, 0, 0);
        snapKey = key;
      }
    }
    // closing zoom-out over the Blue Marble, Kohler Coulee kept in the centre (the Moon and ground are not drawn)
    const Z = S.zoomOut;
    if (Z.cam.aspect !== camera.aspect) { Z.cam.aspect = camera.aspect; Z.cam.updateProjectionMatrix(); }
    // after the whole Earth, pull back and slide right until the Moon is in frame too
    const mv = sstep(.6, .82, cl), side = Z.right.clone().multiplyScalar(1.5 * mv);
    Z.cam.position.copy(Z.n).multiplyScalar(lerp(1 + zoomH / 6371, 6.8, mv)).add(side); Z.cam.lookAt(side);
    for (const p of Z.patches) p.mat.uniforms.fade.value = 1 - sstep(p.fadeLo, p.fadeHi, zoomH);
    renderer.render(Z.scene, Z.cam);
  } else if (oOp > .999) {
    // the outro stills cover the whole screen (ou < .64): skip the 3D render (it was drawing the grass ground underneath)
  } else if (onGround) {
    // Earth ground: astronaut keeps walking; camera pulls back and the scene dims under "Let us show you"
    const G = S.ground;
    G.update(Math.min(S.walkT * .7, 14), sstep(B.handoff.s, B.close.e, u), camera.aspect);
    renderer.toneMappingExposure = 1.05 * (1 - .5 * sstep(B.earth.e, B.handoff.s + .3, u));
    renderer.render(G.scene, G.cam);
    renderer.toneMappingExposure = 1.05;
  } else {
    renderer.render(scene, camera);
  }
}

init().catch(err => { document.getElementById('loader-t').textContent = 'Signal lost: ' + err.message; console.error(err); });
requestAnimationFrame(frame);
