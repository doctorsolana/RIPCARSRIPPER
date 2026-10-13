import type { VehicleFactory } from '../types';

// Driving models, loaded on demand (a model's code is only fetched when it's picked with ?model=).
export const VEHICLES: Record<string, () => Promise<{ create: VehicleFactory }>> = {
  arcade: () => import('./arcade'),
};
