import {
  findSenderAddressForStore,
  findDhlDropoffMethod,
  findSenderAddressForStore as findAddress,
  senderAddressToRecipient,
  sendcloudRequest
} from '../../lib/sendcloud-client.js';
import { createLabelRecord, getLabels } from '../../lib/sendcloud-labels-store.js';
import { handleCors, setCorsHeaders } from '../../lib/cors.js';

function field(value) {
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

function cleanDutchPostalCode(value) {
  return String(value || '').toUpperCase().replace(/\s+/g, '');
}

function buildCustomerRecipient(body) {
  return {
    name: field(body.customerName).trim(),
    company_name: field(body.companyName).trim(),
    address: field(body.street).trim(),
    house_number: field(body.houseNumber).trim(),
    postal_code: cleanDutchPostalCode(body.postalCode),
    city: field(body.city).trim(),
    country: field(body.country).trim() || 'NL',
    telephone: field(body.phone).trim() || '0612345678',
    email: field(body.email).trim() || 'administratie@gents.nl'
  };
}

function getLabelUrl(parcel) {
  if (parcel?.documents?.length) {
    const labelDoc = parcel.documents.find((doc) => doc.type === 'label') || parcel.documents[0];
    if (labelDoc?.link) return labelDoc.link;
  }

  if (parcel?.label?.normal_printer?.length) {
    return parcel.label.normal_printer[0];
  }

  if (parcel?.label?.label_printer) {
    return parcel.label.label_printer;
  }

  return '';
}

function getTrackingUrl(parcel) {
  return parcel?.tracking_url || parcel?.tracking_url_tracking_page || parcel?.tracking_url_carrier || '';
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);

  if (req.method === 'GET') {
    try {
      const store = String(req.query.store || '').trim();
      const admin = String(req.query.admin || '') === 'true';
      const labels = await getLabels();

      return res.status(200).json({
        success: true,
        labels: admin ? labels : labels.filter((label) => label.store === store)
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: error.message || 'Labels konden niet worden opgehaald.'
      });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      message: 'Alleen GET en POST zijn toegestaan.'
    });
  }

  try {
    const body = req.body || {};

    const store = field(body.store).trim();
    const employeeName = field(body.employeeName).trim();
    const reference = field(body.reference).trim();
    const destinationType = field(body.destinationType).trim();
    const destinationStore = field(body.destinationStore).trim();
    const note = field(body.note).trim();
    const weight = String(field(body.weight) || '1.000').replace(',', '.');

    if (!store || !employeeName || !reference || !destinationType) {
      return res.status(400).json({
        success: false,
        message: 'Winkel, medewerker, referentie en bestemming zijn verplicht.'
      });
    }

    const senderAddress = await findSenderAddressForStore(store);
    const shippingMethod = await findDhlDropoffMethod(senderAddress.id);

    let recipient;

    if (destinationType === 'Winkel') {
      if (!destinationStore) {
        return res.status(400).json({
          success: false,
          message: 'Kies een ontvangende winkel.'
        });
      }

      const destinationAddress = await findAddress(destinationStore);
      recipient = senderAddressToRecipient(destinationAddress, destinationStore);
    } else {
      recipient = buildCustomerRecipient(body);
    }

    if (!recipient.name || !recipient.address || !recipient.house_number || !recipient.postal_code || !recipient.city) {
      return res.status(400).json({
        success: false,
        message: 'Ontvangeradres is niet compleet.'
      });
    }

    const parcelPayload = {
      parcel: {
        name: recipient.name,
        company_name: recipient.company_name,
        address: recipient.address,
        house_number: recipient.house_number,
        city: recipient.city,
        postal_code: recipient.postal_code,
        country: recipient.country || 'NL',
        telephone: recipient.telephone || '0612345678',
        email: recipient.email || 'administratie@gents.nl',
        request_label: true,
        shipment: {
          id: Number(shippingMethod.id)
        },
        sender_address: Number(senderAddress.id),
        weight: weight || '1.000',
        order_number: reference,
        reference: reference,
        shipping_method_checkout_name: shippingMethod.name || 'DHL For You Dropoff - S',
        data: {
          source: 'gents-winkelportaal',
          store,
          employeeName,
          destinationType,
          destinationStore,
          note
        }
      }
    };

    const data = await sendcloudRequest('/parcels?errors=verbose', {
      method: 'POST',
      body: JSON.stringify(parcelPayload)
    });

    const parcel = data.parcel;

    if (!parcel?.id) {
      return res.status(500).json({
        success: false,
        message: 'Sendcloud heeft geen parcel ID teruggegeven.',
        details: data
      });
    }

    const labelUrl = getLabelUrl(parcel);

    const record = await createLabelRecord({
      store,
      employeeName,
      reference,
      destinationType,
      recipientName: recipient.name,
      recipientCompany: recipient.company_name,
      recipientCity: recipient.city,
      recipientPostalCode: recipient.postal_code,
      parcelId: parcel.id,
      trackingNumber: parcel.tracking_number || '',
      trackingUrl: getTrackingUrl(parcel),
      labelUrl,
      shippingMethod: parcel.shipment?.name || shippingMethod.name || 'DHL For You Dropoff - S',
      status: parcel.status?.message || ''
    });

    return res.status(200).json({
      success: true,
      message: 'Sendcloud label is aangemaakt.',
      label: record,
      parcel
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Sendcloud label kon niet worden aangemaakt.',
      details: error.data || null
    });
  }
}
