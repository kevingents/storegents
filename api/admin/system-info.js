import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { list } from '@vercel/blob';
import { BUSINESS_CONFIG } from '../../lib/business-config.js';

/**
 * /api/admin/system-info
 *
 * Operationeel-overzicht endpoint. Complementair aan /api/admin/system-health
 * (die test live endpoints). Dit endpoint vertelt WAT er geconfigureerd is
 * en HOE de omgeving eruit ziet:
 *
 *   - env-vars: welke zijn gezet vs ontbreken (waarde NOOIT teruggegeven)
 *   - deployment: commit-sha, build-time, Vercel-region, Node-versie
 *   - blob-storage: pad-prefix → entries-count + totale-grootte
 *   - business-config: snapshot van actieve waardes
 *   - integraties: welke externe systemen zijn er, configured: true/false
 *
 * Bedoeld voor de admin "Systeem-info" modal — geeft een nieuwe operator
 * direct inzicht in wat er allemaal draait.
 *
 * Security: admin-token vereist. Geeft NOOIT actual env-var-waardes terug
 * (alleen presence/absence) — anders is dit een credential-leak.
 */

const EXPECTED_ENV_VARS = [
  /* === Secrets === */
  { name: 'ADMIN_TOKEN', label: 'Admin auth-token', critical: true, category: 'auth', aliases: ['GENTS_ADMIN_TOKEN', 'ADMIN_PIN', 'ADMIN_MASTER_PIN', 'GENTS_ADMIN_MASTER_PIN'] },
  { name: 'CRON_SECRET', label: 'Vercel cron secret', critical: true, category: 'auth' },
  { name: 'BLOB_READ_WRITE_TOKEN', label: 'Vercel Blob token', critical: true, category: 'storage' },

  /* === Shopify === */
  { name: 'SHOPIFY_STORE_DOMAIN', label: 'Shopify shop-domain', critical: true, category: 'shopify', aliases: ['SHOPIFY_SHOP_DOMAIN', 'SHOPIFY_STORE_URL', 'SHOPIFY_DOMAIN', 'SHOPIFY_SHOP', 'SHOPIFY_STORE'] },
  { name: 'SHOPIFY_ADMIN_ACCESS_TOKEN', label: 'Shopify admin token', critical: true, category: 'shopify', aliases: ['SHOPIFY_ACCESS_TOKEN', 'SHOPIFY_ADMIN_API_TOKEN', 'SHOPIFY_ADMIN_TOKEN', 'SHOPIFY_API_TOKEN'] },
  { name: 'SHOPIFY_API_VERSION', label: 'Shopify API versie', critical: false, category: 'shopify' },
  { name: 'SHOPIFY_SRS_METAFIELD_NS', label: 'SRS metafield namespace', critical: false, category: 'shopify' },

  /* === SRS === */
  { name: 'SRS_USERNAME', label: 'SRS SOAP gebruiker', critical: true, category: 'srs', aliases: ['SRS_USER', 'SRS_API_USER', 'SRS_API_USERNAME'] },
  { name: 'SRS_PASSWORD', label: 'SRS SOAP wachtwoord', critical: true, category: 'srs', aliases: ['SRS_API_PASSWORD'] },
  { name: 'SRS_SOAP_URL', label: 'SRS SOAP endpoint', critical: false, category: 'srs', aliases: ['SRS_BASE_URL', 'SRS_API_BASE_URL', 'SRS_MESSAGE_BASE_URL'] },
  { name: 'SRS_SOAP_TIMEOUT_MS', label: 'SRS timeout (default 20000)', critical: false, category: 'srs' },

  /* === Mail === */
  { name: 'RESEND_API_KEY', label: 'Resend mail API key', critical: true, category: 'mail' },
  { name: 'SUPPORT_EMAIL', label: 'Support-mailadres fallback', critical: false, category: 'mail' },
  { name: 'WEBORDER_MAIL_FROM', label: 'Mail-from voor weborder-mails', critical: false, category: 'mail', aliases: ['MAIL_FROM', 'RESEND_FROM_EMAIL'] },

  /* === Externe services === */
  { name: 'GOOGLE_PLACES_API_KEY', label: 'Google Places API key', critical: false, category: 'integrations', aliases: ['GOOGLE_API_KEY', 'GOOGLE_REVIEWS_API_KEY', 'GOOGLE_API_VERCEL_KEY'] },
  { name: 'GOOGLE_SERVICE_ACCOUNT_JSON', label: 'Google Business Profile auth', critical: false, category: 'integrations', aliases: ['GOOGLE_BUSINESS_REFRESH_TOKEN', 'GOOGLE_BUSINESS_CLIENT_SECRET'] },
  { name: 'SENDCLOUD_PUBLIC_KEY', label: 'Sendcloud public key', critical: false, category: 'integrations' },
  { name: 'SENDCLOUD_SECRET_KEY', label: 'Sendcloud secret key', critical: false, category: 'integrations' },
  { name: 'RETURNISTA_API_TOKEN', label: 'Returnista API token', critical: false, category: 'integrations' },

  /* === Business config overrides (optioneel) === */
  { name: 'WEBORDER_DEADLINE_OPERATIONAL_DAYS', label: 'Override weborder-deadline (dagen)', critical: false, category: 'overrides' },
  { name: 'EXCHANGE_DEADLINE_OPERATIONAL_DAYS', label: 'Override uitwisseling-deadline', critical: false, category: 'overrides' },
  { name: 'DRAGER_DEADLINE_HOURS', label: 'Override drager-deadline (uren)', critical: false, category: 'overrides' },
  { name: 'MAIL_MAX_RECIPIENTS', label: 'Override max-recipients rapportage', critical: false, category: 'overrides' },
  { name: 'PERSONNEL_SESSION_TTL_SECONDS', label: 'Override sessie-TTL', critical: false, category: 'overrides' },
  { name: 'INVITE_TTL_MS', label: 'Override invite-TTL', critical: false, category: 'overrides' },
  { name: 'MAX_UPLOAD_BYTES', label: 'Override max upload-size', critical: false, category: 'overrides' }
];

