import { CAR_V, CARS } from 'virtual:cars';

// The cars the game has (assets/cars/index.json, built into the page by vite.config.ts: no fetch) and the URLs of their
// files. A car's files are served from /cars/<id>/, each with ?v= the car's version - a hash of its folder's files - so a
// car whose model changed is a new URL and a browser never shows the one it kept from before (vercel.json: a versioned
// car file is kept a year; an unversioned one, like the review tools' snapshots, is checked every time).

export { CARS };
export type CarEntry = (typeof CARS)[number];

/** /cars/<id>/<file>, versioned. */
export const carFile = (id: string, file: string) => `/cars/${id}/${file}${CAR_V[id] ? `?v=${CAR_V[id]}` : ''}`;
