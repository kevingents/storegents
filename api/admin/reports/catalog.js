export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  return res.status(200).json({ success: true, reports: [
    { id: 'loc_overview', title: 'Locatie overzicht', goal: 'service_herstellen', owner: 'operations', dataFreshnessMinutes: 15, lastRunStatus: 'ok', emptyReason: null, ctaUrl: '/admin/dashboard/location-overview' },
    { id: 'returns_pressure', title: 'Retourdruk', goal: 'retourdruk_verlagen', owner: 'returns-team', dataFreshnessMinutes: 60, lastRunStatus: 'warning', emptyReason: null, ctaUrl: '/admin/reports/returns-pressure' }
  ]});
}
