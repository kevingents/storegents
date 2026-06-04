/**
 * Admin-endpoint voor welkom-mail automation.
 *
 *   GET    /api/admin/welkom-mail                            → config + stats
 *   POST   ?action=dry-run                                    → preview wat zou worden gestuurd
 *   POST   ?action=run-now            body: { onlyStore?: 'GENTS Amsterdam' }
 *   POST   ?action=save-config        body: { stores: {...}, lookbackHours?, maxPerRun? }
 *   POST   ?action=save-store         body: { store: 'GENTS Amsterdam', enabled, subject, fromLocalPart, voucherCode }
 *   POST   ?action=test-mail          body: { to, store } → 1 mail naar test-adres
 */

import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { runWelkomMailAutomation } from '../../lib/welkom-mail-automation.js';
import {
  getWelkomMailConfig,
  saveWelkomMailConfig,
  saveStoreConfig,
  readWelkomMailStats,
  markWelkomMailSent,
  getStoreDefaults,
  STORE_DEFAULTS
} from '../../lib/welkom-mail-store.js';
import { sendMail, baseMailHtml } from '../../lib/gents-mailer.js';

export const maxDuration = 300;

function clean(v) { return String(v == null ? '' : v).trim(); }

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      const [cfg, stats] = await Promise.all([getWelkomMailConfig(), readWelkomMailStats()]);
      return res.status(200).json({ success: true, config: cfg, stats });
    }

    const action = clean(req.query?.action);
    const body = parseBody(req);

    if (action === 'dry-run') {
      const out = await runWelkomMailAutomation({ dryRun: true, onlyStore: clean(body.onlyStore) });
      return res.status(200).json({ success: true, ...out });
    }

    if (action === 'run-now') {
      const out = await runWelkomMailAutomation({ dryRun: false, onlyStore: clean(body.onlyStore) });
      return res.status(200).json({ success: true, ...out });
    }

    if (action === 'save-config') {
      const patch = {};
      if (body.lookbackHours != null) patch.lookbackHours = Math.max(1, Math.min(168, Number(body.lookbackHours) || 24));
      if (body.maxPerRun != null) patch.maxPerRun = Math.max(1, Math.min(500, Number(body.maxPerRun) || 50));
      if (body.stores && typeof body.stores === 'object') patch.stores = body.stores;
      const cfg = await saveWelkomMailConfig(patch);
      return res.status(200).json({ success: true, config: cfg });
    }

    if (action === 'save-store') {
      const store = clean(body.store);
      if (!store) return res.status(400).json({ success: false, message: 'store verplicht' });
      const patch = {};
      if (body.enabled != null) patch.enabled = !!body.enabled;
      if (body.branchId != null) patch.branchId = clean(body.branchId);
      if (body.subject != null) patch.subject = clean(body.subject).slice(0, 200);
      /* Nieuwe persoonlijke-afzender velden (vervangen fromLocalPart). */
      if (body.senderName != null) patch.senderName = clean(body.senderName).slice(0, 120);
      if (body.senderEmail != null) patch.senderEmail = clean(body.senderEmail).toLowerCase().slice(0, 120);
      /* Backwards-compat: fromLocalPart blijft accepteren (oude UI). */
      if (body.fromLocalPart != null) patch.fromLocalPart = clean(body.fromLocalPart).toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 60);
      if (body.voucherCode != null) patch.voucherCode = clean(body.voucherCode).toUpperCase().slice(0, 30);
      if (body.addressLine != null) patch.addressLine = clean(body.addressLine).slice(0, 300);
      if (body.openingHours != null) patch.openingHours = clean(body.openingHours).slice(0, 300);
      if (body.alterationsInfo != null) patch.alterationsInfo = clean(body.alterationsInfo).slice(0, 800);
      if (body.loyaltyInfo != null) patch.loyaltyInfo = clean(body.loyaltyInfo).slice(0, 800);
      if (body.googlePlaceId != null) patch.googlePlaceId = clean(body.googlePlaceId).slice(0, 200);
      /* Visual velden (header logo, hero, CTA). */
      if (body.logoUrl != null) patch.logoUrl = clean(body.logoUrl).slice(0, 400);
      if (body.heroImageUrl != null) patch.heroImageUrl = clean(body.heroImageUrl).slice(0, 400);
      if (body.heroImageLink != null) patch.heroImageLink = clean(body.heroImageLink).slice(0, 400);
      if (body.ctaLabel != null) patch.ctaLabel = clean(body.ctaLabel).slice(0, 60);
      if (body.ctaUrl != null) patch.ctaUrl = clean(body.ctaUrl).slice(0, 400);
      /* Signature velden voor footer. */
      if (body.signatureName != null) patch.signatureName = clean(body.signatureName).slice(0, 120);
      if (body.signatureRole != null) patch.signatureRole = clean(body.signatureRole).slice(0, 120);
      if (body.signaturePhone != null) patch.signaturePhone = clean(body.signaturePhone).slice(0, 60);
      if (body.signatureMobile != null) patch.signatureMobile = clean(body.signatureMobile).slice(0, 60);
      const cfg = await saveStoreConfig(store, patch);
      return res.status(200).json({ success: true, config: cfg });
    }

    if (action === 'test-mail') {
      const to = clean(body.to);
      const store = clean(body.store) || 'GENTS Amsterdam';
      if (!to) return res.status(400).json({ success: false, message: 'to verplicht.' });
      const cfg = await getWelkomMailConfig();
      const storeCfg = cfg.stores?.[store] || {};
      /* Echte welkom-template gebruiken (Spotler-stijl) zodat de test exact
         lijkt op wat een klant krijgt. Fake customer met test-voornaam. */
      const { buildWelkomMailHtml, buildSenderFromHeader, tryGoogleOpeningHours, tryGoogleReviews, getCustomerPersonalization } =
        await import('../../lib/welkom-mail-automation.js');
      const fromHeader = buildSenderFromHeader(store, storeCfg);
      /* Parallel: openingstijden + reviews ophalen voor preview. */
      let mailOpts = {};
      try {
        const [gh, gr] = await Promise.all([
          tryGoogleOpeningHours(store, storeCfg).catch(() => null),
          tryGoogleReviews(store, storeCfg).catch(() => null)
        ]);
        if (gh) { mailOpts.googleHoursHtml = gh.html; mailOpts.googleMapsUrl = gh.googleMapsUrl; }
        if (gr) mailOpts.googleReviews = gr;
      } catch {}
      const fakeCustomer = {
        firstName: clean(body.testFirstName) || 'Kevin',
        customerId: clean(body.testCustomerId)  /* optioneel: echte klant-ID voor personalisatie preview */
      };
      /* Als de gebruiker een echte customerId meegeeft: haal punten +
         aankoopgeschiedenis op zodat de preview de personalisatie toont. */
      if (fakeCustomer.customerId) {
        try {
          mailOpts.personalization = await getCustomerPersonalization(fakeCustomer);
        } catch {}
      }
      const html = buildWelkomMailHtml(fakeCustomer, store, storeCfg, mailOpts);
      try {
        const r = await sendMail({
          to,
          subject: `[TEST] ${clean(storeCfg.subject) || `Welkom bij ${store}`}`,
          html,
          from: fromHeader
        });
        return res.status(200).json({ success: true, sentTo: to, messageId: r?.id || r?.messageId || '', from: fromHeader });
      } catch (e) {
        return res.status(500).json({ success: false, message: e.message || 'Test-mail mislukt.' });
      }
    }

    if (action === 'preview') {
      /* Render de welkom-mail HTML zonder echte send. Voor iframe-overlay
         in admin-modal. Gebruikt fake customer + optionele klant-ID voor
         live personalisatie (punten + suggested products). */
      const store = clean(body.store) || 'GENTS Amsterdam';
      const cfg = await getWelkomMailConfig();
      const storeCfg = cfg.stores?.[store] || {};
      const { buildWelkomMailHtml, tryGoogleOpeningHours, tryGoogleReviews, getCustomerPersonalization } =
        await import('../../lib/welkom-mail-automation.js');
      let mailOpts = {};
      try {
        const [gh, gr] = await Promise.all([
          tryGoogleOpeningHours(store, storeCfg).catch(() => null),
          tryGoogleReviews(store, storeCfg).catch(() => null)
        ]);
        if (gh) { mailOpts.googleHoursHtml = gh.html; mailOpts.googleMapsUrl = gh.googleMapsUrl; }
        if (gr) mailOpts.googleReviews = gr;
      } catch {}
      const fakeCustomer = {
        firstName: clean(body.testFirstName) || 'Voornaam',
        customerId: clean(body.testCustomerId)
      };
      if (fakeCustomer.customerId) {
        try { mailOpts.personalization = await getCustomerPersonalization(fakeCustomer); } catch {}
      }
      const html = buildWelkomMailHtml(fakeCustomer, store, storeCfg, mailOpts);
      return res.status(200).json({ success: true, html, store, hasPersonalization: !!mailOpts.personalization });
    }

    if (action === 'get-defaults') {
      /* Geeft alle default-waarden voor 1 winkel terug, zodat de UI per
         veld een "Reset naar default" knop kan tonen. */
      const store = clean(body.store) || clean(req.query?.store) || 'GENTS Amsterdam';
      const defaults = getStoreDefaults(store);
      return res.status(200).json({ success: true, store, defaults, globalDefaults: STORE_DEFAULTS });
    }

    if (action === 'copy-config') {
      /* Kopieer config van fromStore → toStore voor de gedeelde velden
         (templates, CTA, openingstijden-fallback, vermaakkosten, loyalty).
         Winkel-specifieke velden (branchId, sender*, googlePlaceId, signature*)
         worden NIET gekopieerd zodat per-winkel data intact blijft. */
      const fromStore = clean(body.fromStore);
      const toStore = clean(body.toStore);
      if (!fromStore || !toStore || fromStore === toStore) {
        return res.status(400).json({ success: false, message: 'fromStore + toStore verplicht en verschillend.' });
      }
      const cfg = await getWelkomMailConfig();
      const src = cfg.stores?.[fromStore];
      if (!src) return res.status(404).json({ success: false, message: `Bron-winkel ${fromStore} niet gevonden.` });
      const SHARED_FIELDS = [
        'subject', 'logoUrl', 'heroImageUrl', 'heroImageLink',
        'ctaLabel', 'ctaUrl',
        'openingHours', 'alterationsInfo', 'loyaltyInfo'
      ];
      const patch = {};
      for (const field of SHARED_FIELDS) {
        if (src[field] != null) patch[field] = src[field];
      }
      const updated = await saveStoreConfig(toStore, patch);
      return res.status(200).json({ success: true, copied: SHARED_FIELDS, fromStore, toStore, config: updated });
    }

    if (action === 'domain-status') {
      /* Check Resend domain-verification status voor het sender-domein.
         Voorkomt surprises bij eerste run (mail bouncet als domein niet
         geverifieerd is). */
      const store = clean(body.store) || 'GENTS Amsterdam';
      const cfg = await getWelkomMailConfig();
      const storeCfg = cfg.stores?.[store] || {};
      const senderEmail = clean(storeCfg.senderEmail);
      if (!senderEmail) return res.status(200).json({ success: true, store, status: 'unknown', message: 'Geen senderEmail geconfigureerd.' });
      const domain = senderEmail.split('@')[1] || '';
      if (!domain) return res.status(200).json({ success: true, store, status: 'invalid', message: 'Ongeldig sender-email.' });

      if (!process.env.RESEND_API_KEY) {
        return res.status(200).json({ success: true, store, domain, status: 'unknown', message: 'RESEND_API_KEY niet ingesteld.' });
      }
      try {
        const { Resend } = await import('resend');
        const resend = new Resend(process.env.RESEND_API_KEY);
        const list = await resend.domains.list();
        const items = Array.isArray(list?.data?.data) ? list.data.data
          : Array.isArray(list?.data) ? list.data : [];
        const found = items.find((d) => clean(d.name).toLowerCase() === domain.toLowerCase());
        if (!found) {
          return res.status(200).json({
            success: true, store, domain, status: 'not-added',
            message: `Domein ${domain} niet toegevoegd in Resend — voeg het toe en verifieer DNS.`
          });
        }
        const rs = clean(found.status).toLowerCase();
        const verified = rs === 'verified';
        return res.status(200).json({
          success: true, store, domain,
          status: verified ? 'verified' : rs || 'pending',
          message: verified
            ? 'Domein geverifieerd — sender werkt.'
            : `Resend status: ${rs || 'pending'}. Check DNS (SPF + DKIM + MX) en klik Verify.`,
          resendDomainId: found.id || null,
          region: found.region || ''
        });
      } catch (e) {
        return res.status(200).json({ success: true, store, domain, status: 'error', message: e?.message?.slice(0, 200) || 'Resend domains.list() faalde.' });
      }
    }

    if (action === 'mark-sent') {
      const email = clean(body.email);
      if (!email) return res.status(400).json({ success: false, message: 'email verplicht.' });
      await markWelkomMailSent(email, { store: clean(body.store), branchId: clean(body.branchId) });
      return res.status(200).json({ success: true, markedSent: email });
    }

    if (action === 'test-google-reviews') {
      const store = clean(body.store) || 'GENTS Amsterdam';
      const cfg = await getWelkomMailConfig();
      const storeCfg = cfg.stores?.[store] || {};
      try {
        const { getGoogleReviewsForLocation } = await import('../../lib/google-shopify-opening-hours.js');
        const data = await getGoogleReviewsForLocation({
          placeId: clean(storeCfg.googlePlaceId),
          branchId: clean(storeCfg.branchId),
          store
        }, { language: 'nl', timeoutMs: 12000, minRating: 4, max: 3 });
        return res.status(200).json({
          success: true,
          placeId: data.placeId,
          name: data.name,
          rating: data.rating,
          userRatingCount: data.userRatingCount,
          writeReviewUrl: data.writeReviewUrl,
          reviews: data.reviews
        });
      } catch (e) {
        return res.status(400).json({ success: false, message: e.message || 'Google reviews fetch mislukt.' });
      }
    }

    if (action === 'test-google-hours') {
      const store = clean(body.store) || 'GENTS Amsterdam';
      const cfg = await getWelkomMailConfig();
      const storeCfg = cfg.stores?.[store] || {};
      try {
        const { getGoogleOpeningHoursForLocation } = await import('../../lib/google-shopify-opening-hours.js');
        const data = await getGoogleOpeningHoursForLocation({
          placeId: clean(storeCfg.googlePlaceId),
          branchId: clean(storeCfg.branchId),
          store
        }, { language: 'nl', timeoutMs: 12000 });
        return res.status(200).json({
          success: true,
          placeId: data.placeId,
          name: data.name,
          address: data.address,
          googleMapsUrl: data.googleMapsUrl,
          hoursJson: data.hoursJson,
          todayText: data.todayText
        });
      } catch (e) {
        return res.status(400).json({ success: false, message: e.message || 'Google fetch mislukt.' });
      }
    }

    return res.status(400).json({ success: false, message: 'Onbekende action.' });
  } catch (e) {
    console.error('[admin/welkom-mail]', e);
    return res.status(500).json({ success: false, message: e.message || 'Welkom-mail fout.' });
  }
}
