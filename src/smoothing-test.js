import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { setOC, makeBaseBox } from 'replicad';
import opencascade from 'replicad-opencascadejs/src/replicad_single.js';
import opencascadeWasm from 'replicad-opencascadejs/src/replicad_single.wasm?url';
import { LoopSubdivision } from 'three-subdivide';
import catmullClark from 'gl-catmull-clark';

// Scene setup
let scene, camera, renderer, controls;
let currentMeshes = [];
let wireframeEnabled = false;

// Geometry storage
let originalGeometry = null;
let loopGeometry = null;
let catmullGeometry = null;

// Parameters
let params = {
    tolerance: 0.01,
    angularTolerance: 10,
    iterations: 1,
    displayMethod: 'original'
};

// Initialize Three.js scene
function initScene() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a1a);

    // Camera
    camera = new THREE.PerspectiveCamera(
        50,
        window.innerWidth / window.innerHeight,
        0.1,
        1000
    );
    camera.position.set(8, 6, 8);

    // Renderer
    renderer = new THREE.WebGLRenderer({
        canvas: document.getElementById('canvas'),
        antialias: true
    });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // Controls
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.target.set(0, 0, 0);

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
    directionalLight.position.set(5, 10, 5);
    directionalLight.castShadow = true;
    directionalLight.shadow.mapSize.width = 2048;
    directionalLight.shadow.mapSize.height = 2048;
    scene.add(directionalLight);

    const directionalLight2 = new THREE.DirectionalLight(0x4488ff, 0.3);
    directionalLight2.position.set(-5, 5, -5);
    scene.add(directionalLight2);

    // Grid
    const gridHelper = new THREE.GridHelper(20, 20, 0x444444, 0x222222);
    gridHelper.position.y = -2;
    scene.add(gridHelper);

    // Window resize
    window.addEventListener('resize', onWindowResize, false);
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// Initialize Replicad
async function initializeReplicad() {
    console.log('Initializing Replicad...');
    const OC = await opencascade({
        locateFile: () => opencascadeWasm,
    });
    setOC(OC);
    console.log('Replicad initialized!');
}

// Create a cube with Replicad
function createReplicadCube(tolerance, angularTolerance) {
    console.log(`Creating cube with tolerance: ${tolerance}, angular: ${angularTolerance}°`);

    // Create a simple box
    const box = makeBaseBox(4, 4, 4);

    // Convert to mesh with specified tolerance
    const meshed = box.mesh({
        tolerance: tolerance,
        angularTolerance: angularTolerance
    });

    console.log(`Replicad mesh created: ${meshed.vertices.length / 3} vertices, ${meshed.triangles.length / 3} faces`);

    // Convert to Three.js BufferGeometry
    const vertices = new Float32Array(meshed.vertices);
    const indices = new Uint32Array(meshed.triangles);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();

    return geometry;
}

// Apply Loop subdivision using three-subdivide
function applyLoopSubdivision(geometry, iterations) {
    console.log(`Applying Loop subdivision with ${iterations} iteration(s)...`);

    let subdivided = geometry.clone();

    for (let i = 0; i < iterations; i++) {
        subdivided = LoopSubdivision(subdivided);
        console.log(`  Iteration ${i + 1}: ${subdivided.attributes.position.count} vertices`);
    }

    subdivided.computeVertexNormals();
    return subdivided;
}

