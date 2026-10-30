/**
 * Pinched oval with wavy bars carved out using SDF + manifold-3d levelSet
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader';
import GUI from 'lil-gui';
import { setWasmUrl, getManifoldModule } from 'manifold-3d/lib/wasm';
import wasmUrl from 'manifold-3d/manifold.wasm?url';

let wasm: any;
let Manifold: any;

let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let renderer: THREE.WebGLRenderer;
let controls: OrbitControls;
let mesh: THREE.Mesh | null = null;
let statsElement: HTMLElement;
let updateTimeout: number | null = null;

const params = {
  width: 24,          // mm
  height: 28,         // mm
  thickness: 2.2,     // mm
  pinch: 0.25,        // 0-1 pinch amount
  superN: 2.6,        // superellipse exponent
  stripeCount: 4,
  stripeWidth: 1.6,
  stripeAmplitude: 2.4,
  stripeFrequency: 0.18,
  stripeBlend: 0.25,
  resolution: 0.2,    // voxel size for levelSet
  color: '#555555',
  metalness: 0.2,
  roughness: 0.4,
};

// --- SDF helpers ---
function smax(a: number, b: number, k: number): number {
  const h = Math.max(0, Math.min(1, 0.5 + 0.5 * (b - a) / k));
  return THREE.MathUtils.lerp(a, b, h) + k * h * (1 - h);
}

function superellipseDist(x: number, y: number, rx: number, ry: number, n: number): number {
  const nx = Math.pow(Math.abs(x) / rx, n);
  const ny = Math.pow(Math.abs(y) / ry, n);
  const v = Math.pow(nx + ny, 1 / n);
  return (v - 1) * Math.min(rx, ry);
}

function pinchedCoords(x: number, y: number, pinch: number): { x: number; y: number } {
  const angle = Math.atan2(y, x);
  const pinchFactor = 1 + pinch * Math.cos(2 * angle);
  return {
    x: x / pinchFactor,
    y: y * pinchFactor,
  };
}

function sdfPinchedOval(point: number[]): number {
  const [x, y, z] = point;

  const pinch = params.pinch;
  const { x: px, y: py } = pinchedCoords(x, y, pinch);

  // Base 2D shape
  const base2D = superellipseDist(px, py, params.width / 2, params.height / 2, params.superN);

  // Thickness
  const zDist = Math.abs(z) - params.thickness / 2;
  let d = Math.max(base2D, zDist);

  // Carve wave gaps
  const count = Math.max(1, Math.floor(params.stripeCount));
  for (let i = 0; i < count; i++) {
    const t = (i + 1) / (count + 1);
    const centerY = THREE.MathUtils.lerp(params.height * 0.4, -params.height * 0.4, t);
    const warpedY = py - Math.sin(px * params.stripeFrequency) * params.stripeAmplitude;
    const stripe = Math.abs(warpedY - centerY) - params.stripeWidth / 2;
    d = smax(d, -stripe, params.stripeBlend);
  }

  return d;
}

// --- Meshing ---
function generateMesh(): THREE.BufferGeometry {
  const padding = Math.max(0.2, params.resolution * 2 + params.stripeAmplitude * 0.2);
  const outerX = params.width / 2 + padding + params.stripeAmplitude;
  const outerY = params.height / 2 + padding + params.stripeAmplitude;
  const outerZ = params.thickness / 2 + padding;
  const bounds = { min: [-outerX, -outerY, -outerZ], max: [outerX, outerY, outerZ] };

  const t0 = performance.now();
  const manifold = Manifold.levelSet(sdfPinchedOval, bounds, params.resolution, 0);
  const meshData = manifold.getMesh();
  const t1 = performance.now();

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(meshData.vertProperties, 3));
  geometry.setIndex(new THREE.BufferAttribute(meshData.triVerts, 1));
  geometry.computeVertexNormals();

  manifold.delete();

  console.log(
    `levelSet ${(t1 - t0).toFixed(0)}ms | verts ${meshData.numVert.toLocaleString()} tris ${meshData.numTri.toLocaleString()}`
  );

  return geometry;
}

function updateMesh(): void {
  if (!wasm) return;
  if (updateTimeout) clearTimeout(updateTimeout);
  updateTimeout = window.setTimeout(() => {
    try {
      const geometry = generateMesh();
      if (mesh) {
        mesh.geometry.dispose();
        mesh.geometry = geometry;
      } else {
        const material = new THREE.MeshStandardMaterial({
          color: params.color,
          metalness: params.metalness,
          roughness: params.roughness,
          envMapIntensity: 1.0,
        });
        mesh = new THREE.Mesh(geometry, material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        scene.add(mesh);
      }
      updateStats();
    } catch (err) {
      console.error('Failed to update mesh:', err);
    }
  }, 50);
}

function updateStats(): void {
  if (!statsElement || !mesh) return;
  const geom = mesh.geometry;
  const verts = geom.getAttribute('position').count;
  const tris = geom.getIndex() ? geom.getIndex()!.count / 3 : verts / 3;
  statsElement.textContent = `Vertices: ${verts.toLocaleString()} | Triangles: ${tris.toLocaleString()}`;
}

// --- Three.js setup ---
function initThree(): void {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const container = canvas.parentElement!;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 200);
  camera.position.set(50, 50, 50);

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.target.set(0, 0, 0);

  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(400, 400),
    new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 1 })
  );
  plane.rotation.x = -Math.PI / 2;
  plane.receiveShadow = true;
  scene.add(plane);

  new RGBELoader().load('./softbox.hdr', (hdr) => {
    hdr.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment = hdr;
  });

  const ambient = new THREE.AmbientLight(0xffffff, 0.2);
  scene.add(ambient);

  const key = new THREE.DirectionalLight(0xffffff, 3.0);
  key.position.set(-20, 30, -20);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xffffff, 1.0);
  fill.position.set(25, 15, 20);
  scene.add(fill);

  window.addEventListener('resize', () => {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  });
}

// --- UI ---
function initGUI(): void {
  const gui = new GUI({ title: 'Oval Waves' });

  const shape = gui.addFolder('Shape');
  shape.add(params, 'width', 10, 40, 0.5).name('Width (mm)').onChange(updateMesh);
  shape.add(params, 'height', 12, 50, 0.5).name('Height (mm)').onChange(updateMesh);
  shape.add(params, 'thickness', 1, 5, 0.1).name('Thickness (mm)').onChange(updateMesh);
  shape.add(params, 'pinch', 0, 0.6, 0.02).name('Pinch').onChange(updateMesh);
  shape.add(params, 'superN', 2, 4, 0.05).name('Superellipse N').onChange(updateMesh);

  const stripes = gui.addFolder('Stripes');
  stripes.add(params, 'stripeCount', 2, 8, 1).name('Count').onChange(updateMesh);
  stripes.add(params, 'stripeWidth', 0.5, 3.5, 0.1).name('Width').onChange(updateMesh);
  stripes.add(params, 'stripeAmplitude', 0, 4, 0.1).name('Amplitude').onChange(updateMesh);
  stripes.add(params, 'stripeFrequency', 0.05, 0.4, 0.01).name('Frequency').onChange(updateMesh);
  stripes.add(params, 'stripeBlend', 0, 0.8, 0.02).name('Blend').onChange(updateMesh);

  const quality = gui.addFolder('Quality');
  quality.add(params, 'resolution', 0.05, 0.8, 0.01).name('Resolution').onChange(updateMesh);

  const material = gui.addFolder('Material');
  material.addColor(params, 'color').name('Color').onChange(updateMesh);
  material.add(params, 'metalness', 0, 1, 0.01).name('Metalness').onChange(updateMesh);
  material.add(params, 'roughness', 0, 1, 0.01).name('Roughness').onChange(updateMesh);
}

// --- Main ---
async function init(): Promise<void> {
  const loading = document.getElementById('loading');
  const loadingText = document.querySelector('.loading-text') as HTMLElement | null;

  try {
    statsElement = document.getElementById('stats')!;
    setWasmUrl(wasmUrl);
    wasm = await getManifoldModule();
    Manifold = wasm.Manifold;
    console.log('Manifold WASM ready');

    initThree();
    initGUI();
    updateMesh();
    animate();

    if (loading) loading.classList.add('hidden');
  } catch (err: any) {
    console.error('Failed to initialize oval demo:', err);
    if (loadingText) loadingText.textContent = `Error: ${err?.message || err}`;
  }
}

function animate(): void {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
