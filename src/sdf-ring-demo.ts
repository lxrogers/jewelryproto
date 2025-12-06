/**
 * SDF Ring Demo
 * Using Signed Distance Functions with Manifold.levelSet() for smooth fillets
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass';
import { TAARenderPass } from 'three/examples/jsm/postprocessing/TAARenderPass';
import { VignetteShader } from 'three/examples/jsm/shaders/VignetteShader';
import GUI from 'lil-gui';
import { setWasmUrl, getManifoldModule } from 'manifold-3d/lib/wasm';

// Import the wasm URL for Vite
import wasmUrl from 'manifold-3d/manifold.wasm?url';

// Manifold types
let wasm: any;
let Manifold: any;
let qualityWorker: Worker | null = null;
let latestQualityJobId = 0;
let lastAppliedQualityJobId = 0;
let latestRequestedQualityJobId = 0;

type QualityJobParams = {
  innerDiameter: number;
  thickness: number;
  width: number;
  edgeFillet: number;
  blendK: number;
  showBar: boolean;
  barDepth: number;
  resolution: number;
};

// Global state
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let renderer: THREE.WebGLRenderer;
let controls: OrbitControls;
let ringMesh: THREE.Mesh | null = null;
let container!: HTMLElement;

// Post-processing
let composer: EffectComposer | null = null;
let smaaPass: SMAAPass | null = null;
let taaPass: TAARenderPass | null = null;
let colorGradingPass: ShaderPass | null = null;
let vignettePass: ShaderPass | null = null;

// Lighting
let ambientLight: THREE.AmbientLight | null = null;
let sideLight: THREE.DirectionalLight | null = null;
let sideLight2: THREE.DirectionalLight | null = null;
let fillLight: THREE.DirectionalLight | null = null;
let pointLights: THREE.PointLight[] = [];
const initialLightPositions = {
  light1: { x: -20, y: 35, z: -20 },
  light2: { x: 20, y: 35, z: -20 },
};
let animateLights = true;
let animationTime = 0;

// Stats display
let statsElement: HTMLElement;
let lastUpdateTime = 0;

// Debounce timer
let updateTimeout: number | null = null;
let qualityTimeout: number | null = null;

// Parameters
const params = {
  // Ring dimensions (mm)
  innerDiameter: 17,
  thickness: 1.9,
  width: 3,

  // Edge fillet (built into ring SDF)
  edgeFillet: 0.5,

  // Cross bar
  showBar: true,
  barDepth: 2.7,

  // Fillet/blend control
  blendK: 0.4,  // Smooth union radius

  // Mesh quality
  responsiveResolution: 0.4,  // fast preview
  qualityResolution: 0.15,    // higher quality pass
  qualityDebounceMs: 50,      // delay before quality pass

  // Material
  wireframe: false,
  goldMaterial: true,
  color: '#FFD700',
  metalness: 1.0,
  roughness: 0.0,
};

// ============ HELPERS ============

function createGroundGradientTexture(size = 1024, middleStop = 0.5, endStop = 0.8, intensity = 0.8): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d')!;

  const centerX = size / 2;
  const centerY = size / 2;
  const maxRadius = size / 2;

  const gradient = context.createRadialGradient(centerX, centerY, 0, centerX, centerY, maxRadius * endStop);

  const white = Math.min(255, 255 * intensity);
  const mediumGray = Math.min(255, 153 * intensity);
  const darkGray = Math.min(255, 102 * intensity);

  gradient.addColorStop(0, `rgb(${white}, ${white}, ${white})`);
  gradient.addColorStop(middleStop, `rgb(${mediumGray}, ${mediumGray}, ${mediumGray})`);
  gradient.addColorStop(1, `rgb(${darkGray}, ${darkGray}, ${darkGray})`);

  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);

  return canvas;
}

// ============ SDF PRIMITIVES ============

/**
 * Smooth minimum - creates filleted unions
 * k = blend/fillet radius
 */
function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/**
 * Ring SDF with rounded edges
 * Creates a torus-like shape with rectangular cross-section and filleted edges
 * This is essentially a 2D rounded rectangle revolved around the Y axis
 */
