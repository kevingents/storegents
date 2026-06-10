# GENTS Portal — Frontend-migratie naar Next.js + Tailwind

> Hand-off voor de nieuwe repo **`storeportal_next`**. De backend blijft de
> bestaande Vercel-API in repo `storegents` (`https://storegents.vercel.app`)
> en wijzigt niet. Dit document + de twee CSV's vormen samen de migratie-kit.

## Inhoud van de kit

| Bestand | Doel |
|---|---|
| `01_feature-tracker.csv` | **Stuur hierop.** 141 features (de `page.*`/`action.*`/`data.*` permissies). Per feature: wave, route-voorstel, default-rollen, status. Importeer in Sheets/Excel. |
| `02_endpoint-inventory.csv` | **Dekkingscheck.** Alle 395 frontend-endpoints (excl. cron/webhooks) met route, methods, auth-type, wave. Zo zie je dat niks vergeten wordt. |
| `03_FRONTEND-NEXT.md` | Dit document: architectuur-besluiten + porting-recipe + golvenplan. |

De feature-tracker komt 1-op-1 uit `lib/user-roles.js` (de `PERMISSIONS`-catalogus),
de bron die `/api/me/permissions` als `catalog` teruggeeft. De endpoint-inventaris
is programmatisch uit de `api/`-boom afgeleid.

---

## Schaal

- **395** frontend-relevante endpoints (463 totaal − 65 cron − 3 webhooks).
- **141** features in 19 categorieën; **7** rollen.
- **~80** modals in de huidige Shopify-theme portal.

Dit is een **strangler-fig migratie**: het oude portaal (Shopify-theme) blijft
live; je verhuist domein-voor-domein en redirect oude modals naar de nieuwe routes.

---

## Architectuur-besluiten

### 1. BFF-proxy — admin-token nooit naar de browser (KERNREGEL)

Alle `/api/admin/*` endpoints eisen `x-admin-token: <ADMIN_TOKEN>`. Die token
mag **nooit** in client-code. Eén catch-all Route Handler proxyt server-side en
injecteert token + sessie — daarmee zijn **alle 395 endpoints in één keer
bereikbaar** (geen route-per-endpoint).

```ts
// app/bff/[...path]/route.ts
import { cookies } from 'next/headers';
const BACKEND = process.env.BACKEND_API_BASE!;   // https://storegents.vercel.app
const ADMIN_TOKEN = process.env.ADMIN_TOKEN!;     // server-only, GEEN NEXT_PUBLIC_

async function proxy(req: Request, { params }: { params: { path: string[] } }) {
  const session = (await cookies()).get('gents_session')?.value;
  const url = `${BACKEND}/api/${params.path.join('/')}${new URL(req.url).search}`;
  const res = await fetch(url, {
    method: req.method,
    headers: {
      'content-type': 'application/json',
      'x-admin-token': ADMIN_TOKEN,
      ...(session ? { authorization: `Bearer ${session}` } : {}),
    },
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : await req.text(),
  });
  return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json' } });
}
export { proxy as GET, proxy as POST, proxy as PATCH, proxy as PUT, proxy as DELETE };
```

De client praat dus alleen met `/bff/...`. (Optioneel: voor granulaire perm-checks
stuurt de backend ook `x-user-id`/`x-user-email` mee — uit de sessie te halen.)

### 2. Auth (exacte endpoints)

- **Winkelmedewerker**: `POST /api/srs/personnel/login` (personnelNumber + pincode)
  → HMAC-getekend sessietoken, 12u TTL (zie `lib/personnel-session.js`). Daarna
  als `Authorization: Bearer <token>`.
- **Hoofdkantoor**: `POST /api/auth/login-office` (email + wachtwoord). Bij 2FA
  komt `requires2FA: true` terug → vervolg met `POST /api/auth/verify-2fa`.
- **Permissies + scope**: `GET /api/me/permissions` → `{ permissions: [...],
  identity, catalog }`.

Sla het sessietoken op in een **httpOnly-cookie** (gezet via een Next Route
Handler), **niet** in localStorage. `middleware.ts` checkt de cookie en redirect
naar `/login`. (Dit is meteen een security-verbetering t.o.v. het huidige
`localStorage`-portaal.)

### 3. CORS

De backend staat al `Access-Control-Allow-Origin: *` toe met headers
`Content-Type, x-admin-token, x-admin-pin, authorization, x-user-id,
x-user-email, x-actor`. `/api/store/*` is token-loos; `/api/admin/*` vereist de
token (dus via de BFF). Laat voor consistentie alles via de BFF lopen.

### 4. Permission-driven UI

Haal `/api/me/permissions` 1× na login op, zet in context. Gate met een component:

```tsx
export function Can({ perm, children }: { perm: string; children: React.ReactNode }) {
  const perms = usePermissions();        // Set<string> uit context
  return perms.has(perm) ? <>{children}</> : null;
}
// <Can perm="page.retouren"><NavLink href="/retouren" /></Can>
```

De perm-keys staan in kolom `Perm-key` van de tracker. Gate **ook server-side**
(in de page/route), niet alleen met CSS.

### 5. Modals → intercepting routes

De ~80 modals worden Next **parallel + intercepting routes** (`@modal` + `(.)`):
klik vanuit een lijst = overlay-modal; open de URL direct = volwaardige pagina.
Lost de huidige `?modal=xxx`-hack op en geeft deep-linking gratis.

