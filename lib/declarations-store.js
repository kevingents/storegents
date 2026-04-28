import fs from 'fs';
import path from 'path';

import { put, list } from '@vercel/blob';
const DATA_FILE = path.join(DATA_DIR, 'declarations.json');

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify([]));
  }
}

export function getDeclarations() {
  ensureStore();

  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw || '[]');
  } catch (error) {
    console.error('Read declarations error:', error);
    return [];
  }
}

export function saveDeclarations(declarations) {
  ensureStore();

  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(declarations, null, 2));
  } catch (error) {
    console.error('Save declarations error:', error);
    throw error;
  }
}

export function createDeclaration(input) {
  const declarations = getDeclarations();

  const declaration = {
    id: Date.now().toString(),
    store: input.store,
    employeeName: input.employeeName,
    responsible: input.responsible,
    purpose: input.purpose,
    notes: input.notes || '',
    signed: true,
    fileName: input.fileName || '',
    fileUrl: input.fileUrl || '',
    status: 'Ingediend',
    paidAt: '',
    adminNote: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  declarations.unshift(declaration);
  saveDeclarations(declarations);

  return declaration;
}

export function updateDeclaration(id, updates) {
  const declarations = getDeclarations();
  const index = declarations.findIndex((item) => String(item.id) === String(id));

  if (index === -1) {
    return null;
  }

  declarations[index] = {
    ...declarations[index],
    ...updates,
    updatedAt: new Date().toISOString()
  };

  saveDeclarations(declarations);

  return declarations[index];
}
