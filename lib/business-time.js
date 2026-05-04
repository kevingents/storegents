export function businessAgeDays(startValue, nowValue = new Date()) {
  const start = new Date(startValue);
  const now = new Date(nowValue);
  if (Number.isNaN(start.getTime())) return 0;
  if (now <= start) return 0;

  let cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);

  let days = 0;
  let weekendCounted = false;

  while (cursor < end) {
    const day = cursor.getDay();
    if (day === 0 || day === 6) {
      if (!weekendCounted) {
        days += 1;
        weekendCounted = true;
      }
    } else {
      days += 1;
      weekendCounted = false;
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  const sameDate = new Date(start);
  sameDate.setHours(0, 0, 0, 0);
  if (sameDate.getTime() === end.getTime()) {
    return (now.getTime() - start.getTime()) / 86400000;
  }

  return days;
}

export function businessAgeHours(startValue, nowValue = new Date()) {
  return businessAgeDays(startValue, nowValue) * 24;
}
