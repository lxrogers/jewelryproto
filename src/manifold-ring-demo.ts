/**
 * Manifold Ring Demo
 * Using manifold-3d for CSG operations with proper watertight meshes
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter';
import GUI from 'lil-gui';
import { setWasmUrl, getManifoldModule } from 'manifold-3d/lib/wasm';

// Import the wasm URL for Vite
import wasmUrl from 'manifold-3d/manifold.wasm?url';

// Manifold types
let wasm: any;
let Manifold: any;

// Global state
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let renderer: THREE.WebGLRenderer;
let controls: OrbitControls;
let ringMesh: THREE.Mesh | null = null;
let groundPlane: THREE.Mesh;

// Stats display
let statsElement: HTMLElement;
let lastUpdateTime = 0;

// Debounce timer
let updateTimeout: number | null = null;

// Parameters
const params = {
  // Ring dimensions (in mm, will scale for display)
  innerDiameter: 17,    // Ring size ~US 6.5
  thickness: 2.5,       // Wall thickness
  width: 6,             // Band height/width

  // Decoration
  waveCount: 0,         // Number of bumps around circumference
  waveAmplitude: 0.8,   // Size of bumps

  // Cross bar
  showBar: true,
  barDepth: 2,

  // Quality
  segments: 64,

  // Material
  wireframe: true,
  color: '#888888',
};

/**
 * Generate ring geometry using Manifold
 */
function generateRingManifold(): THREE.BufferGeometry {
  const innerRadius = params.innerDiameter / 2;
  const outerRadius = innerRadius + params.thickness;
  const width = params.width;
  const segments = params.segments;

  // Create outer cylinder (height along Z in Manifold)
  const outer = Manifold.cylinder(width, outerRadius, outerRadius, segments, true);

  // Create inner cylinder (slightly taller for clean subtraction)
  const inner = Manifold.cylinder(width + 2, innerRadius, innerRadius, segments, true);

  // Subtract to create hollow ring
  let ring = outer.subtract(inner);

  // Add cross bar if enabled
  if (params.showBar) {
    const barLength = (outerRadius - params.barDepth / 2) * 2;
    // Create bar as a box - Manifold.cube creates a box at origin
    // cube(size, center) where size is [x, y, z]
    const bar = Manifold.cube([barLength, params.barDepth, width], true);
    ring = ring.add(bar);
  }

  // Add wave bumps
  if (params.waveCount > 0 && params.waveAmplitude > 0) {
    const bumpRadius = outerRadius + params.waveAmplitude * 0.5;
    for (let i = 0; i < params.waveCount; i++) {
      const angle = (i / params.waveCount) * Math.PI * 2;
      const bump = Manifold.sphere(params.waveAmplitude, 16)
        .scale([1, 1, width / (params.waveAmplitude * 2.5)])
        .translate([
          Math.cos(angle) * bumpRadius,
          Math.sin(angle) * bumpRadius,
          0,
        ]);
      ring = ring.add(bump);
    }
  }

  // Get mesh data from Manifold
  const mesh = ring.getMesh();

  // Convert to Three.js BufferGeometry (following official example)
  const geometry = new THREE.BufferGeometry();

  // vertProperties is Float32Array with xyz positions
  // triVerts is Uint32Array with triangle indices
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.vertProperties, 3));
  geometry.setIndex(new THREE.BufferAttribute(mesh.triVerts, 1));

  // Compute normals
  geometry.computeVertexNormals();

  // Rotate so Y is up (Manifold uses Z up)
  geometry.rotateX(-Math.PI / 2);

  // Clean up Manifold objects
  ring.delete();
  outer.delete();
  inner.delete();

  return geometry;
}

/**
 * Update the ring mesh with debouncing
 */
