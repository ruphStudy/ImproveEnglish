export function formatDate(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
}
