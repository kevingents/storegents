export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  const { store, user, shift } = req.query || {};
  if (!store || !user || !shift) return res.status(400).json({ success: false, message: 'store, user en shift zijn verplicht.' });
  const actions = [];
  if (!actions.length) return res.status(200).json({ success: true, actions: [], emptyState: { message: 'Geen acties voor deze shift.', nextRecommendedCheckAt: new Date(Date.now() + 30 * 60000).toISOString() } });
  return res.status(200).json({ success: true, actions: actions.slice(0, 5) });
}
