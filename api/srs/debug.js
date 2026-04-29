import { handleCors, setCorsHeaders } from '../../lib/cors.js';

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);

  const baseUrl = process.env.SRS_BASE_URL || '';
  const user = process.env.SRS_MESSAGE_USER || '';
  const password = process.env.SRS_MESSAGE_PASSWORD || '';

  return res.status(200).json({
    success: true,
    baseUrl,
    endpoint: `${baseUrl.replace(/\/$/, '')}/messages/v1/soap/Weborders.php`,
    userLength: user.length,
    userPreview: user ? `${user.slice(0, 3)}***${user.slice(-2)}` : '',
    passwordLength: password.length,
    hasPassword: Boolean(password),
    environmentHint: 'Na wijziging van Vercel env vars altijd opnieuw redeployen.'
  });
}