function checkEnvVars() {
  const summary = { critical: { present: 0, missing: 0 }, optional: { present: 0, missing: 0 } };
  const items = EXPECTED_ENV_VARS.map((envVar) => {
    /* Accepteer ook alias-namen: de codebase leest sommige waardes onder
       meerdere namen (historische drift). Aanwezig zodra ÉÉN ervan gezet is —
       anders gaf dit endpoint vals-alarm "ontbrekend" terwijl alles werkte. */
    const names = [envVar.name, ...(envVar.aliases || [])];
    let val = '';
    let matchedVia = '';
    for (const n of names) {
      const v = process.env[n];
      if (v && String(v).trim()) { val = String(v); matchedVia = n; break; }
    }
    const present = Boolean(val);
    const bucket = envVar.critical ? 'critical' : 'optional';
    if (present) summary[bucket].present += 1;
    else summary[bucket].missing += 1;
    return {
      name: envVar.name,
      label: envVar.label,
      category: envVar.category,
      critical: envVar.critical,
      present,
      /* Welke (alias-)naam de waarde leverde — handig bij naam-drift. */
      matchedVia: present && matchedVia !== envVar.name ? matchedVia : undefined,
      /* NOOIT de daadwerkelijke waarde teruggeven — alleen lengte als indicator */
      valueLength: present ? val.length : 0
    };
  });
  return { items, summary };
}

async function getBlobOverview() {
  /* Tel entries per pad-prefix. Houdt 200ms timeout per prefix om geen
     loop-timeout te triggeren bij grote stores. */
  const PREFIXES = [
    { prefix: 'config/',           label: 'Admin config' },
    { prefix: 'srs/',              label: 'SRS caches & snapshots' },
    { prefix: 'audit/',            label: 'Audit-logs' },
    { prefix: 'mail-events/',      label: 'Mail events' },
    { prefix: 'shopify/',          label: 'Shopify caches' }
  ];

  const results = [];
  for (const p of PREFIXES) {
    try {
      const r = await list({ prefix: p.prefix, limit: 1000 });
      const blobs = r.blobs || [];
      const totalSize = blobs.reduce((s, b) => s + (Number(b.size) || 0), 0);
      const newest = blobs.reduce((latest, b) => {
        const t = b.uploadedAt ? new Date(b.uploadedAt).getTime() : 0;
        return t > latest ? t : latest;
      }, 0);
      results.push({
        prefix: p.prefix,
        label: p.label,
        count: blobs.length,
        totalSizeBytes: totalSize,
        newestUploadedAt: newest ? new Date(newest).toISOString() : null,
        truncated: r.hasMore || false
      });
    } catch (e) {
      results.push({
        prefix: p.prefix,
        label: p.label,
        count: 0,
        error: e.message || 'list failed'
      });
    }
  }
  return results;
}

