import { handleCors, setCorsHeaders, isAdminRequest } from '../../lib/cors.js';
import {
  DHL_HUBS,
  getAllDhlHubsMergedAsync,
  getDhlHubsGroupedAsync
} from '../../lib/dhl-hubs.js';
import {
  getAllDhlHubOverrides,
  setDhlHubOverride,
  bulkSetDhlHubOverrides
} from '../../lib/dhl-hubs-store.js';
import { getStoreNames } from '../../lib/gents-mail-config.js';

/**
 * Admin endpoint voor DHL hub-config.
 *
 *  GET  /api/admin/dhl-hubs
 *    -> { success, stores: [{store, hub, email, phone, pickupWindow, pickupAddress, source}],
 *          overrides: {...}, hubsGrouped: [...] }
 *
 *  POST /api/admin/dhl-hubs
 *    Body: { store, hub?, email?, phone?, pickupWindow?, pickupAddress? }
 *    -> override opslaan voor 1 winkel
 *    Lege body of action='reset' -> override verwijderen (terug naar default)
 *
 *  POST /api/admin/dhl-hubs (bulk)
 *    Body: { updates: { 'GENTS Almere': {hub,email,...}, ... } }
 *    -> bulk-update meerdere winkels
 */

function field(value) {
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (!isAdminRequest(req)) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  if (req.method === 'GET') {
    try {
      const merged = await getAllDhlHubsMergedAsync();
      const overrides = await getAllDhlHubOverrides();
      const hubsGrouped = await getDhlHubsGroupedAsync();

      /* Maak een complete lijst van álle GENTS winkels — ook degene zonder
         hub-mapping (zoals Antwerpen / Brandstores) — zodat admin alle
         winkels kan zien en evt. configureren. */
      const allStores = new Set([
        ...Object.keys(DHL_HUBS),
        ...Object.keys(merged),
        ...getStoreNames()
      ]);

      const stores = Array.from(allStores)
        .sort((a, b) => a.localeCompare(b))
        .map((store) => {
          const info = merged[store] || {};
          return {
            store,
            hub: info.hub || '',
            email: info.email || '',
            phone: info.phone || '',
            pickupWindow: info.pickupWindow || '',
            pickupAddress: info.pickupAddress || '',
            registeredSince: info.registeredSince || '',
            source: info._source || (DHL_HUBS[store] ? 'default' : 'none'),
            hasOverride: Boolean(overrides[store]),
            updatedAt: overrides[store]?.updatedAt || '',
            updatedBy: overrides[store]?.updatedBy || ''
          };
        });

      return res.status(200).json({
        success: true,
        stores,
        overrides,
        hubsGrouped,
        defaultCount: Object.keys(DHL_HUBS).length,
        overrideCount: Object.keys(overrides).length
      });
    } catch (error) {
      console.error('[admin/dhl-hubs] GET error:', error);
      return res.status(500).json({
        success: false,
        message: error.message || 'Kon hub-config niet ophalen.'
      });
    }
  }

  if (req.method === 'POST') {
    try {
      const body = req.body || {};
      const adminName = String(field(body.updatedBy) || 'admin').trim();

      /* Bulk update */
      if (body.updates && typeof body.updates === 'object') {
        const result = await bulkSetDhlHubOverrides(body.updates, adminName);
        return res.status(200).json({
          success: true,
          message: `${result.count} winkels bijgewerkt.`,
          ...result
        });
      }

      const store = String(field(body.store) || '').trim();
      if (!store) {
        return res.status(400).json({ success: false, message: 'Winkel ontbreekt.' });
      }

      /* Reset = override verwijderen */
      const action = String(field(body.action) || '').toLowerCase();
      if (action === 'reset' || action === 'delete') {
        const result = await setDhlHubOverride(store, null, adminName);
        return res.status(200).json({
          success: true,
          message: `Override verwijderd voor ${store} (default actief).`,
          ...result
        });
      }

      /* Single update */
      const override = {
        hub: field(body.hub),
        email: field(body.email),
        phone: field(body.phone),
        pickupWindow: field(body.pickupWindow),
        pickupAddress: field(body.pickupAddress),
        registeredSince: field(body.registeredSince)
      };

      /* Alleen niet-lege velden meesturen */
      const clean = {};
      for (const [key, val] of Object.entries(override)) {
        if (val && String(val).trim()) clean[key] = String(val).trim();
      }

      if (!Object.keys(clean).length) {
        /* Niks ingevuld = reset */
        const result = await setDhlHubOverride(store, null, adminName);
        return res.status(200).json({
          success: true,
          message: `Override verwijderd voor ${store}.`,
          ...result
        });
      }

      const result = await setDhlHubOverride(store, clean, adminName);
      return res.status(200).json({
        success: true,
        message: `Hub-config opgeslagen voor ${store}.`,
        ...result
      });
    } catch (error) {
      console.error('[admin/dhl-hubs] POST error:', error);
      return res.status(400).json({
        success: false,
        message: error.message || 'Kon hub-config niet opslaan.'
      });
    }
  }

  return res.status(405).json({ success: false, message: 'Alleen GET en POST.' });
}
