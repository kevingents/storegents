# GENTS Portal — Next.js starter (de hardened laag)

> Aanvulling op `03_FRONTEND-NEXT.md`. Dit bestand bevat de **paste-klare code**
> die de gaten dicht uit de review: een veilige BFF (per-pad rechten-check +
> content-type/stream-passthrough + identity-doorgifte), auth-routes met
> httpOnly-cookies, middleware, het `<Can>`-systeem, de actieve-winkel-context,
> de perm-map, plus de CSV-aanvullingen.
>
> Aannames: **Next 15 (App Router)**, Node-runtime, TypeScript. In Next 15 zijn
> `cookies()` en route-`params` async — daar is de code op geschreven.

---

## 0. Env

```bash
# .env.local  (server-only — GEEN NEXT_PUBLIC_ prefix!)
BACKEND_API_BASE=https://storegents.vercel.app
ADMIN_TOKEN=__zet_de_echte_admin_token__
SESSION_SECRET=__lange_random_string_voor_cookie_signing__
```

---

## 1. `lib/session.ts` — sessie + perms uit httpOnly-cookies

De client krijgt het admin-token **nooit**. Twee httpOnly-cookies, gezet bij login:
`gents_session` (het backend-sessietoken) en `gents_perms` (JSON met perms +
identity). De BFF leest deze server-side voor de rechten-check.

```ts
// lib/session.ts
import { cookies } from 'next/headers';

export type Identity = { id?: string; email?: string; name?: string; role?: string; stores?: string[] };
export type Session = { token: string; perms: Set<string>; identity: Identity };

export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  const token = jar.get('gents_session')?.value;
  if (!token) return null;
  let perms: string[] = [], identity: Identity = {};
  try {
    const raw = jar.get('gents_perms')?.value;
    if (raw) { const p = JSON.parse(raw); perms = p.perms || []; identity = p.identity || {}; }
  } catch { /* corrupt cookie → lege perms */ }
  return { token, perms: new Set(perms), identity };
}

/** Admin = volledige toegang. Pas dit aan op de echte vorm van /api/me/permissions. */
export function isAdmin(s: Session | null): boolean {
  if (!s) return false;
  return s.identity.role === 'admin' || s.perms.has('*') || s.perms.has('admin');
}
```

---

## 2. `lib/perm-map.ts` — pad → vereiste permissie (de RBAC-kern)

**Regel:** alles onder `/api/admin/*` is **admin-only by default**. Wil je een
niet-admin-rol toegang geven tot een admin-endpoint, voeg dan een regel toe die
het pad aan een perm-key koppelt. Niet-admin-paden (`/api/store`, `/api/srs`,
`/api/me`, `/api/vouchers`, …) gaan buiten deze gate om (alleen sessie nodig).

