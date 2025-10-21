import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader';
import { setOC, makeCylinder } from 'replicad';
import opencascade from 'replicad-opencascadejs/src/replicad_single.js';
import opencascadeWasm from 'replicad-opencascadejs/src/replicad_single.wasm?url';

// Global variables
let scene, camera, renderer, controls;
let ringMesh = null;
let helperMesh = null;  // Helper mesh for depth occlusion
let groundPlane = null;  // Ground plane for shadows
let contactShadow = null;  // Soft shadow where ring touches ground
let ringMaterial = null;
let wireframeMaterial = null;
let helperMaterial = null;
let isInitialized = false;
let updateTimeout = null;
let qualityUpdateTimeout = null;
let isDragging = false;
let isPreviewMode = false;

// Light references for dynamic control
let ambientLight = null;
let sideLight = null;
let sideLight2 = null;  // Second directional light
let fillLight = null;
let pointLights = [];  // Array of point lights for soft shadows
let hdrEnvironment = null;  // Store the HDRI texture
let environmentIntensity = 1.0;  // Store environment intensity

// Animation settings
let animateLights = true;  // Start with animation on
let animationSpeed = 0.1;  // Start with slow animation
let animationTime = 0;
let initialLightPositions = {
    light1: { x: -20, y: 35, z: -20 },  // Behind and to the left
    light2: { x: 20, y: 35, z: -20 }    // Behind and to the right
};

// Preview style settings (optimized for dark theme)
let previewSettings = {
    ghostOpacity: 0.3,      // User's preferred opacity
    ghostColor: 0x000000,   // Black ghost
    wireColor: 0x000000     // Black wireframe
};

// Mesh quality settings
let meshQuality = 4;  // Default to "High" (1-5 scale)
const qualityPresets = {
    1: { tolerance: 0.1, angularTolerance: 30, name: 'Draft' },
    2: { tolerance: 0.05, angularTolerance: 20, name: 'Low' },
    3: { tolerance: 0.01, angularTolerance: 15, name: 'Medium' },
    4: { tolerance: 0.005, angularTolerance: 8, name: 'High' },
    5: { tolerance: 0.002, angularTolerance: 5, name: 'Ultra' }
};

// Create a soft gradient texture for contact shadow
function createContactShadowTexture(size = 512) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');

    // Create radial gradient - dark in center, transparent at edges
    const gradient = context.createRadialGradient(
        size / 2, size / 2, 0,  // Center point
        size / 2, size / 2, size / 2  // Outer radius
    );

    // Dark center that fades to transparent
    gradient.addColorStop(0, 'rgba(0, 0, 0, 1)');     // Solid black at center
    gradient.addColorStop(0.4, 'rgba(0, 0, 0, 0.5)'); // Semi-transparent
    gradient.addColorStop(0.7, 'rgba(0, 0, 0, 0.1)'); // Very light
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');     // Fully transparent at edges

    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);

    return canvas;
}

// Initialize RepliCAD
async function initializeReplicad() {
    try {
        const OC = await opencascade({
            locateFile: () => opencascadeWasm,
        });

        setOC(OC);
        isInitialized = true;
        console.log('RepliCAD initialized successfully');
    } catch (error) {
        console.error('Failed to initialize RepliCAD:', error);
    }
}

// Create fast preview ring (no fillets, simple geometry)
async function createPreviewRing(params) {
    const { outerDiameter, innerDiameter, height } = params;

    // Validate parameters
    const outerRadius = outerDiameter / 2;
    const innerRadius = innerDiameter / 2;

    if (innerRadius >= outerRadius - 0.5) {
        throw new Error('Inner diameter must be at least 1mm smaller than outer diameter');
    }

    try {
        // Create outer cylinder
        const outerCylinder = makeCylinder(outerRadius, height);

        // Create inner cylinder for the hole
        const innerCylinder = makeCylinder(innerRadius, height);

        // Subtract inner from outer to create the ring - NO FILLETS for speed
        const ring = outerCylinder.cut(innerCylinder);

        return ring;
    } catch (error) {
        console.error('Error creating preview ring:', error);
        throw error;
    }
}

