export function buildErrorPayload({ message, source, endpoint, retryable = false, details = null }) {
  return { success: false, message, source, endpoint, retryable: Boolean(retryable), details };
}

export function sendError(res, status, payload) {
  return res.status(status).json(buildErrorPayload(payload));
}

export function mapUpstreamError({ endpoint, source, error }) {
  return buildErrorPayload({
    message: `bron niet beschikbaar: ${source}`,
    source,
    endpoint,
    retryable: true,
    details: { reason: error?.message || 'unknown' }
  });
}
