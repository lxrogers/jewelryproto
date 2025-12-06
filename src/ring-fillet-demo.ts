/**
 * Ring Fillet Demo
 * Prototype for testing pseudo-filleting algorithms on a ring shape
 * Ring = cylinder with smaller cylinder cut out (hollow cylinder)
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass';
import GUI from 'lil-gui';
import { LoopSubdivision } from 'three-subdivide';
import { Evaluator, Brush } from 'three-bvh-csg';

/**
 * Simple Catmull-Clark subdivision for quad meshes
 * Takes positions array and quad faces, returns subdivided mesh
 */
function catmullClarkSubdivide(
  positions: number[][],
  quads: number[][]
): { positions: number[][]; quads: number[][] } {
  const newPositions: number[][] = [];
  const newQuads: number[][] = [];

  // Step 1: Copy original vertices
  const vertexOffset = positions.length;
  for (const p of positions) {
    newPositions.push([...p]);
  }

  // Step 2: Compute face points (centroid of each quad)
  const facePoints: number[][] = [];
  const facePointOffset = newPositions.length;
  for (const quad of quads) {
    const centroid = [0, 0, 0];
    for (const vi of quad) {
      centroid[0] += positions[vi][0];
      centroid[1] += positions[vi][1];
      centroid[2] += positions[vi][2];
    }
    centroid[0] /= quad.length;
    centroid[1] /= quad.length;
    centroid[2] /= quad.length;
    facePoints.push(centroid);
    newPositions.push([...centroid]);
  }

  // Step 3: Compute edge points and build edge map
  const edgeMap = new Map<string, { midpoint: number[]; faces: number[]; edgePointIndex?: number }>();

  const makeEdgeKey = (a: number, b: number) => a < b ? `${a}-${b}` : `${b}-${a}`;

  for (let fi = 0; fi < quads.length; fi++) {
    const quad = quads[fi];
    for (let i = 0; i < quad.length; i++) {
      const a = quad[i];
      const b = quad[(i + 1) % quad.length];
      const key = makeEdgeKey(a, b);

      if (!edgeMap.has(key)) {
        const midpoint = [
          (positions[a][0] + positions[b][0]) / 2,
          (positions[a][1] + positions[b][1]) / 2,
          (positions[a][2] + positions[b][2]) / 2,
        ];
        edgeMap.set(key, { midpoint, faces: [fi] });
      } else {
        edgeMap.get(key)!.faces.push(fi);
      }
    }
  }

  // Compute edge points: average of edge midpoint and adjacent face points
  const edgePointOffset = newPositions.length;
  let edgeIdx = 0;
  for (const [key, edge] of edgeMap) {
    let ep: number[];
    if (edge.faces.length === 2) {
      // Interior edge: average of midpoint and two face points
      const fp1 = facePoints[edge.faces[0]];
      const fp2 = facePoints[edge.faces[1]];
      ep = [
        (edge.midpoint[0] + fp1[0] + fp2[0]) / 3,
        (edge.midpoint[1] + fp1[1] + fp2[1]) / 3,
        (edge.midpoint[2] + fp1[2] + fp2[2]) / 3,
      ];
    } else {
      // Boundary edge: just use midpoint
      ep = [...edge.midpoint];
    }
    edge.edgePointIndex = edgePointOffset + edgeIdx;
    newPositions.push(ep);
    edgeIdx++;
  }

  // Step 4: Move original vertices
  // For each original vertex, compute:
  // F = average of face points of faces touching vertex
  // R = average of edge midpoints of edges touching vertex
  // n = number of faces touching vertex
  // New position = (F + 2R + (n-3)P) / n

  const vertexFaces: number[][] = Array.from({ length: positions.length }, () => []);
  const vertexEdges: string[][] = Array.from({ length: positions.length }, () => []);

  for (let fi = 0; fi < quads.length; fi++) {
    const quad = quads[fi];
    for (let i = 0; i < quad.length; i++) {
      const vi = quad[i];
      if (!vertexFaces[vi].includes(fi)) {
        vertexFaces[vi].push(fi);
      }
      const a = quad[i];
      const b = quad[(i + 1) % quad.length];
      const key = makeEdgeKey(a, b);
      if (!vertexEdges[vi].includes(key)) {
        vertexEdges[vi].push(key);
      }
    }
  }

  for (let vi = 0; vi < positions.length; vi++) {
    const n = vertexFaces[vi].length;
    if (n === 0) continue;

    // F = average of adjacent face points
    const F = [0, 0, 0];
    for (const fi of vertexFaces[vi]) {
      F[0] += facePoints[fi][0];
      F[1] += facePoints[fi][1];
      F[2] += facePoints[fi][2];
    }
    F[0] /= n;
    F[1] /= n;
    F[2] /= n;

    // R = average of edge midpoints
    const R = [0, 0, 0];
    const edges = vertexEdges[vi];
    for (const key of edges) {
      const edge = edgeMap.get(key)!;
      R[0] += edge.midpoint[0];
      R[1] += edge.midpoint[1];
      R[2] += edge.midpoint[2];
    }
    R[0] /= edges.length;
    R[1] /= edges.length;
    R[2] /= edges.length;

    const P = positions[vi];

    // Check if boundary vertex (has any boundary edge)
    const isBoundary = edges.some(key => edgeMap.get(key)!.faces.length === 1);

    if (isBoundary) {
      // Boundary vertex: average of boundary edge midpoints
      const boundaryEdges = edges.filter(key => edgeMap.get(key)!.faces.length === 1);
      const avg = [0, 0, 0];
      for (const key of boundaryEdges) {
        const edge = edgeMap.get(key)!;
        avg[0] += edge.midpoint[0];
        avg[1] += edge.midpoint[1];
        avg[2] += edge.midpoint[2];
      }
      avg[0] /= boundaryEdges.length;
      avg[1] /= boundaryEdges.length;
      avg[2] /= boundaryEdges.length;

      newPositions[vi] = [
        (P[0] + avg[0]) / 2,
        (P[1] + avg[1]) / 2,
        (P[2] + avg[2]) / 2,
      ];
    } else {
      // Interior vertex
      newPositions[vi] = [
        (F[0] + 2 * R[0] + (n - 3) * P[0]) / n,
        (F[1] + 2 * R[1] + (n - 3) * P[1]) / n,
        (F[2] + 2 * R[2] + (n - 3) * P[2]) / n,
      ];
    }
  }

  // Step 5: Create new quads
  // Each original quad becomes 4 new quads
  for (let fi = 0; fi < quads.length; fi++) {
    const quad = quads[fi];
    const fpIdx = facePointOffset + fi;

    for (let i = 0; i < quad.length; i++) {
      const v = quad[i];
      const prevEdge = makeEdgeKey(quad[(i + quad.length - 1) % quad.length], v);
      const nextEdge = makeEdgeKey(v, quad[(i + 1) % quad.length]);

      const ep1 = edgeMap.get(prevEdge)!.edgePointIndex!;
      const ep2 = edgeMap.get(nextEdge)!.edgePointIndex!;

      newQuads.push([v, ep2, fpIdx, ep1]);
    }
  }

  return { positions: newPositions, quads: newQuads };
}

