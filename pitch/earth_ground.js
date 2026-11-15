import * as THREE from 'three';

/* Earth ground: Kohler Coulee terrain (Copernicus GLO-30, 30 m) draped with a real NASA HLS image (9 Oct 2025).
   Units: metres. Only the first few metres of grass are drawn by the computer; colour comes from the image. */
const N = 500, D = 30.06, EX = 1.5;
const SPOT = { r: 188, c: 312, yaw: 0.52 };          // flat ridge looking north-east across the coulee

export function buildGround(raw, satTex, astroSrc, walkify) {
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(new THREE.Color(0xaabdd0), 0.00006);
  const sky = new THREE.Mesh(new THREE.SphereGeometry(40000, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
    vertexShader: 'varying vec3 d; void main(){ d = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    // sky colours written as-is (no tone mapping), as in the approved option B
    fragmentShader: `varying vec3 d; void main(){ float h = max(d.y,0.); vec3 c = mix(vec3(.722,.804,.878), vec3(.141,.373,.702), pow(h,.45)); gl_FragColor = vec4(c,1.); }`,
  }));
  sky.renderOrder = -10; sky.frustumCulled = false; scene.add(sky);

  const hAt = (c, r) => raw[Math.min(N - 1, Math.max(0, r)) * N + Math.min(N - 1, Math.max(0, c))];
  let m0 = 1e9; for (const v of raw) m0 = Math.min(m0, v);
  const g = new THREE.PlaneGeometry((N - 1) * D, (N - 1) * D, N - 1, N - 1); g.rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, (hAt(i % N, Math.floor(i / N)) - m0) * EX);
  g.computeVertexNormals();
  const H = (x, z) => {
    const fc = (x + (N - 1) * D / 2) / D, fr = (z + (N - 1) * D / 2) / D, c = Math.floor(fc), r = Math.floor(fr), a = fc - c, b = fr - r;
    // same split as the mesh triangles, so feet sit exactly on the drawn ground
    const h00 = hAt(c, r), h10 = hAt(c + 1, r), h01 = hAt(c, r + 1), h11 = hAt(c + 1, r + 1);
    const h = a + b <= 1 ? h00 + (h10 - h00) * a + (h01 - h00) * b : h11 + (h01 - h11) * (1 - a) + (h10 - h11) * (1 - b);
    return (h - m0) * EX;
  };
  satTex.colorSpace = THREE.SRGBColorSpace; satTex.anisotropy = 8;
  const mat = new THREE.MeshStandardMaterial({ map: satTex, roughness: 1, metalness: 0 });
  mat.onBeforeCompile = s => {
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vW;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvW = (modelMatrix*vec4(transformed,1.)).xyz;');
    s.fragmentShader = s.fragmentShader.replace('#include <common>', `#include <common>
varying vec3 vW;
float h21(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }
float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f); return mix(mix(h21(i),h21(i+vec2(1,0)),f.x),mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x),f.y); }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
  { float dist = length(vW - cameraPosition); float k = 1. - smoothstep(20., 600., dist);
    // octaves fade out before they alias into stripes
    float f2 = 1. - smoothstep(.15, .5, fwidth(vW.x*3.1) + fwidth(vW.z*3.1));
    float f3 = 1. - smoothstep(.15, .5, fwidth(vW.x*11.) + fwidth(vW.z*11.));
    float n = vn(vW.xz*.9)*.5 + (vn(vW.xz*3.1)-.5)*.3*f2 + (vn(vW.xz*11.)-.5)*.2*f3 + .25;
    vec3 straw = vec3(.62,.52,.36), dirt = vec3(.42,.34,.25);
    vec3 det = mix(dirt, straw, smoothstep(.3,.75,n));
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb*(.8+.5*n) * mix(vec3(1.), det / max(dot(det,vec3(.33)),.01), .35), k);
    diffuseColor.rgb *= mix(1., .88 + .24*vn(vW.xz*.12), k*.6); }`);
  };
  const ground = new THREE.Mesh(g, mat); ground.receiveShadow = true; scene.add(ground);

  const sun = new THREE.DirectionalLight(0xfff1dc, 3.2); scene.add(sun, sun.target);
  scene.add(new THREE.HemisphereLight(0xaac4e6, 0x6b5a44, 1.0));
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -14, right: 14, top: 14, bottom: -14, near: 1, far: 200 }); sun.shadow.bias = -0.0004;

  const fwd = new THREE.Vector3(Math.sin(SPOT.yaw), 0, -Math.cos(SPOT.yaw));
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
  const A0 = new THREE.Vector3(-(N - 1) * D / 2 + SPOT.c * D, 0, -(N - 1) * D / 2 + SPOT.r * D);

  // astronaut: same NASA model and walk shader as on the Moon, at 1.8 m
  const astro = astroSrc.clone(true);
  astro.scale.multiplyScalar(1000); astro.position.multiplyScalar(1000);
  astro.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false;
    o.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }); walkify(o.customDepthMaterial); } });
  const AG = new THREE.Group(); AG.add(astro); scene.add(AG);
  AG.rotation.y = Math.atan2(fwd.x, fwd.z) - 0.5;

  // sparse clumps of short dry grass around the walk; density falls off smoothly (no visible edge)
  {
    const blade = new THREE.PlaneGeometry(.014, 1, 1, 3); blade.translate(0, .5, 0);
    const bp = blade.attributes.position; for (let i = 0; i < bp.count; i++) { const y = bp.getY(i); bp.setX(i, bp.getX(i) * (1 - y)); bp.setZ(i, y * y * .25); }
    const n = 56000, im = new THREE.InstancedMesh(blade, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, side: THREE.DoubleSide }), n);
    const cv = document.createElement('canvas'); cv.width = cv.height = 500; const cx = cv.getContext('2d'); cx.drawImage(satTex.image, 0, 0, 500, 500);
    const px = cx.getImageData(0, 0, 500, 500).data;
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), Sv = new THREE.Vector3(), Pv = new THREE.Vector3(), col = new THREE.Color(), straw = new THREE.Color(.62, .52, .34);
    const E = new THREE.Euler(); let x = 0, z = 0, ch = .2;
    const mx = A0.x + fwd.x * 6, mz = A0.z + fwd.z * 6;
    for (let i = 0; i < n; i++) {
      if (i % 7 === 0) { const rr = -Math.log(1 - Math.random() * .995) * 10, th = Math.random() * 6.283; x = mx + Math.sin(th) * rr; z = mz - Math.cos(th) * rr; ch = .08 + Math.pow(Math.random(), 2) * .3; }
      const bx = x + (Math.random() - .5) * .14, bz = z + (Math.random() - .5) * .14;
      Pv.set(bx, H(bx, bz) - .01, bz);
      Q.setFromEuler(E.set((Math.random() - .5) * .7, Math.random() * 6.28, (Math.random() - .5) * .7));
      const s = ch * (.6 + Math.random() * .6); Sv.set(1 + Math.random(), s, s);
      M.compose(Pv, Q, Sv); im.setMatrixAt(i, M);
      const u = Math.floor((bx + (N - 1) * D / 2) / ((N - 1) * D) * 499), v = Math.floor((bz + (N - 1) * D / 2) / ((N - 1) * D) * 499), k = (clamp(v) * 500 + clamp(u)) * 4;
      col.setRGB(px[k] / 255, px[k + 1] / 255, px[k + 2] / 255, THREE.SRGBColorSpace).multiplyScalar(.85 + Math.random() * .5);
      col.lerp(straw, .35); im.setColorAt(i, col);
    }
    im.receiveShadow = true; im.frustumCulled = false; scene.add(im);
  }
  function clamp(i) { return Math.min(499, Math.max(0, i)); }

  const cam = new THREE.PerspectiveCamera(38, 1, .1, 60000);
  const se = 13 * Math.PI / 180, sa = 230 * Math.PI / 180;   // low sun from the side: long shadows, depth in the grass
  const sunDir = new THREE.Vector3(Math.sin(sa) * Math.cos(se), Math.sin(se), -Math.cos(sa) * Math.cos(se));

  /** walked: metres along the walk; pull: 0 = close behind, 1 = pulled back and up (handoff). */
  function update(walked, pull, aspect) {
    const P = A0.clone().addScaledVector(fwd, walked);
    P.y = H(P.x, P.z) - .03;
    AG.position.copy(P);
    const back = 7 + pull * 30, up = 1.7 + pull * 10, side = -(1.4 + pull * 4) * Math.min(1, aspect / 1.7);
    const c = P.clone().addScaledVector(fwd, -back).addScaledVector(right, side);
    cam.position.set(c.x, H(c.x, c.z) + up, c.z);
    cam.lookAt(P.x + fwd.x * 60, P.y + 1.2 + pull * 2, P.z + fwd.z * 60);
    cam.aspect = aspect; cam.updateProjectionMatrix();
    sun.position.copy(P).addScaledVector(sunDir, 80); sun.target.position.copy(P);
  }
  return { scene, cam, update };
}
