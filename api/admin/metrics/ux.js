import { aggregateUx, listUxEvents } from '../../../lib/admin-workqueue/ux-metrics-store.js';
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  const { from, to } = req.query || {};
  const events = listUxEvents(from, to);
  return res.status(200).json({ success: true, from, to, metrics: aggregateUx(events) });
}