function sdfRing(
  x: number, y: number, z: number,
  innerDiameter: number, thickness: number, width: number, edgeFillet: number
): number {
  const innerR = innerDiameter / 2;
  const outerR = innerR + thickness;
  const midR = (innerR + outerR) / 2;
  const halfThickness = thickness / 2;
  const halfW = width / 2;

  // Distance from Y axis (center of ring)
  const distToAxis = Math.sqrt(x * x + z * z);

  // Convert to 2D problem: distance from the ring's center circle
  // We're now in 2D space where:
  // - x-coord is (distToAxis - midR) = radial distance from center circle
  // - y-coord is y = vertical distance

  const px = distToAxis - midR;  // radial offset from center of ring band
  const py = y;

  // 2D rounded box SDF
  // The box has half-extents (halfThickness - edgeFillet, halfW - edgeFillet)
  const bx = halfThickness - edgeFillet;
  const by = halfW - edgeFillet;

  const dx = Math.abs(px) - bx;
  const dy = Math.abs(py) - by;

  const outside = Math.sqrt(Math.max(dx, 0) ** 2 + Math.max(dy, 0) ** 2);
  const inside = Math.min(Math.max(dx, dy), 0);

  return outside + inside - edgeFillet;
}

/**
 * Box SDF
 */
function sdfBox(
  px: number, py: number, pz: number,
  cx: number, cy: number, cz: number,
  sx: number, sy: number, sz: number,
  rounding: number = 0
): number {
  const dx = Math.abs(px - cx) - sx + rounding;
  const dy = Math.abs(py - cy) - sy + rounding;
  const dz = Math.abs(pz - cz) - sz + rounding;
  const outside = Math.sqrt(Math.max(dx, 0) ** 2 + Math.max(dy, 0) ** 2 + Math.max(dz, 0) ** 2);
  const inside = Math.min(Math.max(dx, Math.max(dy, dz)), 0);
  return outside + inside - rounding;
}

/**
 * Complete ring SDF with optional bar
 */
function ringWithFeatures(point: number[]): number {
  const [x, y, z] = point;

  // Base ring with filleted edges
  let d = sdfRing(x, y, z,
    params.innerDiameter,
    params.thickness,
    params.width,
    params.edgeFillet
  );

  // Cross bar with smooth blend
  if (params.showBar) {
    const outerR = params.innerDiameter / 2 + params.thickness;
    const barLength = (outerR - params.barDepth / 2) * 2;
    const barD = sdfBox(
      x, y, z,
      0, 0, 0,  // center
      barLength / 2, params.width / 2 - params.edgeFillet, params.barDepth / 2 - params.edgeFillet,
      params.edgeFillet  // rounded edges
    );
    d = smin(d, barD, params.blendK);
  }

  return -d;  // Negate: levelSet expects positive outside, negative inside
}

/**
 * Generate ring geometry using SDF levelSet
 */
function generateRingSDF(resolution: number): THREE.BufferGeometry {
  const t0 = performance.now();
  // Calculate bounding box - needs to be larger than the shape
  // but not too large or levelSet creates boundary artifacts
  const basePad = 0.2;
  const padding = Math.max(basePad, resolution * 2);
  const outerR = params.innerDiameter / 2 + params.thickness + padding;
  const halfH = params.width / 2 + padding;

  const bounds = {
    min: [-outerR, -halfH, -outerR],
    max: [outerR, halfH, outerR]
  };

  console.log('Generating SDF mesh with resolution:', resolution);
  console.log('Bounds:', bounds);

  // Convert SDF to mesh using levelSet
  const ring = Manifold.levelSet(
    ringWithFeatures,
    bounds,
    resolution,
    0  // iso-level (surface at SDF = 0)
  );
  const meshTime = performance.now();

  // Get mesh data
  const mesh = ring.getMesh();
  const extractTime = performance.now();

  console.log('Generated mesh:', mesh.numVert, 'verts,', mesh.numTri, 'tris');
  console.log(
    `Timing -> levelSet: ${(meshTime - t0).toFixed(0)}ms, ` +
    `extract: ${(extractTime - meshTime).toFixed(0)}ms`
  );

  // Convert to Three.js BufferGeometry
  const geoStart = performance.now();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.vertProperties, 3));
  geometry.setIndex(new THREE.BufferAttribute(mesh.triVerts, 1));
  geometry.computeVertexNormals();
  const geoEnd = performance.now();
  console.log(`Timing -> geometry build: ${(geoEnd - geoStart).toFixed(0)}ms`);

  // Clean up
  ring.delete();

  return geometry;
}

