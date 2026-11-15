import * as THREE from 'three';

/* Kohler Coulee outro, one live scene: the same terrain shown first as the Moon, then in its real colours, then a
   continuous fly-up to a straight-down map view. Same terrain and image as earth_ground.js (Copernicus GLO-30, 30 m,
   x1.5; NASA HLS 9 Oct 2025, same UVs). Units: metres; +X east, -Z north (row 0 of the heights / top of the image).

   buildFlyup(raw, satTex) -> { scene, cam, update }
   update(t, aspect, look = 1): t in [0, 1] = progress of the fly-up (camera only);
                                look 0 = Moon (grey regolith, black sky, hard grazing sun), 1 = real colours.
   t = 1 looks straight down, north up, from FLYUP_TOP_ALT above the terrain's mean height, centred on the tile. */
const N = 500, D = 30.06, EX = 1.5, HALF = (N - 1) * D / 2;
export const FLYUP_TOP_ALT = 10000;                    // metres above the terrain's mean height at t = 1 (fits aspect <= 2)
const SAT_PX = 1000;                                   // the HLS image is 1000 x 1000 px over the tile
const PAD = 70, PAD_GROW = 1.08;                       // apron beyond the tile: 70 rings growing 8% each (~80 km)

// suns: grid-aligned azimuths so the cast shadows can be swept exactly (az: compass bearing of the sun, el: elevation)
const SUN_REAL = { az: 225, el: 13, dc: -1, dr: 1 };   // low afternoon sun from the south-west (the ground scene's ~230)
const SUN_MOON = { az: 225, el: 5, dc: -1, dr: 1 };    // grazing sun, same bearing: the shadows just lengthen
// real-look sky, after the pre-rendered still it replaces: pale near the horizon, soft blue above
const SKY_H = [.725, .808, .78], SKY_Z = [.24, .37, .59];

// opening view: 40 m up in a coulee south-east of the middle, looking north-north-west along it: a big rounded hill
// on the right, the valley running away on the left, the horizon ~40% from the top (yaw: radians, + = east of north)
const START = { r: 420, c: 320, above: 40, yaw: -0.28, pitch: -0.4 };

// eased progress with cosine ramps at both ends and a constant-speed middle (peak speed 1/(1-a): the middle isn't rushed)
function ease(t, a) {
  if (t <= 0) return 0; if (t >= 1) return 1;
  const v = 1 / (1 - a);
  if (t < a) return v * (t / 2 - a / (2 * Math.PI) * Math.sin(Math.PI * t / a));
  if (t > 1 - a) return 1 - ease(1 - t, a);
  return v * (a / 2 + t - a);
}
const lerp = (a, b, k) => a + (b - a) * k;
const sstep = (a, b, x) => { const k = Math.min(1, Math.max(0, (x - a) / (b - a))); return k * k * (3 - 2 * k); };
const dirOf = s => { const a = s.az * Math.PI / 180, e = s.el * Math.PI / 180;
  return new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)); };

