/**
 * POST /api/admin/reserveringen-retry-srs
 *
 * Probeer SRS-koppeling opnieuw voor een failed reservering.
 * Geeft de volledige SRS-response terug zodat admin kan zien WAT er fout
 * gaat (auth, XML-fout, branch-issue, etc.).
 *
 * Body: { id: 'reservering-id' }
 * Response: { success, reservering, weborder, raw, error }
 */

import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { getReserveringen, updateReservering } from '../../lib/reserveringen-store.js';
import { placeReserveringAsWeborder } from '../../lib/srs-weborder-client.js';
import { getFulfillments, setFulfillmentBranch } from '../../lib/srs-weborders-message-client.js';
import { getReserveringBranch } from '../../lib/reserveringen-branch-mapping.js';

function isAuthorized(req) {
  const expected = String(process.env.ADMIN_TOKEN || '12345').trim();
  const given = String(
    req.headers['x-admin-token'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    req.query.token ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return Boolean(expected && given && expected === given);
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen POST.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const id = String(body.id || '').trim();
    if (!id) return res.status(400).json({ success: false, message: 'Geef reservering-id mee.' });

    /* Vind de reservering (we pakken includeAll om ook failed ones te krijgen) */
    const all = await getReserveringen({ includeAll: true, limit: 5000 });
    const r = all.find((row) => row.id === id);
    if (!r) return res.status(404).json({ success: false, message: 'Reservering niet gevonden.' });

    const resBranch = getReserveringBranch(r.store);
    if (!resBranch) return res.status(400).json({ success: false, message: `Geen RES-mapping voor "${r.store}".` });

    const attemptStartAt = new Date().toISOString();

    /* SRS-config check vooraf zodat we sneller falen bij ontbrekende env.
       Geeft een platte map terug zodat de frontend per-key kan tonen wat
       aanwezig is. */
    const configCheck = {
      SRS_API_USER: Boolean(process.env.SRS_API_USER || process.env.SRS_API_USERNAME),
      SRS_API_PASSWORD: Boolean(process.env.SRS_API_PASSWORD),
      SRS_API_BASE_URL: process.env.SRS_API_BASE_URL || process.env.SRS_BASE_URL || 'https://ws.srs.nl (default)',
      /* Behoud oude keys voor backwards compat met frontend */
      hasUser: Boolean(process.env.SRS_API_USER || process.env.SRS_API_USERNAME),
      hasPassword: Boolean(process.env.SRS_API_PASSWORD),
      baseUrl: process.env.SRS_API_BASE_URL || process.env.SRS_BASE_URL || 'https://ws.srs.nl (default)'
    };
    if (!configCheck.hasUser || !configCheck.hasPassword) {
      const msg = `SRS_API_USER en/of SRS_API_PASSWORD ontbreken in Vercel env (${configCheck.hasUser ? 'user: ok' : 'user: ontbreekt'}, ${configCheck.hasPassword ? 'password: ok' : 'password: ontbreekt'}).`;
      await updateReservering(id, {
        srsSyncStatus: 'failed',
        srsError: msg,
        srsAttempts: Number(r.srsAttempts || 0) + 1,
        srsLastAttemptAt: attemptStartAt
      });
      return res.status(500).json({ success: false, configCheck, message: msg });
    }

    /* Probeer opnieuw */
    let weborder = null;
    let errInfo = null;
    try {
      const winkelBranchInfo = await import('../../lib/branch-metrics.js').then((m) => {
        if (typeof m.listBranches === 'function') {
          return (m.listBranches() || []).find((b) => String(b.store || '').trim().toLowerCase() === String(r.store).toLowerCase());
        }
        return null;
      }).catch(() => null);

      weborder = await placeReserveringAsWeborder({
        customerId: r.customer?.srsCustomerId || undefined,
        fulfilmentBranchId: resBranch.branchId,
        sellingBranchId: winkelBranchInfo?.branchId || '',
        reserveringId: r.id,
        note: r.note || `Reservering door ${r.employeeName} in ${r.store}`,
        product: {
          sku: r.item?.barcode || r.item?.sku,
          name: r.item?.title || r.item?.sku,
          price: Number(r.item?.price || 0),
          quantity: r.item?.quantity || 1,
          taxPerc: 21
        },
        billing: {
          name: (r.customer?.name || r.employeeName || 'Reservering').slice(0, 25),
          street: 'Reservering',
          houseNumber: '0',
          postalCode: '0000AA',
          city: String(r.store || '').replace(/^GENTS\s+/i, '') || 'NL',
          country: 'NL',
          email: r.customer?.email || '',
          phone: r.customer?.phone || ''
        },
        email: r.customer?.email || '',
        phone: r.customer?.phone || ''
      });

      /* Stap 2: rooting via SetFulfillments — zelfde flow als POST endpoint.
         Plaatst leveropdracht op RES-filiaal via SOAP i.p.v. via
         extended_attribute afhaal_filiaal (die SRS niet kent). */
      const success = Boolean(weborder.success);
      let fulfillmentId = '';
      let setFulfillmentResult = null;
      let setFulfillmentError = null;
      let syncStatus = success ? 'weborder_created' : 'failed';

      if (success) {
        try {
          const ff = await getFulfillments({ orderNr: weborder.orderId });
          const lines = ff.fulfillments || ff.items || [];
          fulfillmentId = String(lines[0]?.fulfillmentId || lines[0]?.FulfillmentId || '').trim();
          if (fulfillmentId) {
            setFulfillmentResult = await setFulfillmentBranch({
              fulfillmentId,
              branchId: resBranch.branchId
            });
            syncStatus = setFulfillmentResult.success ? 'weborder_routed_to_res' : 'route_failed';
          } else {
            syncStatus = 'fulfillment_id_missing';
          }
        } catch (err) {
          setFulfillmentError = { message: err.message, status: err.status, fault: err.fault };
          syncStatus = 'route_failed';
        }
      }

      await updateReservering(id, {
        srsSyncStatus: syncStatus,
        srsTransactionId: weborder.orderId || '',
        srsFulfillmentId: fulfillmentId,
        srsRawSnippet: String(weborder.raw || '').slice(0, 500),
        srsAttempts: Number(r.srsAttempts || 0) + 1,
        srsLastAttemptAt: attemptStartAt,
        srsError: success
          ? (setFulfillmentError ? `SetFulfillment: ${setFulfillmentError.message}` : '')
          : `SRS gaf '${weborder.srsReturn || 'no-return'}' terug i.p.v. 'true'`
      });

      /* Verrijk weborder-response met routing-info voor debug-dialog */
      weborder.setFulfillmentResult = setFulfillmentResult;
      weborder.setFulfillmentError = setFulfillmentError;
      weborder.fulfillmentId = fulfillmentId;
      weborder.routedTo = setFulfillmentResult?.success ? resBranch.branchId : '';
    } catch (err) {
      errInfo = {
        message: err.message,
        status: err.status,
        fault: err.fault,
        responseText: String(err.responseText || '').slice(0, 1500)
      };
      try {
        await updateReservering(id, {
          srsSyncStatus: 'failed',
          srsError: err.message || String(err),
          srsRawSnippet: String(err.responseText || '').slice(0, 500),
          srsAttempts: Number(r.srsAttempts || 0) + 1,
          srsLastAttemptAt: attemptStartAt
        });
      } catch (_) {}
    }

    const updated = (await getReserveringen({ includeAll: true, limit: 5000 })).find((row) => row.id === id);
    return res.status(200).json({
      success: !errInfo && Boolean(weborder?.success),
      configCheck,
      reservering: updated,
      weborder,
      error: errInfo
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}