function captureQualityParams(): QualityJobParams {
  return {
    innerDiameter: params.innerDiameter,
    thickness: params.thickness,
    width: params.width,
    edgeFillet: params.edgeFillet,
    blendK: params.blendK,
    showBar: params.showBar,
    barDepth: params.barDepth,
    resolution: params.qualityResolution,
  };
}

function paramsEqual(a: QualityJobParams, b: QualityJobParams): boolean {
  return (
    a.innerDiameter === b.innerDiameter &&
    a.thickness === b.thickness &&
    a.width === b.width &&
    a.edgeFillet === b.edgeFillet &&
    a.blendK === b.blendK &&
    a.showBar === b.showBar &&
    a.barDepth === b.barDepth &&
    a.resolution === b.resolution
  );
}

/**
 * Update the ring mesh with debouncing
 */
function updateRingMesh(): void {
  if (!wasm) return;
  if (!qualityWorker) initQualityWorker();

  const requestTime = performance.now();
  console.log(
    `updateRingMesh requested (responsive ${params.responsiveResolution}, quality ${params.qualityResolution})`
  );

  if (updateTimeout) clearTimeout(updateTimeout);
  if (qualityTimeout) clearTimeout(qualityTimeout);

  const runUpdate = (resolution: number, label: 'responsive' | 'quality') => {
    const startTime = performance.now();
    const queueDelay = startTime - requestTime;

    try {
      const geometry = generateRingSDF(resolution);
      const meshReadyTime = performance.now();

      if (ringMesh) {
        ringMesh.geometry.dispose();
        ringMesh.geometry = geometry;
        ringMesh.position.y = params.width / 2;
      } else {
        const material = createMaterial();
        ringMesh = new THREE.Mesh(geometry, material);
        ringMesh.castShadow = true;
        ringMesh.receiveShadow = true;
        ringMesh.position.y = params.width / 2; // lift above ground plane
        scene.add(ringMesh);
      }
      const meshAppliedTime = performance.now();

      lastUpdateTime = performance.now() - startTime;
      updateStats();
      console.log(
        `Update timing [${label}] -> queue: ${queueDelay.toFixed(0)}ms, ` +
        `total: ${lastUpdateTime.toFixed(0)}ms, ` +
        `mesh gen: ${(meshReadyTime - startTime).toFixed(0)}ms, ` +
        `apply: ${(meshAppliedTime - meshReadyTime).toFixed(0)}ms`
      );
    } catch (err) {
      console.error('Error generating SDF mesh:', err);
    }
  };

  // Fast preview on main thread
  runUpdate(params.responsiveResolution, 'responsive');

  // Higher-quality pass in worker with debounce
  qualityTimeout = window.setTimeout(() => {
    latestQualityJobId += 1;
    const jobId = latestQualityJobId;
    latestRequestedQualityJobId = jobId;
    const jobParams = captureQualityParams();
    qualityWorker!.postMessage({
      jobId,
      params: jobParams
    });
  }, params.qualityDebounceMs);
}

/**
 * Create material based on current params
 */
function createMaterial(): THREE.Material {
  if (params.goldMaterial) {
    return new THREE.MeshStandardMaterial({
      color: params.color,
      metalness: params.metalness,
      roughness: params.roughness,
      envMapIntensity: 1.0,
      side: THREE.DoubleSide,
    });
  } else {
    return new THREE.MeshBasicMaterial({
      color: params.color,
      wireframe: params.wireframe,
      side: THREE.DoubleSide,
    });
  }
}

/**
 * Update material properties (recreates material if type changed)
 */