```ts
// lib/perm-map.ts
// Langste prefix wint; een method-specifieke regel wint van een algemene op
// hetzelfde pad (zodat een SCHRIJF-actie een zwaardere perm kan eisen dan de
// LEES op dezelfde route). Perm-key komt uit 01_feature-tracker.csv.
type Rule = { prefix: string; perm: string; methods?: string[] };

const RULES: Rule[] = [
  // ── Leesrechten (alle methods) → pagina-niveau ──
  { prefix: 'api/admin/dashboard/',             perm: 'page.dashboard' },
  { prefix: 'api/admin/today-stats',            perm: 'page.dashboard' },
  { prefix: 'api/admin/workqueue',              perm: 'page.openstaande-orders' },
  { prefix: 'api/admin/weborders/',             perm: 'page.te-laat' },
  { prefix: 'api/admin/overdue-reminder',       perm: 'page.te-laat' },
  { prefix: 'api/admin/return-logs',            perm: 'page.retouren' },
  { prefix: 'api/admin/customer-returns',       perm: 'page.retouren' },
  { prefix: 'api/admin/inkoop/',                perm: 'page.inkoop-open' },
  { prefix: 'api/admin/revenue',                perm: 'page.omzet' },
  { prefix: 'api/admin/voorraad-gezondheid',    perm: 'page.voorraad-gezondheid' },
  { prefix: 'api/admin/merchandiser',           perm: 'page.merchandiser' },
  { prefix: 'api/admin/reports/',               perm: 'page.rapportages' },
  { prefix: 'api/admin/retail-year-analysis',   perm: 'page.jaaranalyse' },
  { prefix: 'api/admin/omzet-forecast',         perm: 'page.forecast' },
  { prefix: 'api/admin/retail-forecast',        perm: 'page.forecast' },
  { prefix: 'api/admin/forecast-voorraad',      perm: 'page.forecast' },
  { prefix: 'api/admin/report-builder/',        perm: 'page.rapportbouwer' },
  { prefix: 'api/admin/declarations',           perm: 'page.declaraties' },
  { prefix: 'api/admin/hr/verlof',              perm: 'page.hr-verlof' },
  { prefix: 'api/admin/hr/verzuim',             perm: 'page.hr-verzuim' },
  { prefix: 'api/admin/hr/vacancies',           perm: 'page.hr-vacatures' },
  { prefix: 'api/admin/hr/applicants',          perm: 'page.hr-vacatures' },
  { prefix: 'api/admin/hr/',                    perm: 'page.hr' },
  { prefix: 'api/admin/customers/',             perm: 'page.klanten' },
  { prefix: 'api/admin/customer/',              perm: 'page.klanten' },
  { prefix: 'api/admin/top-customers',          perm: 'page.klanten' },
  { prefix: 'api/admin/store-customer-overview',perm: 'page.klanten' },
  { prefix: 'api/admin/customer-timeline',      perm: 'page.klanten' },

  // ── Schrijfrechten (alleen mutaties) → zwaardere actie-perm ──
  { prefix: 'api/admin/order-cancellations/',   perm: 'action.cancel-order',        methods: ['POST','PUT','PATCH','DELETE'] },
  { prefix: 'api/admin/inkoop/',                perm: 'action.inkoop-push',         methods: ['POST','PUT','PATCH','DELETE'] },
  { prefix: 'api/admin/declarations',           perm: 'action.approve-declaration', methods: ['POST','PUT','PATCH','DELETE'] },
  { prefix: 'api/admin/merchandiser',           perm: 'action.merchandiser-verplaats', methods: ['POST','PUT','PATCH','DELETE'] },
  { prefix: 'api/admin/sendcloud-labels',       perm: 'action.create-label',        methods: ['POST','PUT','PATCH'] },
  { prefix: 'api/admin/hr/vacancies',           perm: 'action.manage-vacancies',    methods: ['POST','PUT','PATCH','DELETE'] },
  { prefix: 'api/admin/customer-gdpr-export',   perm: 'action.gdpr-export' },
  // … alles wat hier NIET staat = admin-only (veilige default).
];

/** Vereiste perm voor een admin-pad + method, of null als niet gemapt (→ admin-only). */
export function requiredPermForPath(apiPath: string, method = 'GET'): string | null {
  let best: string | null = null, bestScore = -1;
  for (const r of RULES) {
    if (!apiPath.startsWith(r.prefix)) continue;
    if (r.methods && !r.methods.includes(method.toUpperCase())) continue;
    const score = r.prefix.length + (r.methods ? 1000 : 0); // method-specifiek wint
    if (score > bestScore) { best = r.perm; bestScore = score; }
  }
  return best;
}

/** Paden die zónder sessie mogen (login, health). Houd dit kort. */
const PUBLIC_PREFIXES = ['api/auth/', 'api/health'];
export function isPublicPath(apiPath: string): boolean {
  return PUBLIC_PREFIXES.some((p) => apiPath === p || apiPath.startsWith(p));
}
```

---

## 3. `app/bff/[...path]/route.ts` — de gehardende proxy

Verschillen t.o.v. het voorbeeld in doc 03:
1. **Rechten server-side** (default-deny voor niet-admins op admin-paden).
2. **Admin-token alleen op `/api/admin/*`** (store/srs/me lopen op de sessie).
3. **Identity doorgegeven** (`x-user-id/email`, `x-actor`) voor backend-scoping + audit.
4. **Content-type + body als stream doorgegeven** → CSV/PDF/binaire downloads
   én multipart-uploads werken (geen geforceerde JSON, geen `req.text()`).
