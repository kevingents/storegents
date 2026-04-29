import { handleCors, setCorsHeaders } from '../../lib/cors.js';
export default async function handler(req, res) {
  if (handleCors(req, res, ['GET','POST','OPTIONS'])) return;
  setCorsHeaders(res, ['GET','POST','OPTIONS']);
  return res.status(200).json({ success: true, message: 'Supportaanvraag ontvangen endpoint actief. Koppel hier de definitieve backendactie.', rows: [] });
}
