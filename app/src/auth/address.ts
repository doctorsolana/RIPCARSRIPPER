// A Solana wallet address as the game shows and checks it. Shared by the pages and the server, with no imports, so the
// top bar can use it without pulling in anything else.

/** A Solana address: a 32-byte public key in base58 (32-44 characters, no 0 O I l). */
export const isAddress = (a: unknown): a is string => typeof a === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);

/** The wallet as players see it - its name in races: the first 4 and last 4 characters (7xKX…9fQ2). */
export const shortWallet = (a: string) => (a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);