5. **`maxDuration`** voor trage SRS/AI-calls.

```ts
// app/bff/[...path]/route.ts
import { NextRequest } from 'next/server';
import { getSession, isAdmin } from '@/lib/session';
import { requiredPermForPath, isPublicPath } from '@/lib/perm-map';

export const runtime = 'nodejs';
export const maxDuration = 60; // SRS ~20s, AI (hq-bot/brand-fit) kan langer

const BACKEND = process.env.BACKEND_API_BASE!;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN!;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function handler(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const apiPath = `api/${path.join('/')}`;
  const sess = await getSession();
  const admin = isAdmin(sess);

  // 1) Auth: alles behalve de publieke allowlist vereist een sessie.
  if (!sess && !isPublicPath(apiPath)) return json(401, { error: 'unauthenticated' });

  // 2) Admin-paden: rechten afdwingen (default-deny voor niet-admins).
  const isAdminPath = apiPath.startsWith('api/admin/');
  if (isAdminPath && !admin) {
    const need = requiredPermForPath(apiPath, req.method);
    if (!need || !sess!.perms.has(need)) return json(403, { error: 'forbidden', path: apiPath, need });
  }

  // 3) Upstream-request opbouwen — content-type + body 1-op-1 doorgeven.
  const url = `${BACKEND}/${apiPath}${req.nextUrl.search}`;
  const headers = new Headers();
  const ct = req.headers.get('content-type'); if (ct) headers.set('content-type', ct);
  const accept = req.headers.get('accept'); if (accept) headers.set('accept', accept);
  if (sess) {
    headers.set('authorization', `Bearer ${sess.token}`);
    if (sess.identity.id) headers.set('x-user-id', String(sess.identity.id));
    if (sess.identity.email) headers.set('x-user-email', String(sess.identity.email));
    if (sess.identity.name) headers.set('x-actor', String(sess.identity.name));
  }
  // Actieve winkel (zie §7) — backend scoped hierop waar relevant.
  const store = req.headers.get('x-store'); if (store) headers.set('x-store', store);
  // Admin-token UITSLUITEND op admin-paden.
  if (isAdminPath) headers.set('x-admin-token', ADMIN_TOKEN);

  const hasBody = !['GET', 'HEAD'].includes(req.method);
  const upstream = await fetch(url, {
    method: req.method,
    headers,
    body: hasBody ? req.body : undefined,
    // Node-fetch streaming body vereist duplex:
    ...(hasBody ? { duplex: 'half' } : {}),
    redirect: 'manual',
    cache: 'no-store',
  } as RequestInit);

  // 4) Response 1-op-1 terug (JSON/CSV/PDF/binary), met download-headers.
  const out = new Headers();
  for (const h of ['content-type', 'content-disposition', 'content-length', 'cache-control']) {
    const v = upstream.headers.get(h); if (v) out.set(h, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export {
  handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE,
};
```

---

## 4. Auth-routes (cookie zetten/wissen)

