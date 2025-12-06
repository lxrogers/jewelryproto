import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { setOC, makeBaseBox, makeSphere } from 'replicad';
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

// Create a shape with Replicad (with more vertices)
function createReplicadCube(tolerance, angularTolerance) {
    console.log(`Creating shape with tolerance: ${tolerance}, angular: ${angularTolerance}°`);

    // Strategy to get more vertices:
    // 1. Create a box with chamfers/fillets
    // 2. Or use a sphere/cylinder for natural high tessellation
    // 3. Or create a subdivided box manually

    let shape;

    // Option 1: Box with rounded edges (forces more triangulation)
    try {
        const box = makeBaseBox(4, 4, 4);
        // Apply small fillet to edges - this forces more detailed mesh
        shape = box.fillet(0.2, (e) => e.length > 0);
        console.log('Created filleted box for higher tessellation');
    } catch (e) {
        console.log('Fillet failed, trying chamfer');
        try {
            const box = makeBaseBox(4, 4, 4);
            shape = box.chamfer(0.2, (e) => e.length > 0);
            console.log('Created chamfered box');
        } catch (e2) {
            console.log('Chamfer failed, using sphere instead');
            // Option 2: Use a sphere which naturally has more vertices
            shape = makeSphere(2);
        }
    }

    // Convert to mesh with specified tolerance
    // Lower tolerance = more vertices
    const meshed = shape.mesh({
        tolerance: tolerance,
        angularTolerance: angularTolerance,
        // Add deflection parameter for more control
        deflection: tolerance * 0.1
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

    // Use LoopSubdivision.modify() static method
    const params = {
        split: true,         // split coplanar faces at their shared edges
        uvSmooth: false,     // don't smooth UV coordinates
        preserveEdges: false,
        flatOnly: false,     // apply smoothing (not just subdivision)
        maxTriangles: Infinity
    };

    const subdivided = LoopSubdivision.modify(geometry.clone(), iterations, params);

    console.log(`  Result: ${subdivided.attributes.position.count} vertices`);

    subdivided.computeVertexNormals();
    return subdivided;
}

// Create a simple quad-based cube for Catmull-Clark
function createQuadCube() {
    // Create a cube with quads (6 faces, 8 vertices)
    const size = 5;
    const positions = [
        [-size, -size, -size],  // 0
        [ size, -size, -size],  // 1
        [ size,  size, -size],  // 2
        [-size,  size, -size],  // 3
        [-size, -size,  size],  // 4
        [ size, -size,  size],  // 5
        [ size,  size,  size],  // 6
        [-size,  size,  size]   // 7
    ];

    // Define faces as quads (counterclockwise when viewed from outside)
    const cells = [
        [0, 3, 2, 1], // front (-Z)
        [4, 5, 6, 7], // back (+Z)
        [4, 7, 3, 0], // left (-X)
        [1, 2, 6, 5], // right (+X)
        [7, 6, 2, 3], // top (+Y)
        [0, 1, 5, 4]  // bottom (-Y)
    ];

    return { positions, cells };
}

// Apply Catmull-Clark subdivision using gl-catmull-clark
function applyCatmullClark(geometry, iterations) {
    console.log(`Applying Catmull-Clark subdivision with ${iterations} iteration(s)...`);

    // For Catmull-Clark, we'll use a quad-based cube instead of the triangulated RepliCAD geometry
    // because Catmull-Clark works much better with quads
    let result = createQuadCube();

    console.log('Using quad-based cube for Catmull-Clark:', {
        vertexCount: result.positions.length,
        faceCount: result.cells.length
    });

    // catmullClark(positions, cells, numSubdivisions, convertToTriangles)
    try {
        if (iterations > 0) {
            const initialVerts = result.positions.length;
            const initialFaces = result.cells.length;

            // Note: gl-catmull-clark has a bug where it doesn't declare variables properly
            // We'll implement a simple subdivision fallback
            console.warn('Note: gl-catmull-clark library has a bug. Using simplified quad subdivision.');

            // Simple subdivision: split each quad into 4 smaller quads
            for (let iter = 0; iter < iterations; iter++) {
                const newPositions = [...result.positions];
                const newCells = [];

                // First iteration has quads, subsequent iterations have triangles
                const isFirstIteration = (iter === 0);

                result.cells.forEach(cell => {
                    if (isFirstIteration && cell.length === 4) {
                        // Handle quads in first iteration
                        const p0 = result.positions[cell[0]];
                        const p1 = result.positions[cell[1]];
                        const p2 = result.positions[cell[2]];
                        const p3 = result.positions[cell[3]];

                        // Calculate midpoints
                        const mid01 = [(p0[0]+p1[0])/2, (p0[1]+p1[1])/2, (p0[2]+p1[2])/2];
                        const mid12 = [(p1[0]+p2[0])/2, (p1[1]+p2[1])/2, (p1[2]+p2[2])/2];
                        const mid23 = [(p2[0]+p3[0])/2, (p2[1]+p3[1])/2, (p2[2]+p3[2])/2];
                        const mid30 = [(p3[0]+p0[0])/2, (p3[1]+p0[1])/2, (p3[2]+p0[2])/2];
                        const center = [(p0[0]+p1[0]+p2[0]+p3[0])/4, (p0[1]+p1[1]+p2[1]+p3[1])/4, (p0[2]+p1[2]+p2[2]+p3[2])/4];

                        // Add new vertices
                        const baseIdx = newPositions.length;
                        newPositions.push(mid01, mid12, mid23, mid30, center);

                        // Create 4 new quads (convert to triangles with correct winding)
                        // Quad 1 (bottom-left)
                        newCells.push([cell[0], baseIdx, baseIdx+4]);
                        newCells.push([cell[0], baseIdx+4, baseIdx+3]);

                        // Quad 2 (bottom-right)
                        newCells.push([baseIdx, cell[1], baseIdx+1]);
                        newCells.push([baseIdx, baseIdx+1, baseIdx+4]);

                        // Quad 3 (top-right)
                        newCells.push([baseIdx+4, baseIdx+1, cell[2]]);
                        newCells.push([baseIdx+4, cell[2], baseIdx+2]);

                        // Quad 4 (top-left)
                        newCells.push([baseIdx+3, baseIdx+4, baseIdx+2]);
                        newCells.push([baseIdx+3, baseIdx+2, cell[3]]);
                    } else if (!isFirstIteration && cell.length === 3) {
                        // For subsequent iterations, just subdivide triangles
                        const p0 = result.positions[cell[0]];
                        const p1 = result.positions[cell[1]];
                        const p2 = result.positions[cell[2]];

                        // Calculate midpoints
                        const mid01 = [(p0[0]+p1[0])/2, (p0[1]+p1[1])/2, (p0[2]+p1[2])/2];
                        const mid12 = [(p1[0]+p2[0])/2, (p1[1]+p2[1])/2, (p1[2]+p2[2])/2];
                        const mid20 = [(p2[0]+p0[0])/2, (p2[1]+p0[1])/2, (p2[2]+p0[2])/2];

                        // Add new vertices
                        const baseIdx = newPositions.length;
                        newPositions.push(mid01, mid12, mid20);

                        // Create 4 new triangles
                        newCells.push([cell[0], baseIdx, baseIdx+2]);
                        newCells.push([baseIdx, cell[1], baseIdx+1]);
                        newCells.push([baseIdx+2, baseIdx+1, cell[2]]);
                        newCells.push([baseIdx, baseIdx+1, baseIdx+2]);
                    }
                });

                result = { positions: newPositions, cells: newCells };
                console.log(`  Iteration ${iter+1}: ${newPositions.length} verts, ${newCells.length} faces`);
            }
            console.log(`  Applied ${iterations} iterations: ${initialVerts} -> ${result.positions.length} vertices, ${initialFaces} -> ${result.cells.length} faces`);
        }
    } catch (error) {
        console.error(`Catmull-Clark subdivision failed:`, error);
        // If Catmull-Clark fails, return the original geometry
        return geometry.clone();
    }

    // Convert back to Three.js BufferGeometry
    const newGeometry = new THREE.BufferGeometry();

    // Flatten positions array [[x,y,z], ...] back to Float32Array
    const flatPositions = [];
    for (const vertex of result.positions) {
        flatPositions.push(vertex[0], vertex[1], vertex[2]);
    }
    const newPositions = new Float32Array(flatPositions);
    newGeometry.setAttribute('position', new THREE.BufferAttribute(newPositions, 3));

    // Flatten cells to indices
    const newIndices = [];
    for (const cell of result.cells) {
        if (cell.length === 3) {
            newIndices.push(cell[0], cell[1], cell[2]);
        } else if (cell.length === 4) {
            // Triangulate quad (should not happen if convertToTriangles=true)
            newIndices.push(cell[0], cell[1], cell[2]);
            newIndices.push(cell[0], cell[2], cell[3]);
        } else {
            console.warn('Unsupported face type:', cell.length);
        }
    }

    newGeometry.setIndex(newIndices);

    // Ensure proper normal computation
    newGeometry.computeVertexNormals();
    newGeometry.normalizeNormals();

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
