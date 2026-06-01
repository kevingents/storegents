/**
 * lib/recruitment-store.js
 *
 * HR → Vacatures (ATS). Vacatures + sollicitanten in één blob zodat het aantal
 * blobs laag blijft en schrijven atomair is.
 *
 * Blob hr/recruitment.json:
 *   {
 *     vacancies:  { [id]: Vacancy },
 *     applicants: { [id]: Applicant },
 *     updatedAt
 *   }
 *
 * Vacancy:   { id, title, store, department, employmentType, hoursPerWeek,
 *              description, requirements, status('concept'|'open'|'gesloten'),
 *              indeedRef, createdAt, updatedAt, createdBy }
 * Applicant: { id, vacancyId, vacancyTitle, store, name, email, phone, motivation,
 *              cvUrl, cvFilename, source('website'|'indeed'|'handmatig'),
 *              status('nieuw'|'in_behandeling'|'uitgenodigd'|'afgewezen'|'aangenomen'),
 *              rating, screening, notes, consent, createdAt, updatedAt }
 *
 * Schrijven via mutateJsonBlob (verse cache-busted RMW + no-cache write) zodat
 * een directe reload altijd de nieuwe staat ziet (les uit kpi/customer-targets).
 */

import { readJsonBlob, mutateJsonBlob } from './json-blob-store.js';

const PATH = 'hr/recruitment.json';
const EMPTY = { vacancies: {}, applicants: {}, updatedAt: null };

const clean = (v) => String(v == null ? '' : v).trim();
const nowIso = () => new Date().toISOString();
function genId(prefix) {
  const rnd = (globalThis.crypto?.randomUUID?.() || (Date.now().toString(36) + Math.random().toString(36).slice(2)));
  return `${prefix}_${rnd}`.replace(/-/g, '').slice(0, 28);
}

const VACANCY_STATUS = ['concept', 'open', 'gesloten'];
const APPLICANT_STATUS = ['nieuw', 'in_behandeling', 'uitgenodigd', 'afgewezen', 'aangenomen'];

export const RECRUITMENT_STATUSES = Object.freeze({ vacancy: VACANCY_STATUS, applicant: APPLICANT_STATUS });

async function readAll() {
  const d = await readJsonBlob(PATH, EMPTY);
  return {
    vacancies: (d && d.vacancies) || {},
    applicants: (d && d.applicants) || {},
    updatedAt: d?.updatedAt || null
  };
}

/* ── Vacatures ─────────────────────────────────────────────────────────── */

function normVacancy(v = {}, prev = {}) {
  return {
    id: prev.id || v.id || genId('vac'),
    title: clean(v.title ?? prev.title),
    store: clean(v.store ?? prev.store),
    department: clean(v.department ?? prev.department),
    employmentType: clean(v.employmentType ?? prev.employmentType) || 'fulltime',
    hoursPerWeek: Number(v.hoursPerWeek ?? prev.hoursPerWeek) || null,
    description: String(v.description ?? prev.description ?? '').slice(0, 8000),
    requirements: String(v.requirements ?? prev.requirements ?? '').slice(0, 4000),
    status: VACANCY_STATUS.includes(v.status) ? v.status : (prev.status || 'concept'),
    indeedRef: clean(v.indeedRef ?? prev.indeedRef),
    createdAt: prev.createdAt || nowIso(),
    updatedAt: nowIso(),
    createdBy: prev.createdBy || clean(v.actor) || 'admin'
  };
}

