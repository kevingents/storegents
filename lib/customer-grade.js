export function gradeCustomer({ orderCount = 0, totalSpend = 0 } = {}) {
  const orders = Number(orderCount || 0);
  const spend = Number(totalSpend || 0);

  if (orders >= 20 || spend >= 5000) return { grade: 'A', label: 'Topklant', color: 'dark-green' };
  if (orders >= 10 || spend >= 2500) return { grade: 'B', label: 'Vaste klant', color: 'green' };
  if (orders >= 5 || spend >= 1000) return { grade: 'C', label: 'Regelmatige klant', color: 'blue' };
  if (orders >= 2 || spend >= 250) return { grade: 'D', label: 'Terugkerende klant', color: 'orange' };
  return { grade: 'E', label: 'Nieuwe klant', color: 'grey' };
}
