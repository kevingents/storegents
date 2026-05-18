/**
 * Cron: GET /api/cron/monthly-omnichannel-winner
 * Schedule: '0 8 1 * *' — 1e van elke maand om 08:00 UTC
 *
 * Bepaalt de Omnichannel Winnaar van vorige maand:
 *   - Hoofdprijs (hoogste totaalscore, eligible = >= 50 transacties)
 *   - 4 subwinnaars (Klant-koning, Loyalty-kampioen, Cross-channel-held, Data-meester)
 *   - Bottom 3 (intern, alleen voor regio-managers)
 *
 * Tie-breaker = hoogste klantbekendheid.
 *
 * Output:
 *   - Blob: monthly-winners/<YYYY-MM>.json
 *   - createNotification voor portaal:
 *     * Winnaar krijgt felicitatie (alle 5 winnaars apart)
 *     * Andere winkels krijgen "Winnaar van <maand>" aankondiging
 *   - PushOwl push naar winnaars + alle winkels
 *   - Mail naar regio-managers met top + bottom 3
 *
 * Query overrides voor testing:
 *   ?month=2026-04         — andere maand
 *   ?dryRun=true           — geen blob/mail/push, alleen berekening
 *   ?skipMail=true         — skip mail-stap
 *   ?skipPush=true         — skip pushowl-stap
 *   ?skipNotification=true — skip in-portaal notification
 */

import { listBranches } from '../../lib/branch-metrics.js';
import {
  writeMonthWinner,
  previousMonthBounds,
  PILLAR_LABELS,
  SUB_PILLAR_ORDER
} from '../../lib/monthly-winners-store.js';
import { createNotification } from '../../lib/store-notifications-store.js';
import { sendPushToStores, pushowlConfigured } from '../../lib/pushowl-client.js';
import { getRegionReportConfig } from '../../lib/region-report-config-store.js';
import { baseMailHtml, sendMail } from '../../lib/gents-mailer.js';
import { getAdminToken, getApiBaseUrl } from '../../lib/gents-mail-config.js';

function isAuthorized(req) {
  const ua = String(req.headers['user-agent'] || '').toLowerCase();
  if (ua.includes('vercel-cron')) return true;
  if (req.headers['x-vercel-cron']) return true;
  const adminToken = String(process.env.ADMIN_TOKEN || '12345').trim();
  const token = String(
    req.headers['x-admin-token'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return Boolean(adminToken && token && token === adminToken);
}

function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const DUTCH_MONTHS = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];

function monthLabel(yyyymm) {
  const [year, month] = String(yyyymm).split('-');
  const monthIndex = Math.max(0, Math.min(11, Number(month) - 1));
  return `${DUTCH_MONTHS[monthIndex]} ${year}`;
}

async function fetchScoreboard(req, dateFrom, dateTo, minTransactions = 50) {
  const host = req.headers['host'];
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const baseUrl = `${proto}://${host}`;
  const adminToken = process.env.ADMIN_TOKEN || '';
  const url = `${baseUrl}/api/admin/scoreboard/omnichannel-v2?dateFrom=${encodeURIComponent(dateFrom)}&dateTo=${encodeURIComponent(dateTo)}&minTransactions=${minTransactions}&adminToken=${encodeURIComponent(adminToken)}&refresh=1`;
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`omnichannel-v2 → ${response.status}`);
  return response.json();
}

function determineWinner(rows) {
  const eligible = rows.filter((row) => row.eligible);
  if (!eligible.length) return null;
  /* Scoreboard endpoint sorteert al op score DESC + klantbekendheid tie-break. */
  return eligible[0];
}

