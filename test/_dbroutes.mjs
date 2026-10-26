// DB for the route tests. In the repo this is the real migrations folder (0001, 0002) via testlib/d1shim.mjs.
// RR_MIG_DIR can point at another folder of .sql files (used only to dry-run these tests where the repo is not available).
import { pathToFileURL } from 'node:url';
let makeD1 = null;
try { ({ makeD1 } = await import('../testlib/d1shim.mjs')); } catch { /* old Node */ }
export const SKIP = makeD1 ? false : 'needs Node 22.5+ (node:sqlite)';
export const newDb = () => (process.env.RR_MIG_DIR ? makeD1(pathToFileURL(process.env.RR_MIG_DIR.replace(/\/?$/, '/'))) : makeD1());
