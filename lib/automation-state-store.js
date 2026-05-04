import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const STATE_PATH = 'logs/gents-mail-automation-state.json';

export async function getAutomationState() {
  const state = await readJsonBlob(STATE_PATH, {});
  return state && typeof state === 'object' && !Array.isArray(state) ? state : {};
}

export async function saveAutomationState(state) {
  return writeJsonBlob(STATE_PATH, state || {});
}

export async function updateAutomationState(mutator) {
  const state = await getAutomationState();
  const next = await mutator(state);
  await saveAutomationState(next || state);
  return next || state;
}