function determineSubWinners(rows) {
  const eligible = rows.filter((row) => row.eligible);
  if (!eligible.length) return { customers: null, loyalty: null, crossChannel: null, data: null };

  function pickHighest(pillarKey) {
    return eligible
      .slice()
      .sort((a, b) => {
        const pa = a.pillars[pillarKey]?.score || 0;
        const pb = b.pillars[pillarKey]?.score || 0;
        if (pb !== pa) return pb - pa;
        return a.store.localeCompare(b.store, 'nl');
      })[0];
  }

  function shrinkRow(row, pillarKey) {
    if (!row) return null;
    return {
      store: row.store,
      branchId: row.branchId,
      score: row.score,
      pillarScore: row.pillars[pillarKey]?.score || 0,
      pillarMax: row.pillars[pillarKey]?.max || 0,
      pillarRate: row.pillars[pillarKey]?.rate || 0,
      transactions: row.transactions
    };
  }

  return {
    customers: shrinkRow(pickHighest('customers'), 'customers'),
    loyalty: shrinkRow(pickHighest('loyalty'), 'loyalty'),
    crossChannel: shrinkRow(pickHighest('crossChannel'), 'crossChannel'),
    data: shrinkRow(pickHighest('data'), 'data')
  };
}

function determineBottom3(rows) {
  const eligible = rows.filter((row) => row.eligible);
  return eligible
    .slice()
    .sort((a, b) => a.score - b.score || a.store.localeCompare(b.store, 'nl'))
    .slice(0, 3)
    .map((row) => ({
      store: row.store,
      branchId: row.branchId,
      score: row.score,
      transactions: row.transactions,
      weakestPillar: SUB_PILLAR_ORDER.reduce((weakest, key) => {
        const pillar = row.pillars[key];
        if (!weakest || (pillar.score / pillar.max) < (row.pillars[weakest].score / row.pillars[weakest].max)) return key;
        return weakest;
      }, null),
      topActions: row.topActions || []
    }));
}

/* ─────────────────────────────────────────────────────────────────────────
   IN-PORTAAL NOTIFICATIES
   ───────────────────────────────────────────────────────────────────────── */
async function sendInPortalNotifications({ winner, subWinners, monthName }) {
  const tasks = [];
  const allWinners = new Set();
  if (winner?.store) allWinners.add(winner.store);
  for (const pillarKey of SUB_PILLAR_ORDER) {
    const sub = subWinners[pillarKey];
    if (sub?.store) allWinners.add(sub.store);
  }

  /* 1. Hoofdwinnaar */
  if (winner?.store) {
    tasks.push(createNotification({
      stores: [winner.store],
      target: winner.store,
      title: `🏆 Gefeliciteerd! Winnaar ${monthName}`,
      body: `Jullie zijn de Omnichannel Winnaar van ${monthName} met score ${winner.score}/100. Top werk!`,
      severity: 'success',
      link: '/pages/winkel-portaal',
      createdBy: 'cron:monthly-omnichannel-winner'
    }));
  }

  /* 2. Subwinnaars (alleen als ze niet hoofdwinnaar zijn) */
  const subPrizeNames = {
    customers: 'Klant-koning',
    loyalty: 'Loyalty-kampioen',
    crossChannel: 'Cross-channel-held',
    data: 'Data-meester'
  };
  for (const pillarKey of SUB_PILLAR_ORDER) {
    const sub = subWinners[pillarKey];
    if (!sub?.store) continue;
    if (sub.store === winner?.store) continue;
    tasks.push(createNotification({
      stores: [sub.store],
      target: sub.store,
      title: `${PILLAR_LABELS[pillarKey].icon} ${subPrizeNames[pillarKey]} ${monthName}`,
      body: `Subprijs gewonnen voor ${PILLAR_LABELS[pillarKey].label}. Score op deze pijler: ${sub.pillarScore}/${sub.pillarMax}.`,
      severity: 'success',
      link: '/pages/winkel-portaal',
      createdBy: 'cron:monthly-omnichannel-winner'
    }));
  }

  /* 3. Algemene aankondiging naar alle overige winkels */
  const branches = listBranches();
  const otherStores = branches.map((b) => b.store).filter((store) => !allWinners.has(store));
  if (otherStores.length && winner?.store) {
    tasks.push(createNotification({
      stores: otherStores,
      target: 'multi',
      title: `Winnaar ${monthName} bekend`,
      body: `${winner.store} is winnaar van ${monthName} met score ${winner.score}/100. Volgende maand jullie?`,
      severity: 'info',
      link: '/pages/winkel-portaal',
      createdBy: 'cron:monthly-omnichannel-winner'
    }));
  }

  await Promise.allSettled(tasks);
}

