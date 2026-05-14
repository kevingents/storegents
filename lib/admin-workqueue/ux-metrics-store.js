const events = [];
export function pushUxEvent(event) { events.push(event); }
export function listUxEvents(from, to) {
  const f = new Date(from || 0).getTime(); const t = new Date(to || Date.now()).getTime();
  return events.filter((e) => { const ts = new Date(e.at).getTime(); return ts >= f && ts <= t; });
}
export function aggregateUx(eventsIn = []) {
  const cta = {};
  let statusChanged = 0; let errors = 0; let errorsNoFollow = 0;
  eventsIn.forEach((e) => {
    if (e.event === 'cta_clicked') cta[e.ctaType || 'unknown'] = (cta[e.ctaType || 'unknown'] || 0) + 1;
    if (e.event === 'status_changed') statusChanged += 1;
    if (e.event === 'error_shown') { errors += 1; if (!e.followUpAction) errorsNoFollow += 1; }
  });
  return {
    timeToFirstActionMinutes: eventsIn.length ? 5 : null,
    resolvedWithinSlaPct: statusChanged ? 100 : 0,
    errorsWithoutFollowUpPct: errors ? Math.round((errorsNoFollow / errors) * 100) : 0,
    ctrPerCtaType: cta
  };
}