export async function listVacancies({ status = '', store = '' } = {}) {
  const { vacancies } = await readAll();
  let rows = Object.values(vacancies);
  if (status) rows = rows.filter((v) => v.status === status);
  if (store) rows = rows.filter((v) => v.store === store);
  return rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function getVacancy(id) {
  const { vacancies } = await readAll();
  return vacancies[clean(id)] || null;
}

export async function upsertVacancy(patch = {}, actor = 'admin') {
  if (!clean(patch.title)) throw new Error('Titel is verplicht.');
  const id = clean(patch.id);
  let saved = null;
  await mutateJsonBlob(PATH, (d0) => {
    const d = (d0 && typeof d0 === 'object') ? d0 : { ...EMPTY };
    const vacancies = d.vacancies || {};
    const prev = id ? (vacancies[id] || {}) : {};
    const row = normVacancy({ ...patch, actor }, prev);
    vacancies[row.id] = row;
    saved = row;
    return { ...d, vacancies, updatedAt: nowIso() };
  }, { fallback: { ...EMPTY } });
  return saved;
}

export async function deleteVacancy(id) {
  const key = clean(id);
  let removed = false;
  await mutateJsonBlob(PATH, (d0) => {
    const d = (d0 && typeof d0 === 'object') ? d0 : { ...EMPTY };
    const vacancies = d.vacancies || {};
    if (vacancies[key]) { delete vacancies[key]; removed = true; }
    return { ...d, vacancies, updatedAt: nowIso() };
  }, { fallback: { ...EMPTY } });
  return removed;
}

/* ── Sollicitanten ─────────────────────────────────────────────────────── */

export async function listApplicants({ vacancyId = '', status = '', store = '' } = {}) {
  const { applicants } = await readAll();
  let rows = Object.values(applicants);
  if (vacancyId) rows = rows.filter((a) => a.vacancyId === vacancyId);
  if (status) rows = rows.filter((a) => a.status === status);
  if (store) rows = rows.filter((a) => a.store === store);
  return rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function getApplicant(id) {
  const { applicants } = await readAll();
  return applicants[clean(id)] || null;
}

/** Nieuwe sollicitatie aanmaken (vanuit website/indeed/handmatig). */
export async function createApplicant(input = {}) {
  if (!clean(input.name)) throw new Error('Naam is verplicht.');
  const vacancyId = clean(input.vacancyId);
  let saved = null;
  await mutateJsonBlob(PATH, (d0) => {
    const d = (d0 && typeof d0 === 'object') ? d0 : { ...EMPTY };
    const applicants = d.applicants || {};
    const vac = (d.vacancies || {})[vacancyId] || {};
    const row = {
      id: genId('sol'),
      vacancyId,
      vacancyTitle: vac.title || clean(input.vacancyTitle),
      store: vac.store || clean(input.store),
      name: clean(input.name),
      email: clean(input.email),
      phone: clean(input.phone),
      motivation: String(input.motivation || '').slice(0, 5000),
      cvUrl: clean(input.cvUrl),
      cvFilename: clean(input.cvFilename),
      source: ['website', 'indeed', 'handmatig'].includes(input.source) ? input.source : 'website',
      status: 'nieuw',
      rating: null,
      screening: null,
      notes: '',
      consent: Boolean(input.consent),
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    applicants[row.id] = row;
    saved = row;
    return { ...d, applicants, updatedAt: nowIso() };
  }, { fallback: { ...EMPTY } });
  return saved;
}

/** Bijwerken: status / rating / notes / screening. */
export async function updateApplicant(id, patch = {}, actor = 'admin') {
  const key = clean(id);
  let saved = null;
  await mutateJsonBlob(PATH, (d0) => {
    const d = (d0 && typeof d0 === 'object') ? d0 : { ...EMPTY };
    const applicants = d.applicants || {};
    const prev = applicants[key];
    if (!prev) return d;
    const next = { ...prev };
    if (patch.status && APPLICANT_STATUS.includes(patch.status)) next.status = patch.status;
    if (patch.rating !== undefined) next.rating = patch.rating === null ? null : Math.max(1, Math.min(5, Number(patch.rating) || 0)) || null;
    if (patch.notes !== undefined) next.notes = String(patch.notes || '').slice(0, 4000);
    if (patch.screening !== undefined) next.screening = patch.screening;
    next.updatedAt = nowIso();
    next.updatedBy = clean(actor) || 'admin';
    applicants[key] = next;
    saved = next;
    return { ...d, applicants, updatedAt: nowIso() };
  }, { fallback: { ...EMPTY } });
  return saved;
}

/** Aantal sollicitaties met status 'nieuw' (voor de menu-badge). */
export async function countNewApplicants() {
  const { applicants } = await readAll();
  return Object.values(applicants).filter((a) => a.status === 'nieuw').length;
}
