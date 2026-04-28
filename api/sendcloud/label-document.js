import { handleCors, setCorsHeaders } from '../../lib/cors.js';

const SENDCLOUD_API_BASE = 'https://panel.sendcloud.sc/api/v2';

function getSendcloudCredentials() {
  const publicKey =
    process.env.SENDCLOUD_PUBLIC_KEY ||
    process.env.sendcloud_public ||
    process.env.SENDCLOUD_API_KEY ||
    '';

  const secretKey =
    process.env.SENDCLOUD_SECRET_KEY ||
    process.env.sendcloud_secret ||
    process.env.SENDCLOUD_API_SECRET ||
    '';

  if (!publicKey || !secretKey) {
    throw new Error('Sendcloud keys ontbreken.');
  }

  return { publicKey, secretKey };
}

function getAuthHeader() {
  const { publicKey, secretKey } = getSendcloudCredentials();
  return 'Basic ' + Buffer.from(`${publicKey}:${secretKey}`).toString('base64');
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);

  if (req.method !== 'GET') {
    return res.status(405).json({
      success: false,
      message: 'Alleen GET is toegestaan.'
    });
  }

  try {
    const parcelId = String(req.query.parcelId || '').trim();

    if (!parcelId) {
      return res.status(400).json({
        success: false,
        message: 'Parcel ID ontbreekt.'
      });
    }

    const sendcloudResponse = await fetch(
      `${SENDCLOUD_API_BASE}/parcels/${encodeURIComponent(parcelId)}/documents/label`,
      {
        method: 'GET',
        headers: {
          Authorization: getAuthHeader(),
          Accept: 'application/pdf'
        }
      }
    );

    if (!sendcloudResponse.ok) {
      const text = await sendcloudResponse.text();

      return res.status(sendcloudResponse.status).json({
        success: false,
        message: 'Sendcloud label kon niet worden opgehaald.',
        details: text
      });
    }

    const arrayBuffer = await sendcloudResponse.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="sendcloud-label-${parcelId}.pdf"`
    );
    res.setHeader('Cache-Control', 'private, max-age=300');

    return res.status(200).send(buffer);
  } catch (error) {
    console.error('Sendcloud label document error:', error);

    return res.status(500).json({
      success: false,
      message: error.message || 'Label kon niet worden geopend.'
    });
  }
}
