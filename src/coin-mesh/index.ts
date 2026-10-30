/**
 * Coin Mesh Generator
 * Generates Three.js BufferGeometry for coin shapes with rounded edges
 */

export { CoinMeshGenerator } from './generator';

export {
  createCircleOutline,
  createSuperellipseOutline,
  createBlobOutline,
  createEllipseOutline,
  createRoundedRectOutline,
  createOutlineFromPoints,
} from './outline-functions';

export type {
  OutlinePoint,
  OutlineFunction,
  CoinMeshParams,
  UVMode,
  QualityPreset,
  DeformationParams,
} from './types';

export { QUALITY_PRESETS } from './types';

export {
  triangulatePolygon,
  triangulateDiscWithInternalVertices,
  triangulateDiscSimple,
} from './triangulation';
