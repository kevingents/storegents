function num(v) { return Number(v || 0); }

export function getScoreConfig() {
  return {
    weights: {
      late: num(process.env.SCORE_WEIGHT_LATE || 8),
      unavailable: num(process.env.SCORE_WEIGHT_UNAVAILABLE || 6),
      open: num(process.env.SCORE_WEIGHT_OPEN || 3),
      sla72h: num(process.env.SCORE_WEIGHT_SLA_72H || 10),
      revenueRisk: num(process.env.SCORE_WEIGHT_REVENUE_RISK || 0.02)
    },
    thresholds: {
      low: num(process.env.SCORE_THRESHOLD_LOW || 25),
      medium: num(process.env.SCORE_THRESHOLD_MEDIUM || 60),
      high: num(process.env.SCORE_THRESHOLD_HIGH || 90)
    }
  };
}

export function calculateImpactScore(input = {}, config = getScoreConfig()) {
  const lateTotal = num(input.lateOrders) + num(input.lateDragers) + num(input.lateExchanges);
  const openTotal = num(input.openUnavailable) + num(input.openIssues);
  const slaBoost = input.slaBucket === '>72h' ? config.weights.sla72h : input.slaBucket === '48-72h' ? Math.round(config.weights.sla72h / 2) : 0;
  const score = Math.round(
    lateTotal * config.weights.late
    + num(input.openUnavailable) * config.weights.unavailable
    + openTotal * config.weights.open
    + slaBoost
    + num(input.revenueRisk) * config.weights.revenueRisk
  );
  const priorityLevel = score >= config.thresholds.high ? 'hoog' : score >= config.thresholds.medium ? 'middel' : 'laag';
  const advice = priorityLevel === 'hoog' ? 'Direct opvolgen binnen huidige shift.' : priorityLevel === 'middel' ? 'Plan opvolging binnen 24 uur.' : 'Monitoren tijdens eerstvolgende controle.';
  return { impactScore: score, priorityLevel, advice };
}