function updateMaterial(): void {
  if (!ringMesh) return;

  // Check if we need to switch material type
  const currentIsStandard = ringMesh.material instanceof THREE.MeshStandardMaterial;
  const needsStandard = params.goldMaterial;

  if (currentIsStandard !== needsStandard) {
    // Need to switch material type
    (ringMesh.material as THREE.Material).dispose();
    ringMesh.material = createMaterial();
  } else if (params.goldMaterial) {
    // Update standard material properties
    const material = ringMesh.material as THREE.MeshStandardMaterial;
    material.color.set(params.color);
    material.metalness = params.metalness;
    material.roughness = params.roughness;
    material.wireframe = params.wireframe;
  } else {
    // Update basic material properties
    const material = ringMesh.material as THREE.MeshBasicMaterial;
    material.color.set(params.color);
    material.wireframe = params.wireframe;
  }
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

  statsElement.textContent = `Vertices: ${vertices.toLocaleString()} | Triangles: ${triangles.toLocaleString()} | Update: ${lastUpdateTime.toFixed(0)}ms`;
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
 * Initialize Three.js scene
 */
function initThreeJS(): void {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  container = canvas.parentElement!;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  const aspect = container.clientWidth / container.clientHeight;
  camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 1000);
  camera.position.set(50, 60, 50);

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
  controls.target.set(0, 0, 0);

  // Load HDRI environment for reflections
  const rgbeLoader = new RGBELoader();
  rgbeLoader.load('/softbox.hdr', (hdrEquirect) => {
    hdrEquirect.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment = hdrEquirect;
    console.log('HDRI environment loaded');
  });

  // Ground plane with radial gradient
  const planeGeometry = new THREE.PlaneGeometry(600, 600);
  const groundGradientTexture = new THREE.CanvasTexture(createGroundGradientTexture(1024, 0.2, 3.0, 0.8));
  groundGradientTexture.needsUpdate = true;
  const planeMaterial = new THREE.MeshStandardMaterial({
    map: groundGradientTexture,
    roughness: 1.0,
    metalness: 0.0,
    envMapIntensity: 0.0,
  });
  const groundPlane = new THREE.Mesh(planeGeometry, planeMaterial);
  groundPlane.rotation.x = -Math.PI / 2;
  groundPlane.position.y = 0;
  groundPlane.receiveShadow = true;
  groundPlane.castShadow = false;
  groundPlane.material.color.setRGB(0.5, 0.5, 0.5);
  scene.add(groundPlane);

  // Lighting (mirrors sun-ring2 setup)
  ambientLight = new THREE.AmbientLight(0xffffff, 0.1);
  scene.add(ambientLight);

  sideLight = new THREE.DirectionalLight(0xffffff, 3.0);
  sideLight.position.set(initialLightPositions.light1.x, initialLightPositions.light1.y, initialLightPositions.light1.z);
  sideLight.castShadow = true;
  sideLight.shadow.mapSize.width = 4096;
  sideLight.shadow.mapSize.height = 4096;
  sideLight.shadow.camera.near = 0.1;
  sideLight.shadow.camera.far = 200;
  sideLight.shadow.camera.left = -60;
  sideLight.shadow.camera.right = 60;
  sideLight.shadow.camera.top = 60;
  sideLight.shadow.camera.bottom = -60;
  sideLight.shadow.bias = -0.0001;
  sideLight.shadow.normalBias = 0.02;
  scene.add(sideLight);

  sideLight2 = new THREE.DirectionalLight(0xffffff, 3.0);
  sideLight2.position.set(initialLightPositions.light2.x, initialLightPositions.light2.y, initialLightPositions.light2.z);
  sideLight2.castShadow = true;
  sideLight2.shadow.mapSize.width = 4096;
  sideLight2.shadow.mapSize.height = 4096;
  sideLight2.shadow.camera.near = 0.1;
  sideLight2.shadow.camera.far = 200;
  sideLight2.shadow.camera.left = -60;
  sideLight2.shadow.camera.right = 60;
  sideLight2.shadow.camera.top = 60;
  sideLight2.shadow.camera.bottom = -60;
  sideLight2.shadow.bias = -0.0001;
  sideLight2.shadow.normalBias = 0.02;
  scene.add(sideLight2);

  fillLight = new THREE.DirectionalLight(0xffffff, 0.4);
  fillLight.position.set(-30, 10, -10);
  scene.add(fillLight);

  const pointLightPositions = [
    { x: 12, y: 15, z: 12 },
    { x: -12, y: 15, z: 12 },
    { x: 0, y: 18, z: 0 },
    { x: 12, y: 12, z: -12 },
    { x: -12, y: 12, z: -12 },
  ];

  pointLightPositions.forEach((pos) => {
    const pointLight = new THREE.PointLight(0xffffff, 3.0, 100);
    pointLight.position.set(pos.x, pos.y, pos.z);
    pointLight.castShadow = false;
    pointLight.decay = 2;
    scene.add(pointLight);
    pointLights.push(pointLight);
  });

  // Post-processing pipeline
  composer = new EffectComposer(renderer);

  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  taaPass = new TAARenderPass(scene, camera);
  taaPass.sampleLevel = 3;
  composer.addPass(taaPass);

  smaaPass = new SMAAPass(
    container.clientWidth * window.devicePixelRatio,
    container.clientHeight * window.devicePixelRatio
  );
  smaaPass.enabled = false;
  composer.addPass(smaaPass);

  const ColorGradingShader = {
    uniforms: {
      tDiffuse: { value: null },
      saturation: { value: 0.85 },
      contrast: { value: 0.9 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision mediump float;
      uniform sampler2D tDiffuse;
      uniform float saturation;
      uniform float contrast;
      varying vec2 vUv;

      vec3 adjustSaturation(vec3 color, float adjustment) {
          vec3 gray = vec3(dot(color, vec3(0.299, 0.587, 0.114)));
          return mix(gray, color, adjustment);
      }

      vec3 adjustContrast(vec3 color, float adjustment) {
          return (color - 0.5) * adjustment + 0.5;
      }

      void main() {
          vec4 color = texture2D(tDiffuse, vUv);
          color.rgb = adjustSaturation(color.rgb, saturation);
          color.rgb = adjustContrast(color.rgb, contrast);
          gl_FragColor = color;
      }
    `,
  };

  colorGradingPass = new ShaderPass(ColorGradingShader);
  composer.addPass(colorGradingPass);

  vignettePass = new ShaderPass(VignetteShader);
  vignettePass.uniforms['darkness'].value = 1.2;
  vignettePass.uniforms['offset'].value = 0.9;
  vignettePass.enabled = false;
  vignettePass.renderToScreen = true;
  composer.addPass(vignettePass);

  // Handle resize
  window.addEventListener('resize', () => {
    const width = container.clientWidth;
    const height = container.clientHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    if (composer) composer.setSize(width, height);
  });
}

/**
 * Setup GUI controls
 */
function setupGUI(): void {
  const gui = new GUI({ title: 'SDF Ring Designer' });

  // Ring dimensions
  const ringFolder = gui.addFolder('Ring Dimensions');
  ringFolder.add(params, 'innerDiameter', 14, 22, 0.5).name('Inner Diameter').onChange(() => updateRingMesh());
  ringFolder.add(params, 'thickness', 1.5, 5, 0.1).name('Thickness').onChange(() => updateRingMesh());
  ringFolder.add(params, 'width', 1, 12, 0.1).name('Width').onChange(() => updateRingMesh());
  ringFolder.open();

  // Fillets
  const filletFolder = gui.addFolder('Fillets');
  filletFolder.add(params, 'edgeFillet', 0.1, 1.5, 0.05).name('Edge Round').onChange(() => updateRingMesh());
  filletFolder.add(params, 'blendK', 0.1, 2.0, 0.05).name('Blend Radius').onChange(() => updateRingMesh());
  filletFolder.open();

  // Cross bar
  const barFolder = gui.addFolder('Cross Bar');
  barFolder.add(params, 'showBar').name('Show Bar').onChange(() => updateRingMesh());
  barFolder.add(params, 'barDepth', 0.5, 5, 0.1).name('Thickness').onChange(() => updateRingMesh());
  barFolder.open();

  // Quality
  const qualityFolder = gui.addFolder('Quality');
  qualityFolder.add(params, 'responsiveResolution', 0.05, 1.0, 0.01).name('Responsive Res').onChange(() => updateRingMesh());
  qualityFolder.add(params, 'qualityResolution', 0.05, 1.0, 0.01).name('Quality Res').onChange(() => updateRingMesh());
  qualityFolder.add(params, 'qualityDebounceMs', 0, 300, 10).name('Quality Debounce (ms)').onChange(() => updateRingMesh());

  // Material
  const materialFolder = gui.addFolder('Material');
  materialFolder.add(params, 'goldMaterial').name('Gold Material').onChange(updateMaterial);
  materialFolder.addColor(params, 'color').name('Color').onChange(updateMaterial);
  materialFolder.add(params, 'metalness', 0, 1, 0.01).name('Metalness').onChange(updateMaterial);
  materialFolder.add(params, 'roughness', 0, 1, 0.01).name('Roughness').onChange(updateMaterial);
  materialFolder.add(params, 'wireframe').name('Wireframe').onChange(updateMaterial);
  materialFolder.open();

  // Export
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

  if (animateLights && sideLight && sideLight2) {
    animationTime += 0.016;
    const angle1 = animationTime;
    sideLight.position.x = initialLightPositions.light1.x + Math.cos(angle1) * 10;
    sideLight.position.z = initialLightPositions.light1.z + Math.sin(angle1) * 10;
    sideLight.position.y = initialLightPositions.light1.y + Math.sin(angle1 * 0.5) * 5;

    const angle2 = animationTime + Math.PI / 4;
    sideLight2.position.x = initialLightPositions.light2.x + Math.cos(angle2) * 10;
    sideLight2.position.z = initialLightPositions.light2.z + Math.sin(angle2) * 10;
    sideLight2.position.y = initialLightPositions.light2.y + Math.sin(angle2 * 0.5) * 5;
  }

  if (composer) {
    composer.render();
  } else {
    renderer.render(scene, camera);
  }
}

/**
 * Initialize Manifold WASM
 */
async function initManifold(): Promise<void> {
  const loadingText = document.querySelector('.loading-text');
  if (loadingText) loadingText.textContent = 'Loading Manifold WASM...';

  setWasmUrl(wasmUrl);
  wasm = await getManifoldModule();
  Manifold = wasm.Manifold;

  console.log('Manifold WASM loaded');
}

function initQualityWorker(): void {
  qualityWorker = new Worker(new URL('./quality-worker.ts', import.meta.url), { type: 'module' });

  qualityWorker.onmessage = (event) => {
    const { jobId, vertices, indices, timings, error, jobParams } = event.data || {};
    if (error) {
      console.error('Quality worker error:', error);
      return;
    }
    // Ignore stale jobs if a newer one was requested or already applied
    if (jobId !== latestRequestedQualityJobId || jobId < lastAppliedQualityJobId) {
      return;
    }
    // Verify params still match current UI state
    if (!jobParams || !paramsEqual(jobParams, captureQualityParams())) {
      return;
    }
    lastAppliedQualityJobId = jobId;

    const meshReadyTime = performance.now();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertices), 3));
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
    geometry.computeVertexNormals();

    if (ringMesh) {
      ringMesh.geometry.dispose();
      ringMesh.geometry = geometry;
      ringMesh.position.y = params.width / 2;
    } else {
      const material = createMaterial();
      ringMesh = new THREE.Mesh(geometry, material);
      ringMesh.castShadow = true;
      ringMesh.receiveShadow = true;
      ringMesh.position.y = params.width / 2;
      scene.add(ringMesh);
    }

    updateStats();
    console.log(
      `Update timing [quality-worker job ${jobId}] -> ` +
      `worker total: ${timings?.total ?? 'n/a'}ms, mesh build main: ${(performance.now() - meshReadyTime).toFixed(0)}ms`
    );
  };
}

/**
 * Initialize
 */
async function init(): Promise<void> {
  statsElement = document.getElementById('stats')!;

  await initManifold();
  initThreeJS();
  setupGUI();
  updateRingMesh();
  animate();

  const loading = document.getElementById('loading');
  if (loading) loading.classList.add('hidden');

  console.log('SDF Ring Demo initialized');
}

// Start
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