// Apply Catmull-Clark subdivision using gl-catmull-clark
function applyCatmullClark(geometry, iterations) {
    console.log(`Applying Catmull-Clark subdivision with ${iterations} iteration(s)...`);

    // Convert Three.js geometry to the format expected by gl-catmull-clark
    const positions = geometry.attributes.position.array;
    const indices = geometry.index ? geometry.index.array : null;

    if (!indices) {
        console.error('Geometry must be indexed for Catmull-Clark subdivision');
        return geometry.clone();
    }

    // gl-catmull-clark expects: { positions: Float32Array, cells: array of face indices }
    // Convert from flat index array to cells (faces)
    const cells = [];
    for (let i = 0; i < indices.length; i += 3) {
        cells.push([indices[i], indices[i + 1], indices[i + 2]]);
    }

    let result = {
        positions: Array.from(positions),
        cells: cells
    };

    // Apply subdivision iterations
    for (let i = 0; i < iterations; i++) {
        try {
            result = catmullClark(result.positions, result.cells);
            console.log(`  Iteration ${i + 1}: ${result.positions.length / 3} vertices, ${result.cells.length} faces`);
        } catch (error) {
            console.error(`Catmull-Clark iteration ${i + 1} failed:`, error);
            break;
        }
    }

    // Convert back to Three.js BufferGeometry
    const newGeometry = new THREE.BufferGeometry();

    // Flatten positions
    const newPositions = new Float32Array(result.positions.flat ? result.positions.flat() : result.positions);
    newGeometry.setAttribute('position', new THREE.BufferAttribute(newPositions, 3));

    // Flatten cells to indices
    const newIndices = [];
    for (const cell of result.cells) {
        if (cell.length === 3) {
            newIndices.push(cell[0], cell[1], cell[2]);
        } else if (cell.length === 4) {
            // Triangulate quad
            newIndices.push(cell[0], cell[1], cell[2]);
            newIndices.push(cell[0], cell[2], cell[3]);
        } else {
            console.warn('Unsupported face type:', cell.length);
        }
    }

    newGeometry.setIndex(newIndices);
    newGeometry.computeVertexNormals();

    return newGeometry;
}

// Create material
function createMaterial(color = 0x4CAF50) {
    return new THREE.MeshStandardMaterial({
        color: color,
        metalness: 0.3,
        roughness: 0.4,
        wireframe: wireframeEnabled,
        flatShading: false
    });
}

// Display meshes based on current display method
function displayMeshes() {
    // Clear existing meshes
    currentMeshes.forEach(mesh => scene.remove(mesh));
    currentMeshes = [];

    const method = params.displayMethod;

    if (method === 'compare') {
        // Side-by-side comparison
        if (originalGeometry) {
            const mesh1 = new THREE.Mesh(originalGeometry, createMaterial(0x2196F3));
            mesh1.position.x = -5;
            mesh1.castShadow = true;
            scene.add(mesh1);
            currentMeshes.push(mesh1);
        }

        if (loopGeometry) {
            const mesh2 = new THREE.Mesh(loopGeometry, createMaterial(0x4CAF50));
            mesh2.position.x = 0;
            mesh2.castShadow = true;
            scene.add(mesh2);
            currentMeshes.push(mesh2);
        }

        if (catmullGeometry) {
            const mesh3 = new THREE.Mesh(catmullGeometry, createMaterial(0xFF9800));
            mesh3.position.x = 5;
            mesh3.castShadow = true;
            scene.add(mesh3);
            currentMeshes.push(mesh3);
        }
    } else {
        // Single mesh display
        let geometry = null;
        let color = 0x4CAF50;

        if (method === 'original' && originalGeometry) {
            geometry = originalGeometry;
            color = 0x2196F3;
        } else if (method === 'loop' && loopGeometry) {
            geometry = loopGeometry;
            color = 0x4CAF50;
        } else if (method === 'catmull' && catmullGeometry) {
            geometry = catmullGeometry;
            color = 0xFF9800;
        }

        if (geometry) {
            const mesh = new THREE.Mesh(geometry, createMaterial(color));
            mesh.castShadow = true;
            scene.add(mesh);
            currentMeshes.push(mesh);
        }
    }

    updateMethodInfo();
}

// Update method info panel
function updateMethodInfo() {
    const methodInfoEl = document.getElementById('methodInfo');
    const method = params.displayMethod;

    const infos = {
        original: {
            title: 'Original Mesh',
            desc: 'Directly from Replicad with specified tolerance settings. Lower tolerance = more triangles.'
        },
        loop: {
            title: 'Loop Subdivision',
            desc: 'Loop algorithm (Charles Loop, 1987) optimized for triangle meshes. Smooths by splitting edges and averaging vertices.'
        },
        catmull: {
            title: 'Catmull-Clark Subdivision',
            desc: 'Catmull-Clark algorithm (1978) creates smooth surfaces from polygonal meshes. Generates quad faces.'
        },
        compare: {
            title: 'Side-by-Side Comparison',
            desc: 'Blue = Original, Green = Loop, Orange = Catmull-Clark'
        }
    };

    const info = infos[method] || infos.original;
    methodInfoEl.innerHTML = `<strong>${info.title}</strong><br>${info.desc}`;
}

