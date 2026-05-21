/**
 * Mapt department-namen (Hoofdkantoor / Logistiek / Finance / ...) naar
 * een virtuele-winkel key (= 'Afdeling') uit DEFAULT_CONFIGS in
 * virtual-store-configs.js.
 *
 * Wanneer een office-user logt in:
 *   1. zijn department wordt opgezocht in deze map
 *   2. de matched virtual-store wordt zijn default-store → applySupplychainView
 *      (etc.) firet automatisch en filtert de admin-shell op die afdeling
 *   3. de dropdown wordt gefilterd op alleen die afdeling + zijn allowedStores
 *
 * Onbekende departments → null (geen automatische afdelings-koppeling,
 * gebruiker landt op ADMIN_STORE of zijn 1e allowedStore).
 *
 * Admin gebruikt deze map NIET — die ziet altijd alles ongeacht department.
 */

export const DEPARTMENT_TO_AFDELING = {
  /* Supply chain / logistiek */
  'Logistiek / magazijn':  'Supplychain',
  'Logistiek':              'Supplychain',
  'Magazijn':               'Supplychain',
  'Supply chain':           'Supplychain',
  'Supplychain':            'Supplychain',
  'Inkoop':                 'Supplychain',

  /* Finance */
  'Finance':                'Finance',
  'Financieel':             'Finance',
  'Boekhouding':            'Finance',

  /* Studentenverenigingen team */
  'Students':               'Students',
  'Studenten':              'Students',
  'Vereniging':             'Students',

  /* Suitconcer B2B */
  'Suitconcer':             'Suitconcer',
  'B2B':                    'Suitconcer'
};

/**
 * Resolve een department naar een virtuele-winkel key. Hoofdletter-ongevoelig
 * + ondersteunt prefix-match (bv "Logistiek/magazijn ZW" → 'Supplychain').
 *
 * @param {string} department  uit user-permissions.department
 * @returns {string|null}      virtual-store key, of null als geen match
 */
export function resolveAfdelingForDepartment(department) {
  if (!department) return null;
  const dept = String(department).trim();
  if (!dept) return null;

  /* Exact match (case-sensitive) */
  if (DEPARTMENT_TO_AFDELING[dept]) return DEPARTMENT_TO_AFDELING[dept];

  /* Case-insensitive match */
  const lower = dept.toLowerCase();
  for (const [key, val] of Object.entries(DEPARTMENT_TO_AFDELING)) {
    if (key.toLowerCase() === lower) return val;
  }

  /* Prefix match: department start met een mapped naam */
  for (const [key, val] of Object.entries(DEPARTMENT_TO_AFDELING)) {
    if (lower.startsWith(key.toLowerCase() + ' ') || lower.startsWith(key.toLowerCase() + '/')) return val;
  }

  /* Contains match: department bevat een mapped trefwoord */
  for (const [key, val] of Object.entries(DEPARTMENT_TO_AFDELING)) {
    if (lower.includes(key.toLowerCase())) return val;
  }

  return null;
}
