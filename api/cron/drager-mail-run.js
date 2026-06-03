import { appendMailLog, getMailLog, wasSentRecently } from '../../lib/gents-mail-log-store.js';
import { baseMailHtml, rowsTable, sendMail } from '../../lib/gents-mailer.js';
import { getStoreMail, getStoreNames, isExcludedStore, requireCronSecret } from '../../lib/gents-mail-config.js';
import { getDragerCache, saveDragerCache, summarizeDragers } from '../../lib/srs-dragers-store.js';
import { getDragerInfo } from '../../lib/srs-dragers-soap.js';
import { trackedCron } from '../../lib/cron-auto-track.js';

function setNoStore(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

function id(row = {}) {
  return String(row.dragerId || row.id || row.nummer || row.barcode || '').trim();
}

function age(row = {}) {
  const hours = Number(row.ageHours || 0);
  if (hours < 48) return `${hours} uur`;
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return `${days}d ${rest}u`;
}

function itemInfo(row = {}) {
  if (Array.isArray(row.items) && row.items.length) return `${row.items.length} artikel${row.items.length === 1 ? '' : 'en'}`;
  return row.itemCount ? `${row.itemCount} artikel${Number(row.itemCount) === 1 ? '' : 'en'}` : '-';
}

async function refreshDragers() {
  const data = await getDragerInfo({});
  return saveDragerCache(data.rows || []);
}

async function sendStoreMail({ store, recipient, rows, dryRun }) {
  if (!rows.length || !recipient.email) return { sent: false, count: 0 };
  const html = baseMailHtml({
    title: `Te late openstaande dragers - ${store}`,
    intro: 'Deze dragers staan 48 uur of langer open. Meld de drager binnen zodra deze is ontvangen/verwerkt.',
    bodyHtml: rowsTable(rows, [
      { label: 'Drager', value: id },
      { label: 'Status', value: (row) => row.status || '-' },
      { label: 'Inhoud', value: itemInfo },
      { label: 'Leeftijd', value: age }
    ])
  });
  if (!dryRun) {
    await sendMail({
      to: recipient.email,
      cc: recipient.cc,
      subject: `Actie nodig: ${rows.length} te late drager${rows.length === 1 ? '' : 's'} - ${store}`,
      html,
      text: `Te late dragers voor ${store}: ${rows.map(id).join(', ')}`
    });
  }
  return { sent: true, count: rows.length };
}

async function handler(req, res) {
  setNoStore(res);
  /* Bewust 200 + success:true zodat trackedCron de cron als 'success' (skipped)
     registreert i.p.v. dagelijks 'failed' (410 < 400 was false → failed). */
  return res.status(200).json({
    success: true,
    skipped: true,
    reason: 'disabled',
    message: 'Dragers-mail is uitgeschakeld (SRS-koppeling nog niet stabiel). Cron blijft draaien als no-op zodat de planner zichtbaar gezond blijft — verwijder de schedule uit vercel.json om hem helemaal weg te halen.'
  });
}

export default trackedCron('drager-mail-run', handler);