export function buildFlyup(raw, satTex) {
  const scene = new THREE.Scene();
  const U = { uLook: { value: 1 } };

  /* sky: black (Moon) to a pale-blue gradient (real), on a sphere that follows the camera and is drawn first */
  const sky = new THREE.Mesh(new THREE.SphereGeometry(5000, 32, 16), new THREE.ShaderMaterial({
    uniforms: U, side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
    vertexShader: 'varying vec3 d; void main(){ d = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    fragmentShader: `uniform float uLook; varying vec3 d; void main(){ float h = .5*(d.y + sqrt(d.y*d.y + 1e-4));
      vec3 c = mix(vec3(${SKY_H.join(',')}), vec3(${SKY_Z.join(',')}), pow(h,.45)); gl_FragColor = vec4(c*uLook,1.); }`,
  }));
  sky.renderOrder = -10; sky.frustumCulled = false; scene.add(sky);

  /* heights above the tile's minimum, exaggerated, as in earth_ground.js; beyond the tile, mirrored and flattening */
  let m0 = Infinity, sum = 0;
  for (let i = 0; i < N * N; i++) { const v = raw[i]; if (v < m0) m0 = v; sum += v; }
  const Y = new Float32Array(N * N); let yMax = 0;
  for (let i = 0; i < N * N; i++) { Y[i] = (raw[i] - m0) * EX; if (Y[i] > yMax) yMax = Y[i]; }
  const yMean = (sum / (N * N) - m0) * EX;
  const mirror = f => { const m = ((f % (2 * N - 2)) + 2 * N - 2) % (2 * N - 2); return m > N - 1 ? 2 * N - 2 - m : m; };
  const yAt = (fc, fr) => {   // bilinear height at fractional (column, row), mirrored beyond the tile
    fc = mirror(fc); fr = mirror(fr);
    const c = Math.min(N - 2, Math.floor(fc)), r = Math.min(N - 2, Math.floor(fr)), a = fc - c, b = fr - r, i = r * N + c;
    return lerp(lerp(Y[i], Y[i + 1], a), lerp(Y[i + N], Y[i + N + 1], a), b);
  };
  const ground = (x, z) => yAt((x + HALF) / D, (z + HALF) / D);
  const height = (x, z) => {
    const o = Math.max(Math.abs(x), Math.abs(z)) - HALF;
    return o <= 0 ? ground(x, z) : lerp(ground(x, z), yMean, .6 * sstep(3000, 20000, o));
  };

  /* terrain mesh: the tile's 500 x 500 grid exactly as earth_ground.js (same vertices and UVs), plus an apron of
     widening rings carrying the mirrored terrain and image, so low views see land to the horizon, not the tile's edge */
  const xs = [], off = [0];
  for (let k = 1, s = D; k <= PAD; k++, s *= PAD_GROW) off.push(off[k - 1] + s);
  for (let k = PAD; k >= 1; k--) xs.push(-HALF - off[k]);
  for (let c = 0; c < N; c++) xs.push(-HALF + c * D);
  for (let k = 1; k <= PAD; k++) xs.push(HALF + off[k]);
  const M = xs.length, pos = new Float32Array(M * M * 3), nrm = new Float32Array(M * M * 3), uv = new Float32Array(M * M * 2);
  const hs = new Float32Array(M * M);
  for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) {
    const inside = i >= PAD && i < PAD + N && j >= PAD && j < PAD + N;
    hs[j * M + i] = inside ? Y[(j - PAD) * N + (i - PAD)] : height(xs[i], xs[j]);
  }
  for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) {
    const v = j * M + i, x = xs[i], z = xs[j];
    // normals by central differences on the (uneven) grid: same result as computeVertexNormals, much faster
    const i0 = Math.max(0, i - 1), i1 = Math.min(M - 1, i + 1), j0 = Math.max(0, j - 1), j1 = Math.min(M - 1, j + 1);
    const gx = (hs[j * M + i1] - hs[j * M + i0]) / (xs[i1] - xs[i0]), gz = (hs[j1 * M + i] - hs[j0 * M + i]) / (xs[j1] - xs[j0]);
    const l = 1 / Math.sqrt(gx * gx + 1 + gz * gz);
    pos[v * 3] = x; pos[v * 3 + 1] = hs[v]; pos[v * 3 + 2] = z;
    nrm[v * 3] = -gx * l; nrm[v * 3 + 1] = l; nrm[v * 3 + 2] = -gz * l;
    uv[v * 2] = (x + HALF) / (2 * HALF); uv[v * 2 + 1] = 1 - (z + HALF) / (2 * HALF);
  }
  const idx = new Uint32Array((M - 1) * (M - 1) * 6);
  for (let j = 0, n = 0; j < M - 1; j++) for (let i = 0; i < M - 1; i++) {   // same diagonal as PlaneGeometry
    const a = j * M + i, b = a + M, c = b + 1, d = a + 1;
    idx[n++] = a; idx[n++] = b; idx[n++] = d; idx[n++] = b; idx[n++] = c; idx[n++] = d;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();

  /* cast shadows for both suns, swept exactly along grid lines (O(cells)) over the tile and one mirrored tile around
     it. Each texel stores the clearance (metres) of the ground above the highest shadow line passing over it; the
     shader thresholds the bilinearly filtered clearance, so shadow edges stay crisp between the 30 m posts */
  const S = 3 * N - 2, X0 = -3 * HALF, RANGE = 12;    // texel i <-> x = X0 + i*D (same for z/rows); clearance clamped to +-RANGE
  const H = new Float32Array(S * S), mi = new Int32Array(S), ax = new Float32Array(S);
  for (let i = 0; i < S; i++) { mi[i] = mirror(i - (N - 1)); ax[i] = Math.abs(X0 + i * D); }
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++)   // = height() on the posts, without the interpolation
    H[j * S + i] = lerp(Y[mi[j] * N + mi[i]], yMean, .6 * sstep(3000, 20000, Math.max(ax[i], ax[j]) - HALF));
  const shadow = new Uint8Array(S * S * 2), Mx = new Float32Array(S * S);
  const sweep = (dc, dr, el, ch) => {
    const step = D * Math.hypot(dc, dr) * Math.tan(el * Math.PI / 180), k2 = 127.5 / RANGE;
    // visit cells so that the neighbour towards the sun (i+dc, j+dr) is always done first
    const js = dr > 0 ? S - 1 : 0, je = dr > 0 ? -1 : S, jd = dr > 0 ? -1 : 1;
    const is = dc > 0 ? S - 1 : 0, ie = dc > 0 ? -1 : S, id = dc > 0 ? -1 : 1;
    for (let j = js; j !== je; j += jd) {
      const qj = j + dr, rowOut = qj < 0 || qj >= S;
      for (let i = is; i !== ie; i += id) {
        const qi = i + dc, k = j * S + i;
        let m = -1e9;
        if (!rowOut && qi >= 0 && qi < S) { const q = qj * S + qi; m = (Mx[q] > H[q] ? Mx[q] : H[q]) - step; }
        Mx[k] = m;
        let cl = H[k] - m; cl = cl > RANGE ? RANGE : cl < -RANGE ? -RANGE : cl;
        shadow[k * 2 + ch] = (127.5 + cl * k2 + .5) | 0;
      }
    }
  };
  sweep(SUN_REAL.dc, SUN_REAL.dr, SUN_REAL.el, 0);
  sweep(SUN_MOON.dc, SUN_MOON.dr, SUN_MOON.el, 1);
  const shadowTex = new THREE.DataTexture(shadow, S, S, THREE.RGFormat, THREE.UnsignedByteType);
  shadowTex.magFilter = shadowTex.minFilter = THREE.LinearFilter; shadowTex.needsUpdate = true;

  satTex.colorSpace = THREE.SRGBColorSpace; satTex.anisotropy = 8;   // the same settings earth_ground.js uses (wrap untouched)
  Object.assign(U, {
    uShadow: { value: shadowTex },
    uHaze: { value: new THREE.Vector3(...SKY_H) },   // output (sRGB) space: mixed in after tone mapping, as three's fog is
    uK: { value: 0 }, uY0: { value: yMean }, uHs: { value: 1200 },
  });
  const mat = new THREE.MeshStandardMaterial({ map: satTex, roughness: 1, metalness: 0 });
  mat.onBeforeCompile = s => {
    Object.assign(s.uniforms, U);
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vW;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvW = (modelMatrix*vec4(transformed,1.)).xyz;');
    s.fragmentShader = s.fragmentShader.replace('#include <common>', `#include <common>
varying vec3 vW;
uniform sampler2D uShadow; uniform vec3 uHaze; uniform float uK, uY0, uHs, uLook;
float h21(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }
float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f); return mix(mix(h21(i),h21(i+vec2(1,0)),f.x),mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x),f.y); }`)
      .replace('#include <map_fragment>', `
  // the image, mirrored on the apron (done here: the shared texture's wrap mode is left alone) and softened with
  // distance beyond the tile so the mirror is never legible
  float out_ = max(max(abs(vW.x), abs(vW.z)) - ${HALF.toFixed(2)}, 0.);
  vec2 mu = 1. - abs(1. - mod(vMapUv, 2.)), gx = dFdx(vMapUv)*(1. + out_/150.), gy = dFdy(vMapUv)*(1. + out_/150.);
  vec3 tex = textureGrad(map, mu, gx, gy).rgb;
  { // mild unsharp mask at the image's own pixel scale: crisper ridges and gullies when seen close
    float px = 1./${SAT_PX}.;
    vec3 bl = (textureGrad(map, mu + vec2(px,0.), gx, gy).rgb + textureGrad(map, mu - vec2(px,0.), gx, gy).rgb
             + textureGrad(map, mu + vec2(0.,px), gx, gy).rgb + textureGrad(map, mu - vec2(0.,px), gx, gy).rgb) * .25;
    tex = max(tex + .6*(tex - bl), 0.); }
  // real colours: a little richer and warmer than the raw reflectance (late-October grass under a low sun)
  float lum = dot(tex, vec3(.2126,.7152,.0722));
  tex = max(mix(vec3(lum), tex, 1.35), 0.) * vec3(1.12, 1., .78);
  diffuseColor.rgb *= mix(vec3(.135,.13,.122), tex, uLook);
  { // ground grain below the image's 15 m pixels, near the camera; octaves fade out before they alias
    float dist = length(vW - cameraPosition);
    vec2 q = vW.xz;
    float f1 = 1. - smoothstep(.15, .5, fwidth(q.x*.03) + fwidth(q.y*.03));
    float f2 = 1. - smoothstep(.15, .5, fwidth(q.x*.11) + fwidth(q.y*.11));
    float f3 = 1. - smoothstep(.15, .5, fwidth(q.x*.4) + fwidth(q.y*.4));
    float f4 = 1. - smoothstep(.15, .5, fwidth(q.x*1.6) + fwidth(q.y*1.6));
    float f5 = 1. - smoothstep(.15, .5, fwidth(q.x*6.) + fwidth(q.y*6.));
    // broad mottling suits grass; the Moon gets an even, finer grain
    float n = ((vn(q*.03)-.5)*.45*f1 + (vn(q*.11)-.5)*.35*f2) * mix(.3, 1., uLook)
            + ((vn(q*.4)-.5)*.3*f3 + (vn(q*1.6)-.5)*.3*f4 + (vn(q*6.)-.5)*.25*f5) * mix(1.6, 1., uLook);
    diffuseColor.rgb *= 1. + n*(1. - smoothstep(1500., 5000., dist)); }`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
  { vec2 st = ((vW.xz - ${X0.toFixed(2)})/${D} + .5)/${S}.;
    vec2 cl = (texture2D(uShadow, st).rg - .5) * ${2 * RANGE}.;
    float sh = mix(smoothstep(-.6, .6, cl.g), smoothstep(-3., 3., cl.r), uLook);
    sh = mix(1., sh, step(abs(st.x - .5), .5) * step(abs(st.y - .5), .5));
    reflectedLight.directDiffuse *= sh; reflectedLight.directSpecular *= sh; }`)
      // haze (real look only): an exponential-height atmosphere integrated along the view ray, thick looking across
      // the hills and thin looking down from high up, fading into the sky's horizon colour
      .replace('#include <fog_fragment>', `{
    float d = length(vW - cameraPosition);
    float a = (cameraPosition.y - uY0)/uHs, b = (vW.y - uY0)/uHs, dy = a - b;
    float od = abs(dy) > 1e-3 ? (exp(-b) - exp(-a))/dy : exp(-a);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, uHaze, 1. - exp(-uK*d*od)); }`);
  };
  const terrain = new THREE.Mesh(g, mat); scene.add(terrain);

  const dReal = dirOf(SUN_REAL), dMoon = dirOf(SUN_MOON), dSun = new THREE.Vector3();
  const cReal = new THREE.Color(0xffe2c0), cMoon = new THREE.Color(0xffffff);
  const sun = new THREE.DirectionalLight(0xffffff, 1); scene.add(sun, sun.target);
  const fill = new THREE.HemisphereLight(0xbfcbdb, 0x6b5a44, 1); scene.add(fill);

  const cam = new THREE.PerspectiveCamera(40, 16 / 9, 2, 150000);
  cam.rotation.order = 'YXZ';

  /* camera path. One eased progress e drives everything; the climb leads slightly and the tilt lags slightly, so the
     horizon stays in view while we rise out of the hills, then the land turns into a map beneath us */
  let st0;
  function setStart(o) {
    Object.assign(START, o);
    const x = -HALF + START.c * D, z = -HALF + START.r * D;
    st0 = { x, z, y: ground(x, z), lA: Math.log(START.above), p: START.pitch * Math.PI / 180, yaw: START.yaw };
  }
  setStart({});
  const lB = Math.log(FLYUP_TOP_ALT);
  function update(t, aspect, look = 1) {
    t = Math.min(1, Math.max(0, t)); look = Math.min(1, Math.max(0, look));
    const e = ease(t, .3), ea = 1 - Math.pow(1 - e, 1.6), ep = Math.pow(e, 1.3);
    // height above a reference sliding from the start's ground to the terrain's mean; even climb in log altitude
    const y = lerp(st0.y, yMean, ea) + Math.exp(lerp(st0.lA, lB, ea));
    cam.position.set(lerp(st0.x, 0, e), y, lerp(st0.z, 0, e));
    cam.rotation.set(lerp(st0.p, -Math.PI / 2, ep), -lerp(st0.yaw, 0, e), 0);
    if (cam.aspect !== aspect) { cam.aspect = aspect; cam.updateProjectionMatrix(); }
    sky.position.copy(cam.position);

    // look: Moon -> real colours (lighting and atmosphere only; nothing moves)
    U.uLook.value = look;
    dSun.copy(dMoon).lerp(dReal, look).normalize();
    sun.position.copy(dSun).multiplyScalar(20000);
    sun.color.copy(cMoon).lerp(cReal, look);
    sun.intensity = lerp(9, 3.6, look);
    fill.intensity = 1.25 * look * look;            // the Moon has no sky light: its shadows are black
    U.uK.value = look * lerp(.55e-4, .25e-4, e);    // light haze, less in the map view
  }
  update(0, 16 / 9);
  return { scene, cam, update, _dbg: { ground, U, yMean, yMax, HALF, setStart } };
}