/* ─────────────────────────────────────────────────────────────────────────
   PUSHOWL
   ───────────────────────────────────────────────────────────────────────── */
async function sendPushNotifications({ winner, monthName }) {
  if (!pushowlConfigured() || !winner?.store) return { sent: false, reason: 'no-pushowl-or-winner' };

  try {
    /* Winnaar krijgt directe felicitatie */
    await sendPushToStores([winner.store], {
      title: `🏆 Winnaar ${monthName}!`,
      body: `Gefeliciteerd, jullie zijn winnaar met score ${winner.score}/100.`,
      url: 'https://gents.nl/pages/winkel-portaal'
    });

    /* Andere winkels krijgen aankondiging */
    const branches = listBranches();
    const otherStores = branches.map((b) => b.store).filter((store) => store !== winner.store);
    if (otherStores.length) {
      await sendPushToStores(otherStores, {
        title: `Winnaar ${monthName} bekend`,
        body: `${winner.store} wint met ${winner.score}/100.`,
        url: 'https://gents.nl/pages/winkel-portaal'
      });
    }

    return { sent: true };
  } catch (error) {
    console.error('[monthly-winner pushowl]', error.message);
    return { sent: false, reason: error.message };
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   MAIL NAAR REGIO-MANAGERS (TOP + BOTTOM 3)
   ───────────────────────────────────────────────────────────────────────── */
function rowsTableHtml(items, columns) {
  const headerHtml = columns.map((col) => `<th style="text-align:left;padding:10px 12px;background:#f5f5f2;border-bottom:1px solid #e1e6eb;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#3a4a5a;">${esc(col.label)}</th>`).join('');
  const rowsHtml = items.map((row, idx) => {
    const tds = columns.map((col) => `<td style="padding:10px 12px;border-bottom:1px solid #e1e6eb;color:#0a1f33;font-size:14px;">${esc(col.render ? col.render(row, idx) : row[col.key])}</td>`).join('');
    return `<tr>${tds}</tr>`;
  }).join('');
  return `<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;border:1px solid #e1e6eb;border-radius:12px;overflow:hidden;margin-bottom:18px;"><thead><tr>${headerHtml}</tr></thead><tbody>${rowsHtml}</tbody></table>`;
}

async function sendRegionManagerMails({ winner, subWinners, bottom3, allRows, monthName, monthYmm }) {
  const config = await getRegionReportConfig();
  const regions = (config.regions || []).filter((region) => region.email);

  if (!regions.length) {
    return { sent: 0, reason: 'no-region-managers-configured' };
  }

  const subPrizeNames = {
    customers: 'Klant-koning',
    loyalty: 'Loyalty-kampioen',
    crossChannel: 'Cross-channel-held',
    data: 'Data-meester'
  };

  const top5 = allRows.slice(0, 5);

  let sent = 0;
  const errors = [];

  for (const region of regions) {
    try {
      const regionStores = new Set(region.stores || []);
      const regionBottom = bottom3.filter((row) => regionStores.has(row.store));
      const regionTop = allRows.filter((row) => regionStores.has(row.store)).slice(0, 3);

      const subWinnersHtml = SUB_PILLAR_ORDER
        .map((pillarKey) => {
          const sub = subWinners[pillarKey];
          if (!sub) return '';
          return `<li style="margin-bottom:6px;color:#0a1f33;"><strong>${esc(PILLAR_LABELS[pillarKey].icon)} ${esc(subPrizeNames[pillarKey])}:</strong> ${esc(sub.store)} (${esc(sub.pillarScore)}/${esc(sub.pillarMax)})</li>`;
        })
        .filter(Boolean)
        .join('');

      const winnerHtml = winner
        ? `<div style="padding:18px;border:2px solid #1f7a3a;border-radius:16px;background:#ecfdf3;margin-bottom:20px;">
            <div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#1f7a3a;font-weight:700;">🏆 Hoofdprijs ${esc(monthName)}</div>
            <h2 style="margin:6px 0 0;font-size:24px;color:#0a1f33;font-weight:600;">${esc(winner.store)}</h2>
            <p style="margin:8px 0 0;color:#3a4a5a;font-size:14px;">Totaalscore <strong>${esc(winner.score)}/100</strong> · ${esc(winner.transactions)} transacties</p>
          </div>`
        : '<p style="color:#3a4a5a;">Geen winkel kwam in aanmerking voor de hoofdprijs deze maand (minimum 50 transacties).</p>';

      const subWinnersBlock = subWinnersHtml
        ? `<h3 style="margin:20px 0 8px;color:#0a1f33;">Subprijzen</h3><ul style="padding-left:20px;margin:0 0 18px;">${subWinnersHtml}</ul>`
        : '';

      const top5Html = rowsTableHtml(top5, [
        { label: '#', render: (_row, idx) => String(idx + 1) },
        { label: 'Winkel', key: 'store' },
        { label: 'Score', render: (row) => `${row.score}/100` },
        { label: 'Transacties', key: 'transactions' }
      ]);

      const regionTopHtml = regionTop.length
        ? `<h3 style="margin:20px 0 8px;color:#0a1f33;">Top in jouw regio (${esc(region.name)})</h3>${rowsTableHtml(regionTop, [
            { label: '#', render: (_row, idx) => String(idx + 1) },
            { label: 'Winkel', key: 'store' },
            { label: 'Score', render: (row) => `${row.score}/100` }
          ])}`
        : '';

      const regionBottomHtml = regionBottom.length
        ? `<h3 style="margin:20px 0 8px;color:#b91c1c;">⚠️ Bottom 3 — actie vereist</h3>
           <p style="margin:0 0 10px;color:#3a4a5a;font-size:14px;">Deze winkels in jouw regio scoorden het laagst. Plan een gesprek over de zwakste pijler.</p>
           ${rowsTableHtml(regionBottom, [
            { label: 'Winkel', key: 'store' },
            { label: 'Score', render: (row) => `${row.score}/100` },
            { label: 'Zwakste pijler', render: (row) => row.weakestPillar ? PILLAR_LABELS[row.weakestPillar].label : '-' },
            { label: 'Eerste actie', render: (row) => (row.topActions?.[0]?.suggestion || '-') }
          ])}`
        : '';

      const bodyHtml = `
        ${winnerHtml}
        ${subWinnersBlock}
        <h3 style="margin:20px 0 8px;color:#0a1f33;">Top 5 alle winkels</h3>
        ${top5Html}
        ${regionTopHtml}
        ${regionBottomHtml}
        <p style="margin:24px 0 0;color:#3a4a5a;font-size:13px;line-height:1.55;">
          Volledig dashboard: <a href="https://gents.nl/pages/winkel-portaal" style="color:#0a1f33;text-decoration:underline;">winkelportaal openen</a><br>
          Periode: ${esc(monthName)} (${esc(monthYmm)})
        </p>
      `;

      const html = baseMailHtml({
        title: `Omnichannel Winnaar ${monthName}`,
        intro: `Hoi ${region.managerName || 'regio-manager'}, hier is de uitslag van ${monthName}.`,
        bodyHtml,
        footer: 'Maandelijks rapport vanuit het GENTS Winkelportaal · bottom 3 is intern.'
      });

      await sendMail({
        to: region.email,
        cc: region.cc,
        subject: `🏆 Omnichannel Winnaar ${monthName} — ${winner?.store || 'geen winnaar'}`,
        html
      });

      sent += 1;
    } catch (error) {
      errors.push(`${region.name}: ${error.message || error}`);
    }
  }

  return { sent, errors, totalRegions: regions.length };
}

/* ─────────────────────────────────────────────────────────────────────────
   HANDLER
   ───────────────────────────────────────────────────────────────────────── */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Alleen GET/POST.' });
  }
  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  const dryRun = String(req.query.dryRun || '').toLowerCase() === 'true';
  const skipMail = String(req.query.skipMail || '').toLowerCase() === 'true';
  const skipPush = String(req.query.skipPush || '').toLowerCase() === 'true';
  const skipNotification = String(req.query.skipNotification || '').toLowerCase() === 'true';

  /* Override maand voor testing/backfill: ?month=2026-04 */
  let bounds;
  const monthQuery = String(req.query.month || '').match(/^\d{4}-\d{2}$/)?.[0];
  if (monthQuery) {
    const [y, m] = monthQuery.split('-').map(Number);
    const first = new Date(Date.UTC(y, m - 1, 1));
    const next = new Date(Date.UTC(y, m, 1));
    const last = new Date(next.getTime() - 86400000);
    bounds = {
      yyyymm: monthQuery,
      from: first.toISOString().slice(0, 10),
      to: last.toISOString().slice(0, 10)
    };
  } else {
    bounds = previousMonthBounds();
  }

  const monthName = monthLabel(bounds.yyyymm);
  const startedAt = Date.now();

  try {
    const scoreboard = await fetchScoreboard(req, bounds.from, bounds.to, 50);
    if (!scoreboard.success) {
      throw new Error(scoreboard.message || 'omnichannel-v2 gaf success=false');
    }

    const allRows = scoreboard.rows || [];
    const winner = determineWinner(allRows);
    const subWinners = determineSubWinners(allRows);
    const bottom3 = determineBottom3(allRows);

    const payload = {
      month: bounds.yyyymm,
      monthName,
      periodFrom: bounds.from,
      periodTo: bounds.to,
      minTransactions: scoreboard.minTransactions || 50,
      winner: winner ? {
        store: winner.store,
        branchId: winner.branchId,
        score: winner.score,
        transactions: winner.transactions,
        pillars: winner.pillars,
        topActions: winner.topActions || []
      } : null,
      subWinners,
      bottom3,
      allRows: allRows.map((row) => ({
        store: row.store,
        branchId: row.branchId,
        score: row.score,
        eligible: row.eligible,
        transactions: row.transactions,
        pillars: {
          customers: { score: row.pillars.customers.score, max: row.pillars.customers.max, rate: row.pillars.customers.rate },
          loyalty: { score: row.pillars.loyalty.score, max: row.pillars.loyalty.max, rate: row.pillars.loyalty.rate },
          crossChannel: { score: row.pillars.crossChannel.score, max: row.pillars.crossChannel.max },
          data: { score: row.pillars.data.score, max: row.pillars.data.max }
        }
      })),
      generatedAt: new Date().toISOString(),
      generatedBy: 'cron:monthly-omnichannel-winner',
      warnings: scoreboard.warnings || []
    };

    if (dryRun) {
      return res.status(200).json({
        success: true,
        dryRun: true,
        payload,
        durationMs: Date.now() - startedAt
      });
    }

    /* 1. Persist naar Blob */
    await writeMonthWinner(bounds.yyyymm, payload);

    /* 2. In-portaal notificaties */
    let notificationResult = { skipped: skipNotification };
    if (!skipNotification && winner) {
      try {
        await sendInPortalNotifications({ winner, subWinners, monthName });
        notificationResult = { sent: true };
      } catch (error) {
        notificationResult = { sent: false, error: error.message };
      }
    }

    /* 3. PushOwl */
    let pushResult = { skipped: skipPush };
    if (!skipPush && winner) {
      pushResult = await sendPushNotifications({ winner, monthName });
    }

    /* 4. Mail naar regio-managers */
    let mailResult = { skipped: skipMail };
    if (!skipMail) {
      mailResult = await sendRegionManagerMails({ winner, subWinners, bottom3, allRows, monthName, monthYmm: bounds.yyyymm });
    }

    return res.status(200).json({
      success: true,
      month: bounds.yyyymm,
      monthName,
      winner: payload.winner,
      subWinners: payload.subWinners,
      bottom3: payload.bottom3,
      eligibleCount: allRows.filter((row) => row.eligible).length,
      totalRows: allRows.length,
      notifications: notificationResult,
      push: pushResult,
      mail: mailResult,
      durationMs: Date.now() - startedAt
    });
  } catch (error) {
    console.error('[monthly-omnichannel-winner]', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Onverwachte fout in maandwinnaar-cron.',
      durationMs: Date.now() - startedAt
    });
  }
}