function updateRingMesh(): void {
  if (!wasm) return; // Manifold not loaded yet

  if (updateTimeout) {
    clearTimeout(updateTimeout);
  }

  updateTimeout = window.setTimeout(() => {
    const startTime = performance.now();

    const geometry = generateRingManifold();

    if (ringMesh) {
      ringMesh.geometry.dispose();
      ringMesh.geometry = geometry;
      (ringMesh.material as THREE.MeshBasicMaterial).wireframe = params.wireframe;
    } else {
      const material = new THREE.MeshBasicMaterial({
        color: params.color,
        wireframe: params.wireframe,
      });

      ringMesh = new THREE.Mesh(geometry, material);
      scene.add(ringMesh);
    }

    // Position ring so it sits on the ground
    ringMesh.position.y = params.width / 2;

    lastUpdateTime = performance.now() - startTime;
    updateStats();
  }, 50); // 50ms debounce
}

/**
 * Update material properties
 */
function updateMaterial(): void {
  if (!ringMesh) return;
  const material = ringMesh.material as THREE.MeshBasicMaterial;
  material.color.set(params.color);
  material.wireframe = params.wireframe;
}

/**
 * Update stats display
 */
function updateStats(): void {
  if (!statsElement || !ringMesh) return;

  const geom = ringMesh.geometry;
  const vertices = geom.getAttribute('position').count;
  const indexAttr = geom.getIndex();
  const triangles = indexAttr ? indexAttr.count / 3 : vertices / 3;

  statsElement.textContent = `Vertices: ${vertices.toLocaleString()} | Triangles: ${triangles.toLocaleString()} | Update: ${lastUpdateTime.toFixed(1)}ms`;
}

/**
 * Export as GLB
 */
function exportGLB(): void {
  if (!ringMesh) return;

  const exporter = new GLTFExporter();
  exporter.parse(
    ringMesh,
    (gltf) => {
      const blob = new Blob([gltf as ArrayBuffer], { type: 'model/gltf-binary' });
      downloadBlob(blob, 'ring.glb');
    },
    (error) => console.error('GLB export error:', error),
    { binary: true }
  );
}

/**
 * Export as STL
 */
function exportSTL(): void {
  if (!ringMesh) return;

  const exporter = new STLExporter();
  const stl = exporter.parse(ringMesh, { binary: true });
  const blob = new Blob([stl], { type: 'application/octet-stream' });
  downloadBlob(blob, 'ring.stl');
}

/**
 * Download blob as file
 */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Create ground gradient texture
 */
function createGroundGradientTexture(size = 1024): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d')!;

  const centerX = size / 2;
  const centerY = size / 2;
  const maxRadius = size / 2;

  const gradient = context.createRadialGradient(
    centerX, centerY, 0,
    centerX, centerY, maxRadius * 0.8
  );

  gradient.addColorStop(0, 'rgb(200, 200, 200)');
  gradient.addColorStop(0.5, 'rgb(120, 120, 120)');
  gradient.addColorStop(1, 'rgb(80, 80, 80)');

  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);

  return canvas;
}

/**
 * Initialize Three.js scene
 */
function initThreeJS(): void {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const container = canvas.parentElement!;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111111);

  const aspect = container.clientWidth / container.clientHeight;
  camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 1000);
  camera.position.set(30, 35, 30);

  renderer = new THREE.WebGLRenderer({
    canvas: canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
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
  controls.target.set(0, 3, 0);

  // Ground plane
  const planeGeometry = new THREE.PlaneGeometry(200, 200);
  const groundGradientTexture = new THREE.CanvasTexture(createGroundGradientTexture());
  const planeMaterial = new THREE.MeshStandardMaterial({
    map: groundGradientTexture,
    roughness: 1.0,
    metalness: 0.0,
  });
  groundPlane = new THREE.Mesh(planeGeometry, planeMaterial);
  groundPlane.rotation.x = -Math.PI / 2;
  groundPlane.position.y = 0;
  groundPlane.receiveShadow = true;
  scene.add(groundPlane);

  // HDRI environment
  const rgbeLoader = new RGBELoader();
  rgbeLoader.load('/softbox.hdr', function (hdrEquirect) {
    hdrEquirect.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment = hdrEquirect;
  });

  // Lights
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.1);
  scene.add(ambientLight);

  const mainLight = new THREE.DirectionalLight(0xffffff, 3.0);
  mainLight.position.set(-20, 35, -20);
  mainLight.castShadow = true;
  mainLight.shadow.mapSize.width = 1024;
  mainLight.shadow.mapSize.height = 1024;
  mainLight.shadow.camera.near = 0.1;
  mainLight.shadow.camera.far = 200;
  mainLight.shadow.camera.left = -60;
  mainLight.shadow.camera.right = 60;
  mainLight.shadow.camera.top = 60;
  mainLight.shadow.camera.bottom = -60;
  scene.add(mainLight);

  const fillLight = new THREE.DirectionalLight(0xffffff, 1.5);
  fillLight.position.set(20, 25, 20);
  scene.add(fillLight);

  // Handle resize
  window.addEventListener('resize', () => {
    const width = container.clientWidth;
    const height = container.clientHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
  });
}

