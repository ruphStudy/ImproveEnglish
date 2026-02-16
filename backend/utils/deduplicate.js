// In-memory deduplication utility (for webhook message IDs)
const deduped = new Set();

function isDuplicate(id) {
  if (deduped.has(id)) return true;
  deduped.add(id);
  setTimeout(() => deduped.delete(id), 24 * 60 * 60 * 1000); // 24h expiry
  return false;
}

module.exports = { isDuplicate };