### 6. SRS is traag

SRS-calls duren 15-20s en zijn serieel. Gebruik **Server Components + Suspense/
streaming** met skeletons en leun op de gecachte endpoints (snapshots via cron).

### 7. Tailwind design tokens

```ts
// tailwind.config.ts → theme.extend.colors
navy:  '#0a1f33',   // primair
slate: '#3a4a5a',   // tekst-secundair
cream: '#f5f5f2',   // achtergrond
```

Overweeg **shadcn/ui** (Tailwind + Radix) voor tabellen, dialogs en forms —
scheelt enorm bij 80+ schermen.

### 8. Env

```
BACKEND_API_BASE=https://storegents.vercel.app   # server
ADMIN_TOKEN=...                                   # server-only, GEEN NEXT_PUBLIC_
```

### 9. Projectstructuur (App Router)

```
app/
  (auth)/login/page.tsx
  (portal)/
    layout.tsx              # sidebar-nav + page-header = de "shell"
    dashboard/page.tsx
    <domein>/<feature>/page.tsx
    @modal/(.)…/page.tsx     # intercepting route = modal mét deep-link
  bff/[...path]/route.ts     # de proxy
  api/auth/*                 # cookie zetten/wissen
lib/api.ts                   # typed client tegen /bff
components/                  # Can, KpiCard, DataTable, Modal, Form, FilterBar
middleware.ts                # sessie-guard
tailwind.config.ts
```

---

## De porting-recipe (zelfde 5 stappen per feature)

Omdat de BFF de backend-wiring al dekt, is elke feature alleen UI:

1. **Tracker** — zet de rij in `01_feature-tracker.csv` op `Status: bezig`, vul
   `Eigenaar` + (uit de oude theme) de `Oude modal`-naam (`data-modal="..."`).
2. **Route** — maak `app/(portal)/<domein>/<feature>/page.tsx`
   (of `@modal/(.)…` voor modal-UX). Route-voorstel staat in de tracker.
3. **Data** — zoek het backing-endpoint op in `02_endpoint-inventory.csv`
   (filter op domein/keyword), bevestig in de backend, en call via
   `lib/api` → `/bff/api/...`. Server Component voor load, `useApi`-hook voor
   mutaties.
4. **Gate** — wikkel in `<Can perm="<perm-key>">`. Gate ook in de route zelf.
5. **Parity + cutover** — test tegen de oude modal (zie
   `docs/admin-smoke-checklist.md` in `storegents`), zet `Status: done`, en
   redirect de oude modal naar de nieuwe route.

---

## Golvenplan (volgorde = dagelijks gebruik × waarde × laag risico)

| Golf | Focus | Features | Voorbeeldcategorieën |
|---|---|---|---|
| **0** | Fundament (mijlpaal 1) | 3 + auth | Databereik, login, shell, dashboard, BFF, `<Can>` |
| **1** | Winkelvloer (dagelijks) | 17 | Dagelijks werk, Klanten |
| **2** | Orders, voorraad, transport, inkoop | 37 | Orders & verkoop, Voorraad, Transport, Inkoop |
| **3** | Rapportage & KPI | 17 | Rapportages & data |
| **4** | Finance, HR, beheer, systeem | 36 | Finance, HR, Beheer, Systeem |
| **5** | Support, communicatie, niche | 23 | Communicatie, Facilitair, Students, Reviews |
| **6** | Lange staart (eerst auditen!) | 8 + ~188 losse admin-endpoints | Marketing, Marketplace (bol), Suitconcer |

> Golf 1 bouwt meteen je gedeelde primitives (`DataTable`, `Form`, `Modal`,
> `KpiCard`) — daarna gaat elke volgende feature snel.

> **Wave 6 = audit-moment.** De ~188 losse `admin/*.js` (bol, google-ads, meta,
> pinterest, spotler, seo, content-calendar, mixmatch, newsletter, ai-visibility…)
> zijn deels mogelijk niet meer in gebruik. Inventariseer eerst via de tracker,
> schrap dode endpoints, port alleen de levende.

---

## Hoe gebruik je de twee CSV's samen

- **Tracker** = wát je bouwt en in welke volgorde (UX/feature-niveau).
- **Inventory** = welke endpoint(s) erachter zitten (technisch niveau).

Voorbeeld-koppeling (bevestig altijd in de backend):

| Feature (tracker) | Backing endpoint(s) (inventory) |
|---|---|
| `page.dashboard` | `/api/admin/dashboard/location-overview` |
| `page.retouren` / `action.refund` | `/api/return-refund`, `/api/srs/return`, `/api/admin/return-logs/*` |
| `page.article-search` | `/api/store/article-search`, `/api/store/article-search-live` |
| `page.vouchers` | `/api/vouchers/*`, `/api/admin/vouchers/*` |

Filter de inventory op `Domein`/keyword om de rest te vinden; een feature mapt
vaak naar meerdere endpoints (load + mutatie).

---

## Eerste mijlpaal (golf 0)

Werkende basis: login-flow (personnel + office), portal-shell met sidebar, een
dashboard-pagina, de BFF-proxy, cookie-auth + middleware, en het `<Can>`-component.
Commit → push → draft-PR. Daarna: golf 1.
