import { put, list } from '@vercel/blob';

const DECLARATIONS_PATH = 'declarations/declarations.json';

async function readBlobText(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error('Declaratiebestand kon niet worden gelezen.');
  }

  return response.text();
}

export async function getDeclarations() {
  try {
    const result = await list({
      prefix: DECLARATIONS_PATH,
      limit: 1
    });

    const blob = result.blobs.find((item) => item.pathname === DECLARATIONS_PATH);

    if (!blob) {
      return [];
    }

    const raw = await readBlobText(blob.url);
    return JSON.parse(raw || '[]');
  } catch (error) {
    console.error('Read declarations from Blob error:', error);
    return [];
  }
}

export async function saveDeclarations(declarations) {
  await put(
    DECLARATIONS_PATH,
    JSON.stringify(declarations, null, 2),
    {
      access: 'public',
      allowOverwrite: true,
      contentType: 'application/json',
      cacheControlMaxAge: 60
    }
  );
}

export async function createDeclaration(input) {
  const declarations = await getDeclarations();

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
paymentMethod: '',
adminNote: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  declarations.unshift(declaration);

  await saveDeclarations(declarations);

  return declaration;
}

export async function updateDeclaration(id, updates) {
  const declarations = await getDeclarations();
  const index = declarations.findIndex((item) => String(item.id) === String(id));

  if (index === -1) {
    return null;
  }

  declarations[index] = {
    ...declarations[index],
    ...updates,
    updatedAt: new Date().toISOString()
  };

  await saveDeclarations(declarations);

  return declarations[index];
}