// Create high-quality ring model with fillets
async function createHighQualityRing(params) {
    const { outerDiameter, innerDiameter, height, filletRadius } = params;

    // Validate parameters
    const outerRadius = outerDiameter / 2;
    const innerRadius = innerDiameter / 2;

    if (innerRadius >= outerRadius - 0.5) {
        throw new Error('Inner diameter must be at least 1mm smaller than outer diameter');
    }

    if (filletRadius > (outerRadius - innerRadius) / 2) {
        throw new Error('Fillet radius is too large for the ring width');
    }

    try {
        // Create outer cylinder
        const outerCylinder = makeCylinder(outerRadius, height);

        // Create inner cylinder for the hole
        const innerCylinder = makeCylinder(innerRadius, height);

        // Subtract inner from outer to create the ring
        let ring = outerCylinder.cut(innerCylinder);

        // Apply fillets to the edges (skip if radius is very small for performance)
        if (filletRadius > 0.1) {
            try {
                // Try to apply fillets to all edges
                ring = ring.fillet(filletRadius);
            } catch (filletError) {
                console.warn('Could not apply fillets:', filletError);
                // Try chamfer as alternative
                try {
                    ring = ring.chamfer(filletRadius);
                    console.log('Applied chamfer instead of fillet');
                } catch (chamferError) {
                    console.warn('Could not apply chamfer either:', chamferError);
                }
            }
        }

        return ring;
    } catch (error) {
        console.error('Error creating high-quality ring:', error);
        throw error;
    }
}

// Initialize Three.js scene
function initThreeJS() {
    const canvas = document.getElementById('canvas');
    const container = canvas.parentElement;

    // Scene setup with pure black background
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);  // Pure black

    // Camera setup - positioned for better view of flat ring
    const aspect = container.clientWidth / container.clientHeight;
    camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 1000);
    camera.position.set(30, 40, 30);  // Higher and closer for flat ring view

    // Renderer setup with enhanced quality
    renderer = new THREE.WebGLRenderer({
        canvas: canvas,
        antialias: true,
        powerPreference: "high-performance"
    });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);  // Use device pixel ratio for sharper rendering
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;  // Updated to match user's preferred setting
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    // Controls
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.target.set(0, 0, 0);

    // Add ground plane - white surface for the ring to sit on
    const planeGeometry = new THREE.PlaneGeometry(200, 200);
    const planeMaterial = new THREE.MeshStandardMaterial({
        color: new THREE.Color(0.4, 0.4, 0.4),  // User's preferred ground brightness
        roughness: 1.0,       // Fully matte/diffuse surface
        metalness: 0.0,       // No metallic reflection
        envMapIntensity: 0.0  // No environment reflections on ground
    });
    groundPlane = new THREE.Mesh(planeGeometry, planeMaterial);
    groundPlane.rotation.x = -Math.PI / 2;  // Rotate to horizontal
    groundPlane.position.y = -10;  // Position just below the ring when it's at y=0
    groundPlane.receiveShadow = true;
    groundPlane.castShadow = false;  // Ground shouldn't cast shadows
    scene.add(groundPlane);

    // Load HDRI environment map
    const rgbeLoader = new RGBELoader();
    rgbeLoader.load('/softbox.hdr', function(hdrEquirect) {
        hdrEquirect.mapping = THREE.EquirectangularReflectionMapping;

        // Store the environment texture
        hdrEnvironment = hdrEquirect;

        // Check the current environment intensity setting before applying
        const envSlider = document.getElementById('envIntensity');
        const currentEnvIntensity = envSlider ? parseFloat(envSlider.value) : 1.0;

        // Only set as environment if intensity is not 0
        if (currentEnvIntensity > 0) {
            scene.environment = hdrEquirect;
        }

        // Optionally use as background too (comment out for black background)
        // scene.background = hdrEquirect;

        console.log('HDRI environment loaded, intensity:', currentEnvIntensity);
    });

    // Add very minimal ambient light for base visibility
    ambientLight = new THREE.AmbientLight(0xffffff, 0.1);  // Reduced from 0.3
    scene.add(ambientLight);

    // First directional light - from behind left
    sideLight = new THREE.DirectionalLight(0xffffff, 3.0);  // Set to user's preferred intensity
    sideLight.position.set(-20, 35, -20);  // Behind and to the left, casting shadows forward
    sideLight.castShadow = true;
    sideLight.shadow.mapSize.width = 4096;  // Higher resolution shadows
    sideLight.shadow.mapSize.height = 4096;
    sideLight.shadow.camera.near = 0.1;
    sideLight.shadow.camera.far = 100;
    sideLight.shadow.camera.left = -30;
    sideLight.shadow.camera.right = 30;
    sideLight.shadow.camera.top = 30;
    sideLight.shadow.camera.bottom = -30;
    sideLight.shadow.bias = -0.0001;  // Adjusted for better shadow accuracy
    sideLight.shadow.normalBias = 0.02;  // Help prevent shadow acne
    scene.add(sideLight);

    // Second directional light - from behind right
    sideLight2 = new THREE.DirectionalLight(0xffffff, 3.0);  // Set to user's preferred intensity
    sideLight2.position.set(20, 35, -20);  // Behind and to the right, casting shadows forward
    sideLight2.castShadow = true;
    sideLight2.shadow.mapSize.width = 4096;  // Higher resolution shadows
    sideLight2.shadow.mapSize.height = 4096;
    sideLight2.shadow.camera.near = 0.1;
    sideLight2.shadow.camera.far = 100;
    sideLight2.shadow.camera.left = -30;
    sideLight2.shadow.camera.right = 30;
    sideLight2.shadow.camera.top = 30;
    sideLight2.shadow.camera.bottom = -30;
    sideLight2.shadow.bias = -0.0001;
    sideLight2.shadow.normalBias = 0.02;
    scene.add(sideLight2);

    // Very subtle fill light from opposite side
    fillLight = new THREE.DirectionalLight(0xffffff, 0.4);  // Set to user's preferred intensity
    fillLight.position.set(-30, 10, -10);
    scene.add(fillLight);

    // Add point lights around the ring for softer, more diffused shadows
    // These simulate studio softbox lighting - positioned closer and stronger
    const pointLightPositions = [
        { x: 12, y: 15, z: 12 },   // Front right (closer)
        { x: -12, y: 15, z: 12 },  // Front left (closer)
        { x: 0, y: 18, z: 0 },     // Directly above (closer)
        { x: 12, y: 12, z: -12 },  // Back right (closer)
        { x: -12, y: 12, z: -12 }  // Back left (closer)
    ];

    pointLightPositions.forEach((pos, index) => {
        const pointLight = new THREE.PointLight(0xffffff, 3.0, 100);  // Much stronger intensity, wider range
        pointLight.position.set(pos.x, pos.y, pos.z);
        pointLight.castShadow = false;  // Disable shadows for performance - just fill light
        pointLight.decay = 2;  // Physically accurate light falloff
        scene.add(pointLight);
        pointLights.push(pointLight);

        // Add a visual helper to see where lights are positioned (optional)
        // const helper = new THREE.PointLightHelper(pointLight, 1);
        // scene.add(helper);
    });

    console.log(`Added ${pointLights.length} point lights for soft shadows`);

    // Handle window resize
    window.addEventListener('resize', () => {
        const width = container.clientWidth;
        const height = container.clientHeight;

        camera.aspect = width / height;
        camera.updateProjectionMatrix();

        renderer.setSize(width, height);
    });

    // Start animation loop
    animate();
}