/**
 * Generate ring as quad mesh (for Catmull-Clark)
 */
function generateRingQuadMesh(): { positions: number[][]; quads: number[][] } {
  const { outerRadius, innerRadius, height, radialSegments, heightSegments, widthSegments } = params;
  const halfHeight = height / 2;

  const positions: number[][] = [];
  const quads: number[][] = [];

  // Create vertices for outer wall
  const outerWallStart = 0;
  for (let h = 0; h <= heightSegments; h++) {
    const y = -halfHeight + (h / heightSegments) * height;
    for (let r = 0; r < radialSegments; r++) {
      const theta = (r / radialSegments) * Math.PI * 2;
      positions.push([
        Math.cos(theta) * outerRadius,
        y,
        Math.sin(theta) * outerRadius,
      ]);
    }
  }

  // Create vertices for inner wall
  const innerWallStart = positions.length;
  for (let h = 0; h <= heightSegments; h++) {
    const y = -halfHeight + (h / heightSegments) * height;
    for (let r = 0; r < radialSegments; r++) {
      const theta = (r / radialSegments) * Math.PI * 2;
      positions.push([
        Math.cos(theta) * innerRadius,
        y,
        Math.sin(theta) * innerRadius,
      ]);
    }
  }

  // Create vertices for top face concentric rings (from inner to outer)
  // widthSegments rings between inner and outer
  const topFaceStart = positions.length;
  for (let w = 0; w <= widthSegments; w++) {
    const t = w / widthSegments;
    const radius = innerRadius + (outerRadius - innerRadius) * t;
    for (let r = 0; r < radialSegments; r++) {
      const theta = (r / radialSegments) * Math.PI * 2;
      positions.push([
        Math.cos(theta) * radius,
        halfHeight,
        Math.sin(theta) * radius,
      ]);
    }
  }

  // Create vertices for bottom face concentric rings
  const bottomFaceStart = positions.length;
  for (let w = 0; w <= widthSegments; w++) {
    const t = w / widthSegments;
    const radius = innerRadius + (outerRadius - innerRadius) * t;
    for (let r = 0; r < radialSegments; r++) {
      const theta = (r / radialSegments) * Math.PI * 2;
      positions.push([
        Math.cos(theta) * radius,
        -halfHeight,
        Math.sin(theta) * radius,
      ]);
    }
  }

  // Outer wall quads
  for (let h = 0; h < heightSegments; h++) {
    for (let r = 0; r < radialSegments; r++) {
      const rNext = (r + 1) % radialSegments;
      const v00 = outerWallStart + h * radialSegments + r;
      const v10 = outerWallStart + h * radialSegments + rNext;
      const v01 = outerWallStart + (h + 1) * radialSegments + r;
      const v11 = outerWallStart + (h + 1) * radialSegments + rNext;
      quads.push([v00, v01, v11, v10]);
    }
  }

  // Inner wall quads (reversed winding)
  for (let h = 0; h < heightSegments; h++) {
    for (let r = 0; r < radialSegments; r++) {
      const rNext = (r + 1) % radialSegments;
      const v00 = innerWallStart + h * radialSegments + r;
      const v10 = innerWallStart + h * radialSegments + rNext;
      const v01 = innerWallStart + (h + 1) * radialSegments + r;
      const v11 = innerWallStart + (h + 1) * radialSegments + rNext;
      quads.push([v00, v10, v11, v01]);
    }
  }

  // Top face quads (concentric rings from inner to outer)
  for (let w = 0; w < widthSegments; w++) {
    for (let r = 0; r < radialSegments; r++) {
      const rNext = (r + 1) % radialSegments;
      const inner0 = topFaceStart + w * radialSegments + r;
      const inner1 = topFaceStart + w * radialSegments + rNext;
      const outer0 = topFaceStart + (w + 1) * radialSegments + r;
      const outer1 = topFaceStart + (w + 1) * radialSegments + rNext;
      // CCW when viewed from above
      quads.push([inner0, inner1, outer1, outer0]);
    }
  }

  // Bottom face quads (concentric rings, reversed winding)
  for (let w = 0; w < widthSegments; w++) {
    for (let r = 0; r < radialSegments; r++) {
      const rNext = (r + 1) % radialSegments;
      const inner0 = bottomFaceStart + w * radialSegments + r;
      const inner1 = bottomFaceStart + w * radialSegments + rNext;
      const outer0 = bottomFaceStart + (w + 1) * radialSegments + r;
      const outer1 = bottomFaceStart + (w + 1) * radialSegments + rNext;
      // CCW when viewed from below
      quads.push([inner0, outer0, outer1, inner1]);
    }
  }

  return { positions, quads };
}

