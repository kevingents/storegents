export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return res.status(200).json({
    success: true,
    message: 'GENTS winkelportaal backend actief.',
    safeDefaults: {
      srsOpenWebordersSource: process.env.SRS_OPEN_WEBORDERS_SOURCE || 'local',
      includeSrsWeborderDetails: process.env.SRS_WEBORDERS_INCLUDE_DETAILS || 'false'
    }
  });
}