// Animation loop
function animate() {
    requestAnimationFrame(animate);
    controls.update();

    // Animate lights if enabled
    if (animateLights && sideLight && sideLight2) {
        animationTime += 0.016 * animationSpeed;  // ~60fps, scaled by speed

        // Create circular motion using sine/cosine
        const radius = 25;  // Radius of circular motion

        // First light - circular motion
        const angle1 = animationTime;
        sideLight.position.x = initialLightPositions.light1.x + Math.cos(angle1) * 10;
        sideLight.position.z = initialLightPositions.light1.z + Math.sin(angle1) * 10;
        sideLight.position.y = initialLightPositions.light1.y + Math.sin(angle1 * 0.5) * 5;  // Subtle vertical movement

        // Second light - offset circular motion
        const angle2 = animationTime + Math.PI / 4;  // 45 degree offset
        sideLight2.position.x = initialLightPositions.light2.x + Math.cos(angle2) * 10;
        sideLight2.position.z = initialLightPositions.light2.z + Math.sin(angle2) * 10;
        sideLight2.position.y = initialLightPositions.light2.y + Math.sin(angle2 * 0.5) * 5;  // Subtle vertical movement
    }

    renderer.render(scene, camera);
}

// Update ring geometry with quality mode
async function updateRing(params, usePreview = false) {
    const startTime = performance.now();
    const mode = usePreview ? 'PREVIEW' : 'HIGH-QUALITY';
    console.log(`=== Starting ${mode} ring update ===`);

    try {
        // Only show loading for high-quality updates
        if (!usePreview) {
            document.getElementById('loading').classList.remove('hidden');
        }

        // Create ring based on quality mode
        const ringStartTime = performance.now();
        const ring = usePreview
            ? await createPreviewRing(params)
            : await createHighQualityRing(params);
        const ringCreationTime = performance.now() - ringStartTime;
        console.log(`Ring creation (${mode}): ${ringCreationTime.toFixed(2)}ms`);

        // Mesh the shape for Three.js with quality-appropriate settings
        const meshStartTime = performance.now();
        const preset = qualityPresets[meshQuality];
        const meshed = ring.mesh({
            tolerance: usePreview ? 0.3 : preset.tolerance,
            angularTolerance: usePreview ? 60 : preset.angularTolerance
        });
        const meshTime = performance.now() - meshStartTime;
        console.log(`Meshing (${mode}): ${meshTime.toFixed(2)}ms`);

        // Convert to Three.js geometry
        const conversionStartTime = performance.now();
        const vertices = new Float32Array(meshed.vertices);
        const indices = new Uint32Array(meshed.triangles);

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
        geometry.setIndex(new THREE.BufferAttribute(indices, 1));
        geometry.computeVertexNormals();

        // Log polygon count
        const vertexCount = vertices.length / 3;
        const triangleCount = indices.length / 3;
        console.log(`Mesh stats - Vertices: ${vertexCount}, Triangles: ${triangleCount}`);

        const conversionTime = performance.now() - conversionStartTime;
        console.log(`Three.js conversion: ${conversionTime.toFixed(2)}ms`);

        // Create or update mesh
        if (!ringMesh) {
            // Create materials on first run
            // Gold material - matching the reference project
            ringMaterial = new THREE.MeshStandardMaterial({
                color: 0xf0e68c,      // Gold color (khaki/gold)
                metalness: 1.0,       // Full metallic
                roughness: 0.0,       // Mirror-like finish
                envMapIntensity: 0.5, // Environment map influence
                side: THREE.DoubleSide,
                flatShading: false    // Explicitly enable smooth shading
            });

            // Wireframe material for preview
            wireframeMaterial = new THREE.MeshBasicMaterial({
                color: previewSettings.wireColor,
                wireframe: true,
                wireframeLinewidth: 2,   // Thicker lines for more drama
                side: THREE.DoubleSide
            });

            // Helper material - more dramatic depth occlusion
            helperMaterial = new THREE.MeshBasicMaterial({
                color: previewSettings.ghostColor,
                transparent: true,
                opacity: previewSettings.ghostOpacity,
                side: THREE.DoubleSide,
                depthWrite: true      // Writes to depth buffer
            });

            // Create main mesh
            ringMesh = new THREE.Mesh(geometry, ringMaterial);
            ringMesh.rotation.x = Math.PI / 2;  // Rotate 90 degrees to lay flat
            ringMesh.position.y = -4.0;  // User's preferred ring height
            ringMesh.castShadow = true;
            ringMesh.receiveShadow = true;
            scene.add(ringMesh);

            // Create helper mesh (clone of geometry)
            helperMesh = new THREE.Mesh(geometry.clone(), helperMaterial);
            helperMesh.rotation.x = Math.PI / 2;  // Match ring rotation
            helperMesh.position.y = -4.0;  // Match ring position with user's preference
            helperMesh.visible = false;  // Initially hidden
            scene.add(helperMesh);
        } else {
            // Update existing geometry
            ringMesh.geometry.dispose();
            ringMesh.geometry = geometry;

            // Update helper mesh geometry
            if (helperMesh) {
                helperMesh.geometry.dispose();
                helperMesh.geometry = geometry.clone();
            }
        }

        // Switch material and settings based on preview mode
        if (usePreview) {
            // Preview mode: wireframe with helper
            ringMesh.material = wireframeMaterial;
            ringMesh.castShadow = false;
            ringMesh.receiveShadow = false;
            ringMesh.renderOrder = 1;  // Render wireframe on top

            // Show helper mesh for depth
            if (helperMesh) {
                helperMesh.visible = true;
                helperMesh.renderOrder = 0;  // Render helper first
            }
        } else {
            // High-quality mode: solid mesh only
            ringMesh.material = ringMaterial;
            ringMesh.castShadow = true;
            ringMesh.receiveShadow = true;
            ringMesh.renderOrder = 0;

            // Hide helper mesh
            if (helperMesh) {
                helperMesh.visible = false;
            }
        }

        // Update info panel
        const totalTime = performance.now() - startTime;
        updateInfoPanel(params, totalTime);

        console.log(`TOTAL ${mode} TIME: ${totalTime.toFixed(2)}ms`);
        console.log(`=== ${mode} update complete ===\n`);

        // Store the preview state
        isPreviewMode = usePreview;

    } catch (error) {
        console.error('Error updating ring:', error);
        alert('Error: ' + error.message);
    } finally {
        // Hide loading
        if (!usePreview) {
            document.getElementById('loading').classList.add('hidden');
        }
    }
}