// Update stats display
function updateStats() {
    const originalVerts = originalGeometry ? originalGeometry.attributes.position.count : 0;
    const loopVerts = loopGeometry ? loopGeometry.attributes.position.count : 0;
    const catmullVerts = catmullGeometry ? catmullGeometry.attributes.position.count : 0;

    document.getElementById('original-verts').textContent = `${originalVerts} verts`;
    document.getElementById('loop-verts').textContent = `${loopVerts} verts`;
    document.getElementById('catmull-verts').textContent = `${catmullVerts} verts`;
}

// Generate all geometries
async function generateGeometries() {
    console.log('=== Generating geometries ===');

    // Create original from Replicad
    originalGeometry = createReplicadCube(params.tolerance, params.angularTolerance);

    // Apply Loop subdivision
    if (params.iterations > 0) {
        loopGeometry = applyLoopSubdivision(originalGeometry, params.iterations);
    } else {
        loopGeometry = originalGeometry.clone();
    }

    // Apply Catmull-Clark subdivision
    if (params.iterations > 0) {
        catmullGeometry = applyCatmullClark(originalGeometry, params.iterations);
    } else {
        catmullGeometry = originalGeometry.clone();
    }

    console.log('=== Generation complete ===');

    updateStats();
    displayMeshes();
}

// Setup UI controls
function setupControls() {
    // Display method
    const displayMethodEl = document.getElementById('displayMethod');
    displayMethodEl.addEventListener('change', (e) => {
        params.displayMethod = e.target.value;
        displayMeshes();
    });

    // Iterations
    const iterationsEl = document.getElementById('iterations');
    const iterationsValueEl = document.getElementById('iterations-value');
    iterationsEl.addEventListener('input', (e) => {
        params.iterations = parseInt(e.target.value);
        iterationsValueEl.textContent = params.iterations;
    });

    // Tolerance
    const toleranceEl = document.getElementById('tolerance');
    const toleranceValueEl = document.getElementById('tolerance-value');
    toleranceEl.addEventListener('input', (e) => {
        params.tolerance = parseFloat(e.target.value);
        toleranceValueEl.textContent = params.tolerance.toFixed(3);
    });

    // Angular tolerance
    const angularToleranceEl = document.getElementById('angularTolerance');
    const angularToleranceValueEl = document.getElementById('angularTolerance-value');
    angularToleranceEl.addEventListener('input', (e) => {
        params.angularTolerance = parseInt(e.target.value);
        angularToleranceValueEl.textContent = params.angularTolerance + '°';
    });

    // Regenerate button
    document.getElementById('regenerate').addEventListener('click', async () => {
        document.getElementById('loading').classList.remove('hidden');
        await new Promise(resolve => setTimeout(resolve, 100)); // Allow UI to update
        await generateGeometries();
        document.getElementById('loading').classList.add('hidden');
    });

    // Wireframe toggle
    document.getElementById('toggleWireframe').addEventListener('click', () => {
        wireframeEnabled = !wireframeEnabled;
        currentMeshes.forEach(mesh => {
            mesh.material.wireframe = wireframeEnabled;
        });
    });
}

// Animation loop
function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
}

// Main initialization
async function init() {
    console.log('Starting initialization...');

    initScene();
    setupControls();

    await initializeReplicad();
    await generateGeometries();

    document.getElementById('loading').classList.add('hidden');

    animate();

    console.log('Initialization complete!');
}

// Start the application
init().catch(error => {
    console.error('Initialization failed:', error);
    document.querySelector('.loading-text').textContent = 'Error: ' + error.message;
});
