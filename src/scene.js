// Three.js scene (global THREE from the pinned cdnjs build). Follows the original demo's look.
import { sampleAt } from './flight.js';

const EVENT_COLORS = { liftoff: 0xffffff, burnout: 0xffb347, apogee: 0xff5a36, drogue: 0xc084fc, main: 0x60a5fa, landing: 0x4ade80, custom: 0x94a3b8 };

export function createScene(canvas) {
  const THREE = window.THREE;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);

  renderer.toneMapping = THREE.ReinhardToneMapping;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0e14);
  scene.fog = new THREE.Fog(0x0a0e14, 60, 260);
  const camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.1, 1000);
  const ambient = new THREE.AmbientLight(0x44506a, 1.3);
  scene.add(ambient);
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(60, 90, 40);
  scene.add(sun);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(320, 320), new THREE.MeshStandardMaterial({ color: 0x0d1620, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  scene.add(new THREE.GridHelper(320, 32, 0x223040, 0x152030));
  const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.8, 0.3, 16), new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.5 }));
  pad.position.y = 0.15;
  scene.add(pad);

  // stars (fixed seed-free layout, same as the original)
  {
    const count = 1200;
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const r = 150 + Math.random() * 100, th = Math.random() * Math.PI * 2, ph = Math.random() * Math.PI * 0.48;
      pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
      pos[i * 3 + 1] = r * Math.cos(ph) + 10;
      pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    scene.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: 0x8899aa, size: 0.6, transparent: true, opacity: 0.55 })));
  }

  function buildRocket() {
    const group = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xe8edf2, metalness: 0.25, roughness: 0.5 });
    const noseMat = new THREE.MeshStandardMaterial({ color: 0xff5a36, metalness: 0.2, roughness: 0.4 });
    const finMat = new THREE.MeshStandardMaterial({ color: 0x1f2a35, metalness: 0.4, roughness: 0.6 });
    const bodyHeight = 3.2, bodyRadius = 0.28;
    const body = new THREE.Mesh(new THREE.CylinderGeometry(bodyRadius, bodyRadius, bodyHeight, 32), bodyMat);
    body.position.y = bodyHeight / 2;
    group.add(body);
    const nose = new THREE.Mesh(new THREE.ConeGeometry(bodyRadius, 0.9, 32), noseMat);
    nose.position.y = bodyHeight + 0.45;
    group.add(nose);
    for (let i = 0; i < 4; i++) {
      const pivot = new THREE.Group();
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.7, 0.55), finMat);
      fin.position.set(bodyRadius + 0.05, 0.35, 0);
      pivot.add(fin);
      pivot.rotation.y = (i / 4) * Math.PI * 2;
      group.add(pivot);
    }
    const flame = new THREE.Mesh(new THREE.ConeGeometry(bodyRadius * 0.85, 1.2, 12), new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.85 }));
    flame.rotation.x = Math.PI;
    flame.position.y = -0.6;
    flame.visible = false;
    group.add(flame);
    group.userData.flame = flame;
    const glow = new THREE.PointLight(0xff5a36, 0, 15);
    glow.position.y = -0.5;
    group.add(glow);
    group.userData.glow = glow;
    return group;
  }
  const rocket = buildRocket();
  scene.add(rocket);

  const ghost = new THREE.Mesh(new THREE.SphereGeometry(0.55, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.9 }));
  ghost.visible = false;
  scene.add(ghost);

  const dyn = new THREE.Group(); // trajectories + markers, rebuilt per flight set
  scene.add(dyn);
  let travA = null, travB = null;
  let scale = 0.045;
  let a = null, b = null;
  let overviewCenter = new THREE.Vector3(), overviewDiag = 40;
  let viewMode = 'follow'; // 'follow' | 'overview' | 'cinematic'
  let autoOrbit = false;
  let shake = 0;
  let targetRadius = 13;
  let az = Math.PI * 0.25, el = Math.PI * 0.22, radius = 13;
  const lastQuat = new THREE.Quaternion();

  function disposeDyn() {
    while (dyn.children.length) {
      const o = dyn.children.pop();
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    }
  }

  const P = (f) => new THREE.Vector3(f.x * scale, f.alt * scale, f.y * scale);

  function lineFor(flight, color) {
    const n = flight.frames.length;
    const arr = new Float32Array(n * 3);
    flight.frames.forEach((f, i) => { arr[i * 3] = f.x * scale; arr[i * 3 + 1] = f.alt * scale; arr[i * 3 + 2] = f.y * scale; });
    const mk = (opacity) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      return { g, l: new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity })) };
    };
    const full = mk(0.16), trav = mk(0.95);
    trav.g.setDrawRange(0, 1);
    dyn.add(full.l, trav.l);
    return trav.g;
  }

  function setFlights(fa, fb) {
    a = fa; b = fb || null;
    disposeDyn();
    let maxAlt = 1, maxH = 1;
    for (const f of [a, b]) {
      if (!f) continue;
      for (const fr of f.frames) { maxAlt = Math.max(maxAlt, fr.alt); maxH = Math.max(maxH, Math.hypot(fr.x, fr.y)); }
    }
    scale = Math.min(0.06, 60 / Math.max(maxAlt, maxH));
    travA = lineFor(a, 0x5eead4);
    travB = b ? lineFor(b, 0xffb347) : null;
    ghost.visible = !!b;
    for (const [fl, isB] of [[a, false], [b, true]]) {
      if (!fl) continue;
      for (const e of fl.events) {
        const s = sampleAt(fl, e.t);
        const m = new THREE.Mesh(new THREE.SphereGeometry(isB ? 0.35 : 0.45, 10, 8), new THREE.MeshBasicMaterial({ color: EVENT_COLORS[e.name] || 0x94a3b8, transparent: true, opacity: isB ? 0.6 : 0.95 }));
        m.position.copy(P(s));
        dyn.add(m);
      }
    }
    const box = new THREE.Box3();
    for (const f of [a, b]) if (f) for (const fr of f.frames) box.expandByPoint(P(fr));
    box.getCenter(overviewCenter);
    overviewDiag = box.min.distanceTo(box.max);
    applyPreset();
  }

  function applyPreset() {
    if (viewMode === 'overview') { targetRadius = Math.max(overviewDiag * 0.85, 20); el = Math.PI * 0.28; }
    else { targetRadius = 13; el = Math.PI * (viewMode === 'cinematic' ? 0.15 : 0.22); }
    radius = targetRadius;
  }

  // orbit controls
  let dragging = false, lx = 0, ly = 0;
  canvas.addEventListener('pointerdown', (e) => { dragging = true; lx = e.clientX; ly = e.clientY; });
  window.addEventListener('pointerup', () => { dragging = false; });
  window.addEventListener('pointercancel', () => { dragging = false; });
  window.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    az -= (e.clientX - lx) * 0.005;
    el = Math.max(0.05, Math.min(Math.PI / 2 - 0.03, el + (e.clientY - ly) * 0.005));
    lx = e.clientX; ly = e.clientY;
  });
  canvas.addEventListener('wheel', (e) => {
    const maxR = Math.max(overviewDiag * 1.5, 40);
    radius = Math.max(4, Math.min(maxR, radius + e.deltaY * 0.02));
    targetRadius = radius;
    e.preventDefault();
  }, { passive: false });

  const up = new THREE.Vector3(0, 1, 0);
  function update(time, offsetB, dt = 0.016) {
    if (!a) return;
    const f = sampleAt(a, time);
    rocket.position.copy(P(f));
    if (a.orient === 'velocity') {
      // nose follows the velocity vector while climbing; hangs upright under canopy
      const dir = f.vAlt > 3 ? new THREE.Vector3(f.vx, f.vAlt, f.vy) : up.clone();
      lastQuat.setFromUnitVectors(up, dir.normalize());
      rocket.quaternion.slerp(lastQuat, 0.25);
    } else {
      rocket.quaternion.identity();
      rocket.rotation.set(THREE.MathUtils.degToRad(f.pitch), THREE.MathUtils.degToRad(f.roll), THREE.MathUtils.degToRad(f.yaw));
    }
    const boost = f.phase === 'BOOST';
    rocket.userData.flame.visible = boost;
    rocket.userData.glow.intensity = boost ? 1.5 + Math.random() : 0;
    if (boost) rocket.userData.flame.scale.set(1, 0.75 + Math.random() * 0.5, 1);
    if (viewMode === 'cinematic') {
      // slow orbit, zoom in during the burn with a little shake, zoom out afterwards
      az += 0.3 * dt;
      el = Math.PI * 0.15 + Math.sin(performance.now() * 0.0005) * 0.05;
      targetRadius = boost ? 10 : 18;
      shake = boost ? 0.15 : Math.max(0, shake - dt * 0.5);
      radius += (targetRadius - radius) * 0.05;
    } else if (autoOrbit) az += 0.3 * dt;

    const idx = (fl, t) => { let lo = 0, hi = fl.frames.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (fl.frames[m].t <= t) lo = m; else hi = m; } return t >= fl.frames[hi].t ? hi : lo; };
    travA.setDrawRange(0, Math.max(2, idx(a, time) + 1));
    if (b) {
      const tb = time - offsetB;
      ghost.position.copy(P(sampleAt(b, tb)));
      travB.setDrawRange(0, tb <= 0 ? 2 : Math.max(2, idx(b, tb) + 1));
    }
    const target = viewMode === 'overview' ? overviewCenter : rocket.position;
    const sh = viewMode === 'cinematic' ? shake : 0;
    camera.position.set(
      target.x + radius * Math.cos(el) * Math.sin(az) + (Math.random() - 0.5) * sh,
      target.y + radius * Math.sin(el) + (Math.random() - 0.5) * sh,
      target.z + radius * Math.cos(el) * Math.cos(az) + (Math.random() - 0.5) * sh,
    );
    camera.lookAt(target);
  }

  return {
    setFlights, update,
    render: () => renderer.render(scene, camera),
    setViewMode(m) { viewMode = m; applyPreset(); },
    getViewMode: () => viewMode,
    setAutoOrbit(v) { autoOrbit = v; },
    // high-visibility look (brighter, lighter background) from the High Visibility demo
    setHighVis(v) {
      ambient.intensity = v ? 2.6 : 1.3;
      const c = v ? 0x1a202c : 0x0a0e14;
      scene.background.setHex(c);
      scene.fog.color.setHex(c);
      renderer.toneMapping = v ? THREE.NoToneMapping : THREE.ReinhardToneMapping;
    },
    resize() {
      renderer.setSize(window.innerWidth, window.innerHeight);
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
    },
    canvas,
  };
}