// Update info panel
function updateInfoPanel(params, updateTime) {
    const width = (params.outerDiameter - params.innerDiameter) / 2;
    document.getElementById('width-info').textContent = width.toFixed(1) + ' mm';

    // Approximate US ring size based on inner diameter
    const circumference = Math.PI * params.innerDiameter;
    const usSize = (circumference - 38.0) / 2.5 + 1;
    document.getElementById('size-info').textContent = '~' + usSize.toFixed(1);

    // Update time
    document.getElementById('update-time').textContent = updateTime.toFixed(0) + ' ms';

    // Volume would need to be calculated from the actual geometry
    // For now, approximate volume
    const outerVolume = Math.PI * Math.pow(params.outerDiameter/2, 2) * params.height;
    const innerVolume = Math.PI * Math.pow(params.innerDiameter/2, 2) * params.height;
    const volume = (outerVolume - innerVolume) / 1000; // Convert to cm³
    document.getElementById('volume-info').textContent = volume.toFixed(2) + ' cm³';
}

// Get current parameters from sliders
function getCurrentParams() {
    return {
        outerDiameter: parseFloat(document.getElementById('outerDiameter').value),
        innerDiameter: parseFloat(document.getElementById('innerDiameter').value),
        height: parseFloat(document.getElementById('height').value),
        filletRadius: parseFloat(document.getElementById('filletRadius').value)
    };
}

