/**
 * lib/srs-retail-store.js
 *
 * Blob-snapshot van de winkelprestaties (bezoekers × bonnen × omzet × conversie)
 * per fysiek filiaal. Gevuld door srs-retail-import.js uit de SFTP-exports
 * klantentellers_*.csv.gz en verkopen_*.csv.gz.
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const PATH = 'srs/retail-performance.json';
const EMPTY = { refreshedAt: null, window: null, sources: {}, totals: null, filialen: [], days: [] };

export async function readRetailPerformance() {
  const d = await readJsonBlob(PATH, EMPTY);
  return (d && typeof d === 'object' && !Array.isArray(d)) ? d : EMPTY;
}

export async function writeRetailPerformance(data) {
  return writeJsonBlob(PATH, data);
}
