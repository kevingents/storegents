import { getLabels, updateLabelsByParcelId } from '../../lib/sendcloud-labels-store.js';
import { getParcel } from '../../lib/sendcloud-client.js';
import { handleCors, setCorsHeaders } from '../../lib/cors.js';

function isAuthorized(req) {
  const adminToken = process.env.ADMIN_TOKEN || '12345';
  return req.headers['x-admin-token'] === adminToken;
}

function getParcelStatusMessage(parcel) {
  return (
    parcel?.status?.message ||
    parcel?.status_message ||
    parcel?.status ||
    ''
  );
}

function getTrackingUrl(parcel) {
  return (
    parcel?.tracking_url ||
    parcel?.tracking_url_tracking_page ||
    parcel?.tracking_url_carrier ||
    ''
  );
}

function classifyShipmentState(statusText, trackingNumber) {
  const value = String(statusText || '').toLowerCase();

  if (
    value.includes('delivered') ||
    value.includes('bezorgd') ||
    value.includes('transit') ||
    value.includes('onderweg') ||
    value.includes('sorting') ||
    value.includes('gesorteerd') ||
    value.includes('handed') ||
    value.includes('ingeleverd') ||
    value.includes('accepted')
  ) {
    return 'verzonden';
  }

  return 'open';
}

function buildStoreSummary(labels) {
  const summaryMap = new Map();

  labels.forEach((label) => {
    const store = label.senderStore || label.store || 'Onbekend';
    const existing = summaryMap.get(store) || {
      store,
      totalLabels: 0,
      sentLabels: 0,
      openLabels: 0,
      totalCost: 0,
      currency: label.shippingCurrency || 'EUR'
    };

    const cost = Number(label.shippingCost || 0);
    const state = label.shipmentState || 'open';

    existing.totalLabels += 1;
    existing.totalCost += Number.isFinite(cost) ? cost : 0;

    if (state === 'verzonden') {
      existing.sentLabels += 1;
    } else {
      existing.openLabels += 1;
    }

    summaryMap.set(store, existing);
  });

  return Array.from(summaryMap.values())
    .map((item) => ({
      ...item,
      totalCost: Number(item.totalCost.toFixed(2))
    }))
    .sort((a, b) => a.store.localeCompare(b.store));
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);

  if (!isAuthorized(req)) {
    return res.status(401).json({
      success: false,
      message: 'Niet bevoegd.'
    });
  }

  if (req.method !== 'GET') {
    return res.status(405).json({
      success: false,
      message: 'Alleen GET is toegestaan.'
    });
  }

  try {
    const refresh = String(req.query.refresh || '') === 'true';
    let labels = await getLabels();

    if (refresh) {
      const updatesByParcelId = {};

      await Promise.all(
        labels
          .filter((label) => label.parcelId)
          .slice(0, 100)
          .map(async (label) => {
            try {
              const parcel = await getParcel(label.parcelId);
              const status = getParcelStatusMessage(parcel);
              const trackingNumber = parcel.tracking_number || label.trackingNumber || '';

              updatesByParcelId[String(label.parcelId)] = {
                status,
                trackingNumber,
                trackingUrl: getTrackingUrl(parcel) || label.trackingUrl || '',
                shipmentState: classifyShipmentState(status, trackingNumber)
              };
            } catch (error) {
              console.error('Refresh Sendcloud parcel status error:', {
                parcelId: label.parcelId,
                message: error.message
              });
            }
          })
      );

      labels = await updateLabelsByParcelId(updatesByParcelId);
    }

    const summary = buildStoreSummary(labels);
    const totalCost = Number(labels.reduce((sum, label) => sum + Number(label.shippingCost || 0), 0).toFixed(2));

    return res.status(200).json({
      success: true,
      summary,
      labels,
      totals: {
        totalLabels: labels.length,
        sentLabels: labels.filter((label) => label.shipmentState === 'verzonden').length,
        openLabels: labels.filter((label) => label.shipmentState !== 'verzonden').length,
        totalCost,
        currency: 'EUR'
      }
    });
  } catch (error) {
    console.error('Admin Sendcloud labels report error:', error);

    return res.status(500).json({
      success: false,
      message: error.message || 'Sendcloud labelrapportage kon niet worden opgehaald.'
    });
  }
}