// Instant preview update (no debounce)
function instantPreviewUpdate() {
    if (isInitialized) {
        // Cancel any pending quality updates
        if (qualityUpdateTimeout) {
            clearTimeout(qualityUpdateTimeout);
        }

        // Do instant preview update
        updateRing(getCurrentParams(), true);  // true = use preview mode

        // Schedule high-quality update after delay
        qualityUpdateTimeout = setTimeout(() => {
            if (isInitialized) {
                console.log('Triggering high-quality update...');
                updateRing(getCurrentParams(), false);  // false = high quality
            }
        }, 300); // 300ms delay for high-quality update
    }
}

// Legacy debounced update function (kept for compatibility)
function debouncedUpdate() {
    instantPreviewUpdate();
}

// Update preview style materials
function updatePreviewStyle() {
    if (wireframeMaterial) {
        wireframeMaterial.color.setHex(previewSettings.wireColor);
        wireframeMaterial.needsUpdate = true;
    }

    if (helperMaterial) {
        helperMaterial.color.setHex(previewSettings.ghostColor);
        helperMaterial.opacity = previewSettings.ghostOpacity;
        helperMaterial.needsUpdate = true;
    }

    // Force re-render if in preview mode
    if (isPreviewMode && renderer) {
        renderer.render(scene, camera);
    }
}

