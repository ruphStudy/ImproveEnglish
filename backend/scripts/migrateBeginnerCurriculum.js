/**
 * Beginner curriculum review + Days 1-30 correction.
 *
 * Days 1-30: compares the active beginner topics with the reviewed foundation
 * plan in services/beginnerProgression.js and (with --execute) updates only
 * theme, title, grammarFocus and difficultyTag. _id, day, month, isActive and
 * every user/lesson record are untouched, so learner progress is preserved.
 * Days 31-365: REPORT ONLY - flags missing days, duplicate titles and grammar
 * that looks too hard for the day's stage, for manual review.
 *
 * Safe to re-run: topics already matching the plan are skipped, and each
 * update is conditional on the values shown in the dry run. --execute first
 * writes a JSON backup of the previous values; --restore puts them back.
 *
 * Usage (from backend/):
 *   node scripts/migrateBeginnerCurriculum.js                     # dry run (default) - changes nothing
 *   node scripts/migrateBeginnerCurriculum.js --execute           # backup, then update Days 1-30
 *   node scripts/migrateBeginnerCurriculum.js --restore=<backup>  # restore a backup
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config();

const CurriculumTopic = require('../models/CurriculumTopic');
const { BEGINNER_FOUNDATION_TOPICS, getBeginnerStage } = require('../services/beginnerProgression');

const FIELDS = ['theme', 'title', 'grammarFocus', 'difficultyTag'];
const CURRICULUM_DAYS = 365;

// Report-only heuristics: grammar that should not appear before a stage.
const HARD_GRAMMAR_BY_STAGE = {
  easy_moderate: /\b(might|would|should|conditional|if\b|perfect|passive|compar|reported)/i,
  gradual_progression: /\b(second conditional|third conditional|mixed conditional|past perfect|passive|reported speech)/i
};

function pick(doc) {
  return Object.fromEntries(FIELDS.map(f => [f, doc[f]]));
}

async function migrateBeginnerCurriculum({ execute = false, log = console.log, backupDir = process.cwd() } = {}) {
  const topics = await CurriculumTopic.find({ level: 'beginner', isActive: true })
    .select('_id day ' + FIELDS.join(' '))
    .sort({ day: 1 })
    .lean();
  const byDay = new Map();
  for (const t of topics) byDay.set(t.day, [...(byDay.get(t.day) || []), t]);

  const updates = [];
  const report = { unchanged: 0, toUpdate: 0, missing: [], duplicateDays: [], flagged: [], repeatedTitles: [] };

  log('--- Days 1-30 (foundation plan) ---');
  for (const plan of BEGINNER_FOUNDATION_TOPICS) {
    const existing = byDay.get(plan.day) || [];
    if (existing.length === 0) {
      report.missing.push(plan.day);
      log(`Day ${plan.day}: MISSING - no active beginner topic (not created; add it manually if needed)`);
      continue;
    }
    if (existing.length > 1) {
      report.duplicateDays.push(plan.day);
      log(`Day ${plan.day}: SKIPPED - ${existing.length} active topics; resolve manually`);
      continue;
    }
    const current = existing[0];
    const changed = FIELDS.filter(f => current[f] !== plan[f]);
    if (!changed.length) {
      report.unchanged++;
      continue;
    }
    report.toUpdate++;
    updates.push({ _id: current._id, day: plan.day, before: pick(current), after: pick(plan) });
    log(`Day ${plan.day}:`);
    for (const f of changed) log(`    ${f}: "${current[f]}" -> "${plan[f]}"`);
  }

  log('--- Days 31-365 (report only) ---');
  const titleDays = new Map();
  for (let day = 1; day <= CURRICULUM_DAYS; day++) {
    const existing = byDay.get(day) || [];
    if (day > 30 && existing.length === 0) report.missing.push(day);
    if (day > 30 && existing.length > 1) report.duplicateDays.push(day);
    const effective = day <= 30 && existing.length === 1
      ? BEGINNER_FOUNDATION_TOPICS[day - 1]
      : existing[0];
    if (!effective) continue;
    const key = String(effective.title).trim().toLowerCase();
    titleDays.set(key, [...(titleDays.get(key) || []), day]);
    const hard = day > 30 && HARD_GRAMMAR_BY_STAGE[getBeginnerStage(day).key];
    if (hard && hard.test(`${effective.title} ${effective.grammarFocus}`)) {
      report.flagged.push(day);
      log(`Day ${day} [${getBeginnerStage(day).label}]: review difficulty - "${effective.title}" / ${effective.grammarFocus}`);
    }
  }
  for (const [title, days] of titleDays) {
    if (days.length > 1) {
      report.repeatedTitles.push({ title, days });
      log(`Repeated title "${title}" on days ${days.join(', ')}`);
    }
  }

  log(`Summary: ${report.toUpdate} to update, ${report.unchanged} already correct, ` +
    `missing days: ${report.missing.length ? report.missing.join(', ') : 'none'}, ` +
    `days with duplicates: ${report.duplicateDays.length ? report.duplicateDays.join(', ') : 'none'}, ` +
    `flagged for review: ${report.flagged.length}, repeated titles: ${report.repeatedTitles.length}`);

  if (!execute) {
    log('DRY RUN - no changes made. Re-run with --execute to apply the Days 1-30 updates.');
    return { ...report, modified: 0, executed: false };
  }
  if (!updates.length) return { ...report, modified: 0, executed: true };

  const backupFile = path.join(backupDir, `beginner-curriculum-backup-${Date.now()}.json`);
  fs.writeFileSync(backupFile, JSON.stringify(updates.map(u => ({ _id: String(u._id), day: u.day, before: u.before, after: u.after })), null, 2));
  log(`Backup of previous values written to ${backupFile}`);

  let modified = 0;
  for (const u of updates) {
    // Conditional on the reviewed values - a topic edited since the listing is left alone.
    const res = await CurriculumTopic.updateOne(
      { _id: u._id, level: 'beginner', ...u.before },
      { $set: { ...u.after, updatedAt: new Date() } }
    );
    if (res.modifiedCount) modified++;
    else log(`Day ${u.day}: not updated (changed since the dry run)`);
  }
  log(`Updated ${modified} beginner topic(s).`);
  return { ...report, modified, executed: true, backupFile };
}

async function restoreBeginnerCurriculum(backupFile, { log = console.log } = {}) {
  const entries = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
  let restored = 0;
  for (const e of entries) {
    const res = await CurriculumTopic.updateOne(
      { _id: e._id, level: 'beginner', ...e.after },
      { $set: { ...e.before, updatedAt: new Date() } }
    );
    if (res.modifiedCount) restored++;
    else log(`Day ${e.day}: not restored (changed since the migration)`);
  }
  log(`Restored ${restored} of ${entries.length} topic(s).`);
  return { restored };
}

if (require.main === module) {
  const execute = process.argv.includes('--execute');
  const restoreArg = process.argv.find(a => a.startsWith('--restore='));
  (async () => {
    try {
      await mongoose.connect(process.env.MONGO_URI);
      if (restoreArg) {
        console.log('Mode: RESTORE');
        await restoreBeginnerCurriculum(restoreArg.slice('--restore='.length));
      } else {
        console.log(execute ? 'Mode: EXECUTE' : 'Mode: DRY RUN');
        await migrateBeginnerCurriculum({ execute });
      }
      await mongoose.connection.close();
      process.exit(0);
    } catch (err) {
      console.error('Migration failed:', err.message);
      await mongoose.connection.close().catch(() => {});
      process.exit(1);
    }
  })();
}

module.exports = { migrateBeginnerCurriculum, restoreBeginnerCurriculum };
