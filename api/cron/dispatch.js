/**
 * api/cron/dispatch.js
 *
 * Eén dispatcher die alle cron-jobs aanstuurt i.p.v. 68 losse Vercel-crons.
 * Draait elke 5 min (zie vercel.json), bepaalt met de cron-matcher welke jobs
 * NU due zijn (UTC, identiek aan native Vercel-crons) en vuurt die parallel af
 * als authed HTTP-calls naar hun eigen endpoint. Elke job draait dus nog steeds
 * als eigen serverless-invocatie met eigen timeout/isolatie — de dispatcher
 * wacht alleen (kort) op de responses.
 *
 * Auth: identiek aan de overige crons (lib/cron-auth.js). Vercel zet automatisch
 * de `Authorization: Bearer <CRON_SECRET>`-header op de native dispatch-trigger;
 * wij zetten diezelfde header op de uitgaande calls naar de sub-jobs.
 *
 * Veilig testen: `?dryRun=1` geeft de due-lijst terug zónder iets af te vuren.
 */
import { isCronAuthorized } from "../../lib/cron-auth.js";
import { isDue } from "../../lib/cron-matcher.js";
import { CRON_JOBS } from "../../lib/cron-jobs.js";

export const config = { maxDuration: 60 };

/* Per sub-job maximaal zo lang wachten op completion. Jobs die langer duren
   blijven gewoon draaien in hun eigen invocatie (Vercel kapt een functie niet
   af als de aanroeper de verbinding sluit) — we rapporteren ze als 'triggered'. */
const FIRE_TIMEOUT_MS = 20000;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Alleen GET/POST." });
  }
  if (!isCronAuthorized(req)) {
    return res.status(401).json({ success: false, message: "Niet bevoegd." });
  }

  const now = new Date(); // UTC in de serverless-omgeving
  const due = CRON_JOBS.filter((j) => j.enabled !== false && isDue(j.schedule, now));

  const dryRun = String(req.query?.dryRun || req.query?.dry || "") === "1";
  if (dryRun) {
    return res.status(200).json({
      success: true,
      dryRun: true,
      at: now.toISOString(),
      dueCount: due.length,
      due: due.map((j) => ({ path: j.path, schedule: j.schedule })),
    });
  }

  const host = req.headers["host"];
  const proto = req.headers["x-forwarded-proto"] || "https";
  const baseUrl = `${proto}://${host}`;
  const secret = String(process.env.CRON_SECRET || "").trim();
  const authHeader = secret ? { Authorization: `Bearer ${secret}` } : {};

  const fired = await Promise.all(
    due.map(async (j) => {
      const url = `${baseUrl}${j.path}`;
      try {
        const r = await fetch(url, {
          method: "GET",
          headers: { ...authHeader, Accept: "application/json" },
          signal: AbortSignal.timeout(FIRE_TIMEOUT_MS),
        });
        return { path: j.path, status: r.status, ok: r.ok };
      } catch (e) {
        // Timeout/abort = job is gestart maar duurt > FIRE_TIMEOUT_MS; draait door.
        if (e && (e.name === "TimeoutError" || e.name === "AbortError")) {
          return { path: j.path, triggered: true, note: `draait verder (>${FIRE_TIMEOUT_MS / 1000}s)` };
        }
        return { path: j.path, error: String((e && e.message) || e) };
      }
    })
  );

  const okCount = fired.filter((f) => f.ok || f.triggered).length;
  return res.status(200).json({
    success: true,
    at: now.toISOString(),
    dueCount: due.length,
    okCount,
    fired,
  });
}