```ts
// app/api/auth/login/route.ts
import { cookies } from 'next/headers';
const BACKEND = process.env.BACKEND_API_BASE!;
const cookieOpts = { httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/' };

async function fetchPerms(token: string) {
  const r = await fetch(`${BACKEND}/api/me/permissions`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
  const d = await r.json().catch(() => ({}));
  return { perms: d.permissions || [], identity: d.identity || {} };
}

export async function POST(req: Request) {
  const body = await req.json();              // { mode, ... }
  const url = body.mode === 'office' ? '/api/auth/login-office' : '/api/srs/personnel/login';
  const upstream = await fetch(`${BACKEND}${url}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) return Response.json({ error: data.message || 'login mislukt' }, { status: upstream.status });
  if (data.requires2FA) return Response.json({ requires2FA: true });   // office → vervolg met verify-2fa

  const token = data.token || data.sessionToken;
  if (!token) return Response.json({ error: 'geen token ontvangen' }, { status: 502 });
  const { perms, identity } = await fetchPerms(token);
  const jar = await cookies();
  jar.set('gents_session', token, { ...cookieOpts, maxAge: 60 * 60 * 12 });           // 12u
  jar.set('gents_perms', JSON.stringify({ perms, identity }), { ...cookieOpts, maxAge: 60 * 60 * 12 });
  return Response.json({ ok: true, identity });
}
```

```ts
// app/api/auth/verify-2fa/route.ts  (office 2FA-vervolg)
import { cookies } from 'next/headers';
const BACKEND = process.env.BACKEND_API_BASE!;
const cookieOpts = { httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/' };

export async function POST(req: Request) {
  const body = await req.json();
  const upstream = await fetch(`${BACKEND}/api/auth/verify-2fa`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) return Response.json({ error: data.message || '2FA mislukt' }, { status: upstream.status });
  const token = data.token || data.sessionToken;
  const r = await fetch(`${BACKEND}/api/me/permissions`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
  const d = await r.json().catch(() => ({}));
  const jar = await cookies();
  jar.set('gents_session', token, { ...cookieOpts, maxAge: 60 * 60 * 12 });
  jar.set('gents_perms', JSON.stringify({ perms: d.permissions || [], identity: d.identity || {} }), { ...cookieOpts, maxAge: 60 * 60 * 12 });
  return Response.json({ ok: true });
}
```

```ts
// app/api/auth/logout/route.ts
import { cookies } from 'next/headers';
export async function POST() {
  const jar = await cookies();
  jar.delete('gents_session'); jar.delete('gents_perms');
  return Response.json({ ok: true });
}
```

> **Perms verlopen samen met de 12u-sessie.** Wijzigen rollen tussendoor? Voeg
> een `POST /api/auth/refresh-perms` toe die `gents_perms` opnieuw zet (zelfde
> `fetchPerms`), of laat de gebruiker opnieuw inloggen.

---

## 5. `middleware.ts` — sessie-guard

```ts
// middleware.ts
import { NextRequest, NextResponse } from 'next/server';

const PUBLIC = ['/login', '/api/auth'];
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  // BFF doet z'n eigen auth; statics/_next overslaan.
  if (pathname.startsWith('/bff') || pathname.startsWith('/_next') || pathname.includes('.')) return NextResponse.next();
  if (PUBLIC.some((p) => pathname.startsWith(p))) return NextResponse.next();
  if (!req.cookies.get('gents_session')) {
    const u = req.nextUrl.clone(); u.pathname = '/login'; u.searchParams.set('next', pathname);
    return NextResponse.redirect(u);
  }
  return NextResponse.next();
}
export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
```

---

## 6. Permissions-context + `<Can>` + server-gate

```tsx
// components/permissions.tsx  ('use client')
'use client';
import { createContext, useContext, useEffect, useState } from 'react';
const Ctx = createContext<Set<string>>(new Set());
export function PermissionsProvider({ children }: { children: React.ReactNode }) {
  const [perms, setPerms] = useState<Set<string>>(new Set());
  useEffect(() => {
    fetch('/bff/api/me/permissions').then((r) => r.json())
      .then((d) => setPerms(new Set(d.permissions || []))).catch(() => {});
  }, []);
  return <Ctx.Provider value={perms}>{children}</Ctx.Provider>;
}
export const usePermissions = () => useContext(Ctx);
export function Can({ perm, children }: { perm: string; children: React.ReactNode }) {
  return usePermissions().has(perm) ? <>{children}</> : null;
}
```

```ts
// lib/guard.ts  — server-side gate in pages/route-handlers (NIET alleen CSS)
import { getSession, isAdmin } from '@/lib/session';
import { redirect } from 'next/navigation';
export async function requirePerm(perm: string) {
  const s = await getSession();
  if (!s) redirect('/login');
  if (!isAdmin(s) && !s.perms.has(perm)) redirect('/403');
  return s;
}
// gebruik bovenin een page.tsx:  await requirePerm('page.retouren');
```

---

## 7. Actieve-winkel-context (de cross-cutting scope)

Bijna elke datacall is winkel-gescoped. Houd de gekozen winkel globaal bij en
stuur 'm als `x-store` mee (de BFF forwardt 'm; backend scoped hierop).

```tsx
// components/active-store.tsx  ('use client')
'use client';
import { createContext, useContext, useState } from 'react';
const Ctx = createContext<{ store: string; setStore: (s: string) => void }>({ store: '', setStore: () => {} });
export function ActiveStoreProvider({ initial = '', children }: { initial?: string; children: React.ReactNode }) {
  const [store, setStore] = useState(initial);
  return <Ctx.Provider value={{ store, setStore }}>{children}</Ctx.Provider>;
}
export const useActiveStore = () => useContext(Ctx);
```

```ts
// lib/api.ts — typed client tegen /bff, met x-store + download-support
import { useActiveStore } from '@/components/active-store';

async function call<T>(path: string, init: RequestInit = {}, store?: string): Promise<T> {
  const headers = new Headers(init.headers);
  if (store) headers.set('x-store', store);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const r = await fetch(`/bff/${path}`, { ...init, headers });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  const ct = r.headers.get('content-type') || '';
  return (ct.includes('application/json') ? r.json() : r.blob()) as Promise<T>;
}
export const api = {
  get:  <T>(p: string, store?: string) => call<T>(p, {}, store),
  post: <T>(p: string, body?: unknown, store?: string) => call<T>(p, { method: 'POST', body: JSON.stringify(body ?? {}) }, store),
  put:  <T>(p: string, body?: unknown, store?: string) => call<T>(p, { method: 'PUT', body: JSON.stringify(body ?? {}) }, store),
  del:  <T>(p: string, store?: string) => call<T>(p, { method: 'DELETE' }, store),
};
// hook-variant die de actieve winkel auto-meeneemt:
export function useApi() { const { store } = useActiveStore(); return {
  get:  <T>(p: string) => api.get<T>(p, store),
  post: <T>(p: string, b?: unknown) => api.post<T>(p, b, store),
}; }
```

> **Let op per endpoint:** sommige backend-routes lezen de winkel uit een
> querystring (`?store=...`/`?branchId=...`) i.p.v. een header. Bevestig per
> endpoint (kolom in `02_endpoint-inventory.csv`) en stuur dan de query mee.

---

## 8. Niet-code-checklist (anders mis je dit)

- [ ] **Web-push + service worker** porten: `/api/push/subscribe`, `/api/push/vapid-public-key`, een `public/sw.js`, en de notificatie-inbox-polling (`/api/notifications/*`, `/api/me/taken`-badge).
- [ ] **Caching**: zet `cache: 'no-store'` (of `export const dynamic = 'force-dynamic'`) op alle **live** views: `article-search-live`, `stock-lookup`, `reserveringen`, voorraad. Server Components cachen anders stil.
- [ ] **`maxDuration`** op de BFF (staat hierboven) + op pages die trage SRS/AI-data server-side laden.
- [ ] **Storefront blijft in de Shopify-theme**: mix&match-widget, kleur-varianten, voorraad-op-productpagina, `/api/storefront/*` — NIET porten naar `storeportal_next`.
- [ ] **Multi-parent modals**: refund/pickup/label openen vanuit meerdere lijsten → top-level route + intercept vanuit elke lijst (anders breekt de 2e deep-link).
- [ ] **Body-limiet**: uploads (CV, factuur, beeldbank, voorraad-CSV) kunnen >4,5MB → zet de juiste limiet/route-config of upload direct naar blob.
- [ ] **`isAdmin()` afstemmen** op de echte vorm van `/api/me/permissions` (rolveld vs. `*`-perm).

---

## 9. CSV-aanvullingen (paste-klaar)

### 9a. `02_endpoint-inventory.csv` — ontbrekende rij

```csv
"6","admin","","/api/admin/brand-fit","GET/POST","admin-token","admin/brand-fit.js","todo"
```

### 9b. `01_feature-tracker.csv` — Wave-6 sub-tracker (pagina's die nu géén rij hebben)

> Deze pagina's bestaan in het huidige portaal maar ontbreken als feature. Perm-keys
> zijn voorstellen — stem af op `lib/user-roles.js` als ze daar al bestaan.

```csv
"6","Marketing","page","page.marketing-poas","Marketing — POAS / winst-op-ads","/marketing-poas","admin only","","/api/admin/marketing-poas, /api/admin/marketing-mer","","todo"
"6","Marketing","page","page.marketing-analytics","Marketing — analytics","/marketing-analytics","admin only","","/api/admin/marketing-analytics, /api/admin/marketing-winkelprestaties","","todo"
"6","Marketing","page","page.advertenties","Lopende advertenties (Google/Meta)","/advertenties","admin only","","/api/admin/running-ads, /api/admin/ad-campaign-status","","todo"
"6","Marketing","page","page.social-stats","Social media-statistieken","/social-stats","admin only","","/api/admin/social-stats, /api/admin/brand-fit","","todo"
"6","Marketing","page","page.spotler","Spotler e-mailmarketing","/spotler","admin only","","/api/admin/spotler-metrics, /api/admin/spotler-audience","","todo"
"6","Marketing","page","page.meta-boost","Post boosten (Meta Ads)","/meta-boost","admin only","","/api/admin/meta-boost","","todo"
"6","Content","page","page.content-beheer","Content-beheer (AI-beschrijvingen)","/content-beheer","admin only","","/api/admin/content-checks, /api/admin/content-generate-description, /api/admin/content-save-description","","todo"
"6","Content","page","page.content-kalender","Content-kalender","/content-kalender","admin only","","/api/admin/content-calendar","","todo"
"6","Content","page","page.beeldbank","Beeldbank","/beeldbank","admin only","","/api/admin/beeldbank, /api/admin/beeldbank-classify, /api/admin/beeldbank-dedup","","todo"
"6","Content","page","page.brandbook","Merk-assets (brandbook)","/brandbook","admin only","","/api/admin/brandbook","","todo"
"6","Content","page","page.seo-ranking","SEO-ranking (+ PageSpeed, Ads-zoektermen, merk-fit)","/seo-ranking","admin only","","/api/admin/seo-ranking, /api/admin/pagespeed, /api/admin/marketing-search-terms, /api/admin/brand-fit","","todo"
"6","Content","page","page.ai-vindbaarheid","AI-vindbaarheid","/ai-vindbaarheid","admin only","","/api/admin/ai-visibility","","todo"
"6","Klanten","page","page.klantvragen","Klantvragen (inquiries)","/klantvragen","admin only","","/api/admin/customer-inquiries","","todo"
"6","Systeem","page","page.hq-bot","GENTS HQ-bot (AI-assistent)","/hq-bot","admin only","","/api/admin/hq-bot","","todo"
```

> **Mega-features om apart op te splitsen vóór je begint (1 trackerrij = heel subsysteem):**
> - `page.bol` → ~25 endpoints: orders, returns, stock-sync, content, pricing, insights, diagnose, settings, shipment-sync, srs-sync, cancel. Maak een eigen bol-sub-tracker.
> - `page.instellingen` → ~15 config-modals: bol-settings, order-cutoff-config, reservering-config, verzendkosten-config, store-ip-config, winkel-scope-config, portal-config, feature-flags, supplychain-metrics-config, customer-report-mail-config, risky-actions-config, store-emails, dhl-hubs, werktijden, resend-sender/audience.

---

## 10. Volgorde van bouwen (golf 0, concreet)

1. Env + `lib/session.ts` + `lib/perm-map.ts`.
2. `app/bff/[...path]/route.ts` (de hardened proxy).
3. Auth-routes (`login`/`verify-2fa`/`logout`) + `middleware.ts`.
4. `PermissionsProvider` + `Can` + `lib/guard.ts` + `ActiveStoreProvider` in de
   portal-layout.
5. `lib/api.ts`. Test met `page.dashboard` (`/api/admin/dashboard/location-overview`).
6. Eerste echte pagina → daarna golf 1 zoals in doc 03.
```
