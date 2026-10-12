// Placeholder tiers — RIPCARS hasn't published theirs yet. `level` drives how hard the reveal escalates.
export interface Tier {
  key: string;
  label: string;
  color: string;
  level: number;
}

export const TIERS: Record<string, Tier> = {
  common: { key: 'common', label: 'Common', color: '#9fb3c8', level: 0 },
  rare: { key: 'rare', label: 'Rare', color: '#3d8bff', level: 1 },
  epic: { key: 'epic', label: 'Epic', color: '#a35cff', level: 2 },
  legendary: { key: 'legendary', label: 'Legendary', color: '#ffb020', level: 3 },
  chase: { key: 'chase', label: 'Chase', color: '#ff3d6e', level: 4 },
};

export const tierOf = (key: string) => TIERS[key] ?? TIERS.common;