/**
 * Setup GUI controls
 */
function setupGUI(): void {
  const gui = new GUI({ title: 'Manifold Ring Designer' });

  // Ring dimensions folder
  const ringFolder = gui.addFolder('Ring Dimensions');
  ringFolder
    .add(params, 'innerDiameter', 14, 22, 0.5)
    .name('Inner Diameter (mm)')
    .onChange(() => updateRingMesh());
  ringFolder
    .add(params, 'thickness', 1.5, 5, 0.1)
    .name('Thickness (mm)')
    .onChange(() => updateRingMesh());
  ringFolder
    .add(params, 'width', 3, 12, 0.5)
    .name('Width (mm)')
    .onChange(() => updateRingMesh());
  ringFolder.open();

  // Cross bar folder
  const barFolder = gui.addFolder('Cross Bar');
  barFolder
    .add(params, 'showBar')
    .name('Show Bar')
    .onChange(() => updateRingMesh());
  barFolder
    .add(params, 'barDepth', 0.5, 5, 0.1)
    .name('Thickness (mm)')
    .onChange(() => updateRingMesh());
  barFolder.open();

  // Decoration folder
  const decoFolder = gui.addFolder('Decoration');
  decoFolder
    .add(params, 'waveCount', 0, 16, 1)
    .name('Wave Count')
    .onChange(() => updateRingMesh());
  decoFolder
    .add(params, 'waveAmplitude', 0, 2.5, 0.1)
    .name('Wave Amplitude')
    .onChange(() => updateRingMesh());

  // Quality folder
  const qualityFolder = gui.addFolder('Quality');
  qualityFolder
    .add(params, 'segments', 32, 128, 8)
    .name('Segments')
    .onChange(() => updateRingMesh());

  // Material folder
  const materialFolder = gui.addFolder('Material');
  materialFolder.addColor(params, 'color').name('Color').onChange(updateMaterial);
  materialFolder.add(params, 'wireframe').name('Wireframe').onChange(updateMaterial);

  // Export folder
  const exportFolder = gui.addFolder('Export');
  exportFolder.add({ exportGLB }, 'exportGLB').name('Export GLB');
  exportFolder.add({ exportSTL }, 'exportSTL').name('Export STL');
}

/**
 * Animation loop
 */
function animate(): void {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

/**
 * Initialize Manifold WASM module
 */
async function initManifold(): Promise<void> {
  const loadingText = document.querySelector('.loading-text');
  if (loadingText) loadingText.textContent = 'Loading Manifold WASM...';

  // Set the WASM URL before loading
  setWasmUrl(wasmUrl);

  // Get the manifold module
  wasm = await getManifoldModule();
  Manifold = wasm.Manifold;

  console.log('Manifold WASM loaded');
}

/**
 * Initialize
 */
async function init(): Promise<void> {
  statsElement = document.getElementById('stats')!;

  // Initialize Manifold first
  await initManifold();

  // Then Three.js
  initThreeJS();
  setupGUI();

  // Generate initial ring
  updateRingMesh();

  animate();

  const loading = document.getElementById('loading');
  if (loading) loading.classList.add('hidden');

  console.log('Manifold Ring Demo initialized');
}

// Start
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
