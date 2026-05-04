export function toDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function ageHours(value, now = new Date()) {
  const date = toDate(value);
  if (!date) return 0;
  return Math.max(0, Math.round((now.getTime() - date.getTime()) / 36e5));
}

export function normalAgeDays(value, now = new Date()) {
  const hours = ageHours(value, now);
  return Math.floor(hours / 24);
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

function isSunday(date) {
  return date.getDay() === 0;
}

function isSaturday(date) {
  return date.getDay() === 6;
}

export function operationalDaysBetween(startValue, endValue = new Date()) {
  const start = toDate(startValue);
  const end = toDate(endValue);
  if (!start || !end || end <= start) return 0;

  const cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);

  const endDay = new Date(end);
  endDay.setHours(0, 0, 0, 0);

  let days = 0;
  const countedWeekendKeys = new Set();

  while (cursor <= endDay) {
    const key = dateKey(cursor);
    const saturday = new Date(cursor);
    saturday.setDate(cursor.getDate() - (cursor.getDay() === 0 ? 1 : 0));
    const weekendKey = dateKey(saturday);

    if (isSaturday(cursor) || isSunday(cursor)) {
      if (!countedWeekendKeys.has(weekendKey)) {
        days += 1;
        countedWeekendKeys.add(weekendKey);
      }
    } else {
      days += 1;
    }

    cursor.setDate(cursor.getDate() + 1);
  }

  return Math.max(0, days - 1);
}

export function isOverdueWithWeekendRule(value, deadlineDays = 2, now = new Date()) {
  return operationalDaysBetween(value, now) >= Number(deadlineDays || 2);
}

export function ageLabel(value, now = new Date()) {
  const hours = ageHours(value, now);
  const days = operationalDaysBetween(value, now);
  if (!hours) return '-';
  if (hours < 24) return `${hours} uur`;
  return `${days} werkdag${days === 1 ? '' : 'en'} / ${Math.round(hours / 24)} kalenderdag${Math.round(hours / 24) === 1 ? '' : 'en'}`;
}
