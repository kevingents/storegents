import crypto from 'node:crypto';

export function getRequestId(req = {}) {
  return String(req.headers?.['x-request-id'] || req.headers?.['x-correlation-id'] || crypto.randomUUID());
}

export function withRequestLog(req, scope) {
  const requestId = getRequestId(req);
  const prefix = `[${scope}] [request_id=${requestId}]`;
  return {
    requestId,
    info: (...args) => console.info(prefix, ...args),
    error: (...args) => console.error(prefix, ...args)
  };
}

export function setRequestHeaders(res, requestId) {
  res.setHeader('x-request-id', requestId);
}
