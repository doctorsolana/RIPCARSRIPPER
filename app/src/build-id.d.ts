/** The sim build id (server/build-id.ts), made by vite.config.ts's build-id plugin: the join carries it. */
declare module 'virtual:build-id' {
  export const BUILD_ID: string;
}

/** assets/cars/index.json's cars and each car's version (a hash of its files), made by vite.config.ts's cars plugin:
 *  src/catalog.ts. */
declare module 'virtual:cars' {
  export const CARS: {
    id: string; make: string; model: string; year: number | null; rarity: string | null; modelled: boolean;
    passed: boolean | null; versions: string[]; source: string | null;
  }[];
  export const CAR_V: Record<string, string>;
}