/**
 * Convert quad mesh to Three.js BufferGeometry
 */
function quadMeshToGeometry(positions: number[][], quads: number[][]): THREE.BufferGeometry {
  const flatPositions: number[] = [];
  const indices: number[] = [];

  for (const p of positions) {
    flatPositions.push(p[0], p[1], p[2]);
  }

  // Triangulate quads
  for (const quad of quads) {
    if (quad.length === 4) {
      indices.push(quad[0], quad[1], quad[2]);
      indices.push(quad[0], quad[2], quad[3]);
    } else if (quad.length === 3) {
      indices.push(quad[0], quad[1], quad[2]);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(flatPositions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  return geometry;
}

// Global state
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let renderer: THREE.WebGLRenderer;
let controls: OrbitControls;
let composer: EffectComposer;
let ringMesh: THREE.Mesh | null = null;
let groundPlane: THREE.Mesh;

// Light references
let ambientLight: THREE.AmbientLight;
let sideLight: THREE.DirectionalLight;
let sideLight2: THREE.DirectionalLight;
let fillLight: THREE.DirectionalLight;

// Stats display
let statsElement: HTMLElement;
let lastUpdateTime = 0;

// CSG evaluator (reusable)
let csgEvaluator: Evaluator;

// Parameters
const params = {
  // Ring dimensions
  outerRadius: 10,
  innerRadius: 7,
  height: 3,

  // Bar dimensions
  showBar: true,
  barDepth: 2,  // thickness of the bar

  // Quality
  radialSegments: 16,
  heightSegments: 1,
  widthSegments: 4,  // Segments from inner to outer radius (spoke axis)

  // Subdivision
  subdivisions: 0,
  algorithm: 'loop' as 'loop' | 'catmull-clark',
  split: true,  // Preserve hard edges where normals differ
  uvSmooth: false,
  flatOnly: false,

  // Material
  metalness: 1.0,
  roughness: 0.15,
  color: '#FFD700',
};

/**
 * Generate a hollow cylinder (ring) geometry
 */
function generateRingGeometry(): THREE.BufferGeometry {
  const { outerRadius, innerRadius, height, radialSegments, heightSegments, widthSegments } = params;
  const halfHeight = height / 2;

  // Calculate vertex and index counts
  // Outer wall: radialSegments * (heightSegments + 1)
  // Inner wall: same
  // Top/Bottom faces: (widthSegments + 1) * radialSegments each
  const wallVertices = radialSegments * (heightSegments + 1);
  const faceVertices = (widthSegments + 1) * radialSegments;
  const totalVertices = wallVertices * 2 + faceVertices * 2;

  // Indices:
  // Outer wall: radialSegments * heightSegments * 6
  // Inner wall: same
  // Top/Bottom faces: widthSegments * radialSegments * 6 each
  const wallIndices = radialSegments * heightSegments * 6;
  const faceIndices = widthSegments * radialSegments * 6;
  const totalIndices = wallIndices * 2 + faceIndices * 2;

  const positions = new Float32Array(totalVertices * 3);
  const normals = new Float32Array(totalVertices * 3);
  const uvs = new Float32Array(totalVertices * 2);
  const indices = new Uint32Array(totalIndices);

  let vi = 0; // vertex index
  let ii = 0; // index index

  // ========== OUTER WALL ==========
  const outerWallStart = vi;
  for (let h = 0; h <= heightSegments; h++) {
    const y = -halfHeight + (h / heightSegments) * height;
    const v = h / heightSegments;

    for (let r = 0; r < radialSegments; r++) {
      const theta = (r / radialSegments) * Math.PI * 2;
      const x = Math.cos(theta) * outerRadius;
      const z = Math.sin(theta) * outerRadius;

      positions[vi * 3] = x;
      positions[vi * 3 + 1] = y;
      positions[vi * 3 + 2] = z;

      // Normal points outward
      normals[vi * 3] = Math.cos(theta);
      normals[vi * 3 + 1] = 0;
      normals[vi * 3 + 2] = Math.sin(theta);

      uvs[vi * 2] = r / radialSegments;
      uvs[vi * 2 + 1] = v;

      vi++;
    }
  }

  // Outer wall indices
  for (let h = 0; h < heightSegments; h++) {
    for (let r = 0; r < radialSegments; r++) {
      const rNext = (r + 1) % radialSegments;

      const v00 = outerWallStart + h * radialSegments + r;
      const v10 = outerWallStart + h * radialSegments + rNext;
      const v01 = outerWallStart + (h + 1) * radialSegments + r;
      const v11 = outerWallStart + (h + 1) * radialSegments + rNext;

      // CCW winding for outward facing (when looking at outer surface)
      indices[ii++] = v00;
      indices[ii++] = v01;
      indices[ii++] = v11;

      indices[ii++] = v00;
      indices[ii++] = v11;
      indices[ii++] = v10;
    }
  }

  // ========== INNER WALL ==========
  const innerWallStart = vi;
  for (let h = 0; h <= heightSegments; h++) {
    const y = -halfHeight + (h / heightSegments) * height;
    const v = h / heightSegments;

    for (let r = 0; r < radialSegments; r++) {
      const theta = (r / radialSegments) * Math.PI * 2;
      const x = Math.cos(theta) * innerRadius;
      const z = Math.sin(theta) * innerRadius;

      positions[vi * 3] = x;
      positions[vi * 3 + 1] = y;
      positions[vi * 3 + 2] = z;

      // Normal points inward (negative)
      normals[vi * 3] = -Math.cos(theta);
      normals[vi * 3 + 1] = 0;
      normals[vi * 3 + 2] = -Math.sin(theta);

      uvs[vi * 2] = r / radialSegments;
      uvs[vi * 2 + 1] = v;

      vi++;
    }
  }

  // Inner wall indices (reversed winding for inward facing)
  for (let h = 0; h < heightSegments; h++) {
    for (let r = 0; r < radialSegments; r++) {
      const rNext = (r + 1) % radialSegments;

      const v00 = innerWallStart + h * radialSegments + r;
      const v10 = innerWallStart + h * radialSegments + rNext;
      const v01 = innerWallStart + (h + 1) * radialSegments + r;
      const v11 = innerWallStart + (h + 1) * radialSegments + rNext;

      // CCW winding when looking at inner surface (from inside the hole)
      indices[ii++] = v00;
      indices[ii++] = v10;
      indices[ii++] = v11;

      indices[ii++] = v00;
      indices[ii++] = v11;
      indices[ii++] = v01;
    }
  }

  // ========== TOP FACE ==========
  // Create concentric rings from inner to outer radius
  const topFaceStart = vi;

  for (let w = 0; w <= widthSegments; w++) {
    const t = w / widthSegments;
    const radius = innerRadius + (outerRadius - innerRadius) * t;

    for (let r = 0; r < radialSegments; r++) {
      const theta = (r / radialSegments) * Math.PI * 2;
      const x = Math.cos(theta) * radius;
      const z = Math.sin(theta) * radius;

      positions[vi * 3] = x;
      positions[vi * 3 + 1] = halfHeight;
      positions[vi * 3 + 2] = z;

      normals[vi * 3] = 0;
      normals[vi * 3 + 1] = 1;
      normals[vi * 3 + 2] = 0;

      uvs[vi * 2] = (x / outerRadius + 1) / 2;
      uvs[vi * 2 + 1] = (z / outerRadius + 1) / 2;

      vi++;
    }
  }

  // Top face indices (quads between concentric rings)
  for (let w = 0; w < widthSegments; w++) {
    for (let r = 0; r < radialSegments; r++) {
      const rNext = (r + 1) % radialSegments;

      const inner0 = topFaceStart + w * radialSegments + r;
      const inner1 = topFaceStart + w * radialSegments + rNext;
      const outer0 = topFaceStart + (w + 1) * radialSegments + r;
      const outer1 = topFaceStart + (w + 1) * radialSegments + rNext;

      // CCW when viewed from above (+Y)
      indices[ii++] = inner0;
      indices[ii++] = inner1;
      indices[ii++] = outer1;

      indices[ii++] = inner0;
      indices[ii++] = outer1;
      indices[ii++] = outer0;
    }
  }

  // ========== BOTTOM FACE ==========
  // Create concentric rings from inner to outer radius
  const bottomFaceStart = vi;

  for (let w = 0; w <= widthSegments; w++) {
    const t = w / widthSegments;
    const radius = innerRadius + (outerRadius - innerRadius) * t;

    for (let r = 0; r < radialSegments; r++) {
      const theta = (r / radialSegments) * Math.PI * 2;
      const x = Math.cos(theta) * radius;
      const z = Math.sin(theta) * radius;

      positions[vi * 3] = x;
      positions[vi * 3 + 1] = -halfHeight;
      positions[vi * 3 + 2] = z;

      normals[vi * 3] = 0;
      normals[vi * 3 + 1] = -1;
      normals[vi * 3 + 2] = 0;

      uvs[vi * 2] = (x / outerRadius + 1) / 2;
      uvs[vi * 2 + 1] = (z / outerRadius + 1) / 2;

      vi++;
    }
  }

  // Bottom face indices (quads between concentric rings)
  for (let w = 0; w < widthSegments; w++) {
    for (let r = 0; r < radialSegments; r++) {
      const rNext = (r + 1) % radialSegments;

      const inner0 = bottomFaceStart + w * radialSegments + r;
      const inner1 = bottomFaceStart + w * radialSegments + rNext;
      const outer0 = bottomFaceStart + (w + 1) * radialSegments + r;
      const outer1 = bottomFaceStart + (w + 1) * radialSegments + rNext;

      // CCW when viewed from below (-Y)
      indices[ii++] = inner0;
      indices[ii++] = outer0;
      indices[ii++] = outer1;

      indices[ii++] = inner0;
      indices[ii++] = outer1;
      indices[ii++] = inner1;
    }
  }

  // Create geometry
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));

  console.log(`Ring generated: ${vi} vertices, ${ii / 3} triangles`);

  return geometry;
}

/**
 * Create ground gradient texture
 */
function createGroundGradientTexture(
  size = 1024,
  middleStop = 0.5,
  endStop = 0.8,
  intensity = 0.8
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d')!;

  const centerX = size / 2;
  const centerY = size / 2;
  const maxRadius = size / 2;

  const gradient = context.createRadialGradient(
    centerX, centerY, 0,
    centerX, centerY, maxRadius * endStop
  );

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

/**
 * Update the ring mesh
 */
function updateRingMesh(): void {
  const startTime = performance.now();

  // Initialize CSG evaluator if needed
  if (!csgEvaluator) {
    csgEvaluator = new Evaluator();
  }

  let geometry: THREE.BufferGeometry;

  // Step 1: Generate base ring geometry (low poly)
  geometry = generateRingGeometry();

  // Step 2: Apply CSG operations on low-poly geometry (much faster)
  if (params.showBar) {
    // Create ring brush
    const ringBrush = new Brush(geometry);
    ringBrush.updateMatrixWorld();

    // Create bar geometry - spans across the ring but stays inside
    // Add segments to match ring topology for cleaner CSG results
    const barLength = (params.outerRadius - params.barDepth / 2) * 2;
    const barSegmentsX = Math.max(8, params.radialSegments); // Length segments
    const barSegmentsY = params.heightSegments;              // Height segments
    const barSegmentsZ = Math.max(2, params.widthSegments);  // Depth segments
    const barGeometry = new THREE.BoxGeometry(
      barLength,       // X - spans across the ring (inside outer edge)
      params.height,   // Y - same height as the ring
      params.barDepth, // Z - depth/thickness of bar
      barSegmentsX,
      barSegmentsY,
      barSegmentsZ
    );

    // Create bar brush
    const barBrush = new Brush(barGeometry);
    barBrush.updateMatrixWorld();

    // Union the ring and bar
    const result = csgEvaluator.evaluate(ringBrush, barBrush, 0); // 0 = UNION
    geometry = result.geometry;

    // Clean up brushes
    ringBrush.geometry.dispose();
    barBrush.geometry.dispose();
  }

  // Step 3: Apply subdivision AFTER CSG (on the combined mesh)
  if (params.subdivisions > 0) {
    if (params.algorithm === 'catmull-clark') {
      // Convert triangle geometry to quad mesh for Catmull-Clark
      // Note: CSG output is triangles, so we use Loop for now when bar is shown
      // TODO: Implement triangle-to-quad conversion for proper Catmull-Clark
      const subdivParams = {
        split: params.split,
        uvSmooth: params.uvSmooth,
        flatOnly: params.flatOnly,
      };
      geometry = LoopSubdivision.modify(geometry, params.subdivisions, subdivParams);
    } else {
      // Loop subdivision on triangles
      const subdivParams = {
        split: params.split,
        uvSmooth: params.uvSmooth,
        flatOnly: params.flatOnly,
      };
      geometry = LoopSubdivision.modify(geometry, params.subdivisions, subdivParams);
    }
  }

  if (ringMesh) {
    ringMesh.geometry.dispose();
    ringMesh.geometry = geometry;
  } else {
    const material = new THREE.MeshStandardMaterial({
      color: params.color,
      metalness: params.metalness,
      roughness: params.roughness,
      envMapIntensity: 1.0,
    });

    ringMesh = new THREE.Mesh(geometry, material);
    ringMesh.castShadow = true;
    ringMesh.receiveShadow = true;
    scene.add(ringMesh);
  }

  // Position ring so it sits on the ground
  ringMesh.position.y = params.height / 2;

  lastUpdateTime = performance.now() - startTime;
  updateStats();
}

/**
 * Update material properties
 */
function updateMaterial(): void {
  if (!ringMesh) return;
  const material = ringMesh.material as THREE.MeshStandardMaterial;
  material.color.set(params.color);
  material.metalness = params.metalness;
  material.roughness = params.roughness;
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

  statsElement.textContent = `Vertices: ${vertices.toLocaleString()} | Triangles: ${triangles.toLocaleString()} | Update: ${lastUpdateTime.toFixed(2)}ms`;
}

/**
 * Initialize Three.js scene
 */
function initThreeJS(): void {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const container = canvas.parentElement!;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  const aspect = container.clientWidth / container.clientHeight;
  camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 1000);
  camera.position.set(25, 30, 25);

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
  controls.target.set(0, 2, 0);

  // Ground plane
  const planeGeometry = new THREE.PlaneGeometry(600, 600);
  const groundGradientTexture = new THREE.CanvasTexture(
    createGroundGradientTexture(1024, 0.2, 3.0, 0.8)
  );
  groundGradientTexture.needsUpdate = true;

  const planeMaterial = new THREE.MeshStandardMaterial({
    map: groundGradientTexture,
    roughness: 1.0,
    metalness: 0.0,
    envMapIntensity: 0.0,
  });
  groundPlane = new THREE.Mesh(planeGeometry, planeMaterial);
  groundPlane.rotation.x = -Math.PI / 2;
  groundPlane.position.y = 0;
  groundPlane.receiveShadow = true;
  groundPlane.material.color.setRGB(0.5, 0.5, 0.5);
  scene.add(groundPlane);

  // HDRI environment
  const rgbeLoader = new RGBELoader();
  rgbeLoader.load('/softbox.hdr', function (hdrEquirect) {
    hdrEquirect.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment = hdrEquirect;
  });

  // Lights
  ambientLight = new THREE.AmbientLight(0xffffff, 0.1);
  scene.add(ambientLight);

  sideLight = new THREE.DirectionalLight(0xffffff, 3.0);
  sideLight.position.set(-20, 35, -20);
  sideLight.castShadow = true;
  sideLight.shadow.mapSize.width = 1024;
  sideLight.shadow.mapSize.height = 1024;
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
  sideLight2.position.set(20, 35, -20);
  sideLight2.castShadow = false;
  scene.add(sideLight2);

  fillLight = new THREE.DirectionalLight(0xffffff, 0.4);
  fillLight.position.set(-30, 10, -10);
  scene.add(fillLight);

  // Single point light
  const pointLight = new THREE.PointLight(0xffffff, 5.0, 100);
  pointLight.position.set(0, 18, 0);
  pointLight.decay = 2;
  scene.add(pointLight);

  // Post-processing
  composer = new EffectComposer(renderer);

  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  const smaaPass = new SMAAPass(
    container.clientWidth * window.devicePixelRatio,
    container.clientHeight * window.devicePixelRatio
  );
  smaaPass.enabled = true;
  composer.addPass(smaaPass);

  // Color grading
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

  const colorGradingPass = new ShaderPass(ColorGradingShader);
  composer.addPass(colorGradingPass);

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
  const gui = new GUI({ title: 'Ring Fillet Prototype' });

  // Ring dimensions folder
  const ringFolder = gui.addFolder('Ring Dimensions');
  ringFolder
    .add(params, 'outerRadius', 5, 20, 0.5)
    .name('Outer Radius')
    .onChange(() => updateRingMesh());
  ringFolder
    .add(params, 'innerRadius', 2, 15, 0.5)
    .name('Inner Radius')
    .onChange(() => updateRingMesh());
  ringFolder
    .add(params, 'height', 0.5, 10, 0.1)
    .name('Height')
    .onChange(() => updateRingMesh());
  ringFolder.open();

  // Bar folder
  const barFolder = gui.addFolder('Cross Bar');
  barFolder
    .add(params, 'showBar')
    .name('Show Bar')
    .onChange(() => updateRingMesh());
  barFolder
    .add(params, 'barDepth', 0.5, 5, 0.1)
    .name('Thickness')
    .onChange(() => updateRingMesh());
  barFolder.open();

  // Quality folder
  const qualityFolder = gui.addFolder('Quality');
  qualityFolder
    .add(params, 'radialSegments', 8, 64, 4)
    .name('Radial Segments')
    .onChange(() => updateRingMesh());
  qualityFolder
    .add(params, 'heightSegments', 1, 8, 1)
    .name('Height Segments')
    .onChange(() => updateRingMesh());
  qualityFolder
    .add(params, 'widthSegments', 1, 8, 1)
    .name('Width Segments')
    .onChange(() => updateRingMesh());

  // Subdivision folder
  const subdivFolder = gui.addFolder('Subdivision');
  subdivFolder
    .add(params, 'algorithm', ['loop', 'catmull-clark'])
    .name('Algorithm')
    .onChange(() => updateRingMesh());
  subdivFolder
    .add(params, 'subdivisions', 0, 4, 1)
    .name('Iterations')
    .onChange(() => updateRingMesh());
  subdivFolder
    .add(params, 'split')
    .name('Split (Loop only)')
    .onChange(() => updateRingMesh());
  subdivFolder
    .add(params, 'uvSmooth')
    .name('UV Smooth (Loop only)')
    .onChange(() => updateRingMesh());
  subdivFolder
    .add(params, 'flatOnly')
    .name('Flat Only (Loop only)')
    .onChange(() => updateRingMesh());
  subdivFolder.open();

  // Material folder
  const materialFolder = gui.addFolder('Material');
  materialFolder.addColor(params, 'color').name('Color').onChange(updateMaterial);
  materialFolder.add(params, 'metalness', 0, 1, 0.01).name('Metalness').onChange(updateMaterial);
  materialFolder.add(params, 'roughness', 0, 1, 0.01).name('Roughness').onChange(updateMaterial);
}

/**
 * Animation loop
 */
function animate(): void {
  requestAnimationFrame(animate);
  controls.update();

  if (composer) {
    composer.render();
  } else {
    renderer.render(scene, camera);
  }
}

/**
 * Initialize
 */
function init(): void {
  statsElement = document.getElementById('stats')!;
  initThreeJS();
  setupGUI();
  updateRingMesh();
  animate();

  const loading = document.getElementById('loading');
  if (loading) loading.classList.add('hidden');

  console.log('Ring Fillet Demo initialized');
}

// Start
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
