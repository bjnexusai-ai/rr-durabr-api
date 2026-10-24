// Loads the D1 stand-in if this Node has node:sqlite, else tells tests to skip.
let makeD1 = null;
try { ({ makeD1 } = await import('../testlib/d1shim.mjs')); } catch { /* old Node: DB tests are skipped */ }
export { makeD1 };
export const SKIP = makeD1 ? false : 'needs Node 22.5+ (node:sqlite)';
