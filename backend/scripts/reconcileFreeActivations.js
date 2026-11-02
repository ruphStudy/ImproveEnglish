/**
 * Recovers free-beta activations left in 'reserved' by a crash (older than
 * 15 minutes): finalizes those whose user was created, releases the promo
 * slot for the rest. Paid orders and existing users are never touched.
 *
 * Usage (from backend/):
 *   node scripts/reconcileFreeActivations.js            # dry run (default)
 *   node scripts/reconcileFreeActivations.js --execute  # apply
 */
const mongoose = require('mongoose');
require('dotenv').config();

const { reconcileStaleFreeActivations } = require('../services/freePromoService');

(async () => {
  const execute = process.argv.includes('--execute');
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log(execute ? 'Mode: EXECUTE' : 'Mode: DRY RUN');
    const result = await reconcileStaleFreeActivations({ execute });
    console.log(`Stale reservations: ${result.stale}`);
    for (const a of result.actions) console.log(`  ${a.id}: ${a.action}`);
    if (!execute) console.log('DRY RUN - no changes made. Re-run with --execute to apply.');
    await mongoose.connection.close();
    process.exit(0);
  } catch (err) {
    console.error('Reconcile failed:', err.message);
    await mongoose.connection.close().catch(() => {});
    process.exit(1);
  }
})();