// Setup slider event listeners
function setupSliderListeners() {
    const sliders = ['outerDiameter', 'innerDiameter', 'height', 'filletRadius'];

    sliders.forEach(sliderId => {
        const slider = document.getElementById(sliderId);
        const valueDisplay = document.getElementById(sliderId + '-value');

        slider.addEventListener('input', (e) => {
            valueDisplay.textContent = e.target.value;
            instantPreviewUpdate();  // Instant preview on every change
        });
    });

    // Preview style controls
    const ghostOpacitySlider = document.getElementById('ghostOpacity');
    if (ghostOpacitySlider) {
        ghostOpacitySlider.addEventListener('input', (e) => {
            const value = parseFloat(e.target.value);
            document.getElementById('ghostOpacity-value').textContent = value.toFixed(2);
            previewSettings.ghostOpacity = value;
            updatePreviewStyle();
        });
        // Set initial value
        ghostOpacitySlider.value = previewSettings.ghostOpacity;
        document.getElementById('ghostOpacity-value').textContent = previewSettings.ghostOpacity.toFixed(2);
    }

    const ghostColorPicker = document.getElementById('ghostColor');
    if (ghostColorPicker) {
        ghostColorPicker.addEventListener('input', (e) => {
            const hexColor = e.target.value;
            document.getElementById('ghostColor-value').textContent = hexColor;
            previewSettings.ghostColor = parseInt(hexColor.replace('#', '0x'));
            updatePreviewStyle();
        });
        // Set initial value
        const initialGhostHex = '#' + previewSettings.ghostColor.toString(16).padStart(6, '0');
        ghostColorPicker.value = initialGhostHex;
        document.getElementById('ghostColor-value').textContent = initialGhostHex;
    }

    const wireColorPicker = document.getElementById('wireColor');
    if (wireColorPicker) {
        wireColorPicker.addEventListener('input', (e) => {
            const hexColor = e.target.value;
            document.getElementById('wireColor-value').textContent = hexColor;
            previewSettings.wireColor = parseInt(hexColor.replace('#', '0x'));
            updatePreviewStyle();
        });
        // Set initial value
        const initialWireHex = '#' + previewSettings.wireColor.toString(16).padStart(6, '0');
        wireColorPicker.value = initialWireHex;
        document.getElementById('wireColor-value').textContent = initialWireHex;
    }

    // Scene & Lighting controls
    const ringHeightSlider = document.getElementById('ringHeight');
    if (ringHeightSlider) {
        ringHeightSlider.addEventListener('input', (e) => {
            const value = parseFloat(e.target.value);
            document.getElementById('ringHeight-value').textContent = value.toFixed(1);
            if (ringMesh) {
                ringMesh.position.y = value;
            }
            if (helperMesh) {
                helperMesh.position.y = value;
            }
        });
    }

    const ambientLightSlider = document.getElementById('ambientLight');
    if (ambientLightSlider) {
        ambientLightSlider.addEventListener('input', (e) => {
            const value = parseFloat(e.target.value);
            document.getElementById('ambientLight-value').textContent = value.toFixed(2);
            if (ambientLight) {
                ambientLight.intensity = value;
            }
        });
    }

    const mainLightSlider = document.getElementById('mainLight');
    if (mainLightSlider) {
        mainLightSlider.addEventListener('input', (e) => {
            const value = parseFloat(e.target.value);
            document.getElementById('mainLight-value').textContent = value.toFixed(2);
            if (sideLight) {
                sideLight.intensity = value;
            }
            if (sideLight2) {
                sideLight2.intensity = value;  // Both lights use same intensity
            }
        });
    }

    const fillLightSlider = document.getElementById('fillLight');
    if (fillLightSlider) {
        fillLightSlider.addEventListener('input', (e) => {
            const value = parseFloat(e.target.value);
            document.getElementById('fillLight-value').textContent = value.toFixed(2);
            if (fillLight) {
                fillLight.intensity = value;
            }
        });
    }

    const envIntensitySlider = document.getElementById('envIntensity');
    if (envIntensitySlider) {
        envIntensitySlider.addEventListener('input', (e) => {
            const value = parseFloat(e.target.value);
            document.getElementById('envIntensity-value').textContent = value.toFixed(2);
            environmentIntensity = value;

            // Control environment intensity more granularly
            if (scene && renderer) {
                if (value === 0) {
                    // Completely remove environment
                    scene.environment = null;
                } else {
                    // Set environment if we have it
                    if (hdrEnvironment) {
                        scene.environment = hdrEnvironment;
                    }

                    // Scale the environment's contribution through renderer intensity
                    // This affects how much the environment contributes to lighting
                    scene.traverse((child) => {
                        if (child.isMesh && child.material) {
                            // For standard materials, control environment contribution
                            if (child.material.isMeshStandardMaterial || child.material.isMeshPhysicalMaterial) {
                                child.material.envMapIntensity = value;
                                child.material.needsUpdate = true;
                            }
                        }
                    });
                }
            }

            // Update ring material specifically
            if (ringMaterial) {
                ringMaterial.envMapIntensity = value;
                ringMaterial.needsUpdate = true;
            }

            // Keep ground plane at 0 environment intensity - it should only be lit by direct lights
            if (groundPlane && groundPlane.material) {
                groundPlane.material.envMapIntensity = 0;  // Always 0 for ground
                groundPlane.material.needsUpdate = true;
            }
        });
    }

    const exposureSlider = document.getElementById('exposure');
    if (exposureSlider) {
        exposureSlider.addEventListener('input', (e) => {
            const value = parseFloat(e.target.value);
            document.getElementById('exposure-value').textContent = value.toFixed(2);
            if (renderer) {
                renderer.toneMappingExposure = value;

                // Debug: log current lighting state when exposure changes
                console.log('=== Lighting Debug ===');
                console.log('Ambient Light intensity:', ambientLight ? ambientLight.intensity : 'null');
                console.log('Side Light intensity:', sideLight ? sideLight.intensity : 'null');
                console.log('Fill Light intensity:', fillLight ? fillLight.intensity : 'null');
                console.log('Scene environment:', scene.environment ? 'HDRI Active' : 'No HDRI');
                console.log('Tone Mapping Exposure:', renderer.toneMappingExposure);
                console.log('=====================');
            }
        });
    }

    const groundBrightnessSlider = document.getElementById('groundBrightness');
    if (groundBrightnessSlider) {
        groundBrightnessSlider.addEventListener('input', (e) => {
            const value = parseFloat(e.target.value);
            document.getElementById('groundBrightness-value').textContent = value.toFixed(2);
            if (groundPlane && groundPlane.material) {
                // Modulate ground color brightness
                const brightness = value;
                groundPlane.material.color.setRGB(brightness, brightness, brightness);
                groundPlane.material.needsUpdate = true;
            }
        });
    }

    // Animation controls
    const animateLightsCheckbox = document.getElementById('animateLights');
    if (animateLightsCheckbox) {
        animateLightsCheckbox.addEventListener('change', (e) => {
            animateLights = e.target.checked;
            if (!animateLights && sideLight && sideLight2) {
                // Reset lights to initial positions when animation stops
                sideLight.position.set(initialLightPositions.light1.x, initialLightPositions.light1.y, initialLightPositions.light1.z);
                sideLight2.position.set(initialLightPositions.light2.x, initialLightPositions.light2.y, initialLightPositions.light2.z);
            }
        });
    }

    const animSpeedSlider = document.getElementById('animSpeed');
    if (animSpeedSlider) {
        animSpeedSlider.addEventListener('input', (e) => {
            const value = parseFloat(e.target.value);
            document.getElementById('animSpeed-value').textContent = value.toFixed(2);
            animationSpeed = value;
        });
    }

    // Mesh quality control
    const meshQualitySlider = document.getElementById('meshQuality');
    if (meshQualitySlider) {
        meshQualitySlider.addEventListener('input', (e) => {
            const value = parseInt(e.target.value);
            meshQuality = value;
            const preset = qualityPresets[value];
            document.getElementById('meshQuality-value').textContent = preset.name;
            console.log(`Mesh quality changed to ${preset.name}: tolerance=${preset.tolerance}, angular=${preset.angularTolerance}°`);

            // Trigger re-render with new quality
            instantPreviewUpdate();
        });

        // Set initial value
        const initialPreset = qualityPresets[meshQuality];
        document.getElementById('meshQuality-value').textContent = initialPreset.name;
    }

    // Point lights controls
    const pointLightsToggle = document.getElementById('pointLightsToggle');
    if (pointLightsToggle) {
        pointLightsToggle.addEventListener('change', (e) => {
            const enabled = e.target.checked;
            pointLights.forEach(light => {
                light.visible = enabled;
            });
            console.log(`Point lights ${enabled ? 'enabled' : 'disabled'}`);
        });
    }

    const pointLightIntensitySlider = document.getElementById('pointLightIntensity');
    if (pointLightIntensitySlider) {
        pointLightIntensitySlider.addEventListener('input', (e) => {
            const value = parseFloat(e.target.value);
            document.getElementById('pointLightIntensity-value').textContent = value.toFixed(2);
            pointLights.forEach(light => {
                light.intensity = value;
            });
        });
    }

}

// Main initialization
async function initializeApp() {
    console.log('Starting initialization...');

    // Initialize RepliCAD first
    await initializeReplicad();

    // Initialize Three.js
    initThreeJS();

    // Setup event listeners
    setupSliderListeners();

    // Create initial ring with high quality
    if (isInitialized) {
        await updateRing(getCurrentParams(), false);  // false = high quality for initial load
    }

    console.log('Initialization complete');
}

// Start the application
initializeApp().catch(error => {
    console.error('Failed to initialize application:', error);
});