function getDeploymentInfo() {
  return {
    nodeVersion: process.version,
    platform: process.platform,
    /* Vercel zet deze automatisch */
    vercelRegion: process.env.VERCEL_REGION || null,
    vercelEnv: process.env.VERCEL_ENV || null,           // 'production' | 'preview' | 'development'
    vercelUrl: process.env.VERCEL_URL || null,
    vercelGitCommitSha: process.env.VERCEL_GIT_COMMIT_SHA || null,
    vercelGitCommitMessage: process.env.VERCEL_GIT_COMMIT_MESSAGE || null,
    vercelGitCommitRef: process.env.VERCEL_GIT_COMMIT_REF || null,
    vercelGitRepoOwner: process.env.VERCEL_GIT_REPO_OWNER || null,
    vercelGitRepoSlug: process.env.VERCEL_GIT_REPO_SLUG || null,
    serverStartedAt: process.env.VERCEL_DEPLOYMENT_CREATED_AT || null,
    uptimeSec: Math.floor(process.uptime())
  };
}

function getBusinessConfigSnapshot() {
  /* Selectief — niet alles teruggeven, alleen de "operationele" knoppen
     zodat het beeldscherm niet overspoelt. */
  return {
    deadlines: BUSINESS_CONFIG.deadlines,
    targets: BUSINESS_CONFIG.targets,
    mail: {
      allowedDomainLabel: BUSINESS_CONFIG.mail.allowedDomainLabel,
      maxRecipientsPerSchedule: BUSINESS_CONFIG.mail.maxRecipientsPerSchedule,
      defaultScheduleHourUtc: BUSINESS_CONFIG.mail.defaultScheduleHourUtc,
      maxUploadBytes: BUSINESS_CONFIG.mail.maxUploadBytes
    },
    session: BUSINESS_CONFIG.session,
    branchesCount: BUSINESS_CONFIG.branches.list.length,
    retailBranchesCount: BUSINESS_CONFIG.branches.list.filter((b) => b.kind === 'retail').length
  };
}

function getIntegrationsList() {
  return [
    { id: 'shopify',    name: 'Shopify Admin API',     configured: Boolean(process.env.SHOPIFY_ADMIN_ACCESS_TOKEN && process.env.SHOPIFY_STORE_DOMAIN), protocol: 'GraphQL', critical: true },
    { id: 'srs',        name: 'SRS ERP (SOAP)',        configured: Boolean(process.env.SRS_USERNAME && process.env.SRS_PASSWORD), protocol: 'SOAP', critical: true },
    { id: 'blob',       name: 'Vercel Blob Storage',   configured: Boolean(process.env.BLOB_READ_WRITE_TOKEN), protocol: 'REST', critical: true },
    { id: 'resend',     name: 'Resend (mail)',         configured: Boolean(process.env.RESEND_API_KEY), protocol: 'REST', critical: true },
    { id: 'google',     name: 'Google Places',         configured: Boolean(process.env.GOOGLE_PLACES_API_KEY), protocol: 'REST', critical: false },
    { id: 'gbp',        name: 'Google Business Profile', configured: Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON), protocol: 'REST', critical: false },
    { id: 'sendcloud',  name: 'Sendcloud (labels)',    configured: Boolean(process.env.SENDCLOUD_SECRET_KEY), protocol: 'REST', critical: false },
    { id: 'returnista', name: 'Returnista (retours)',  configured: Boolean(process.env.RETURNISTA_API_TOKEN), protocol: 'REST', critical: false }
  ];
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (requireAdmin(req, res)) return;

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET.' });
  }

  try {
    const envVars = checkEnvVars();
    const deployment = getDeploymentInfo();
    const businessConfig = getBusinessConfigSnapshot();
    const integrations = getIntegrationsList();
    /* Blob overview is iets langzamer (list-calls) — parallel met rest */
    const blobOverview = await getBlobOverview();

    return res.status(200).json({
      success: true,
      generatedAt: new Date().toISOString(),
      envVars,
      deployment,
      businessConfig,
      integrations,
      blobOverview,
      /* Vooral handig voor de admin-modal: één status-veld dat zegt
         "alles OK" of "X kritieke env-vars ontbreken". */
      overallStatus: envVars.summary.critical.missing === 0 ? 'healthy' : 'critical-missing',
      criticalMissing: envVars.summary.critical.missing
    });
  } catch (error) {
    console.error('[admin/system-info]', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'system-info faalde.'
    });
  }
}
