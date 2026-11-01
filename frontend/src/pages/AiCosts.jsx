import { useState, useEffect } from 'react';
import { getAiCosts } from '../api';

const PRESETS = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'Last 7 days' },
  { key: 'month', label: 'This month' },
  { key: 'custom', label: 'Custom' }
];

// Full precision is kept server-side; rounding happens only here, for display.
function formatUsd(value) {
  if (value === null || value === undefined) return 'unknown';
  if (value !== 0 && Math.abs(value) < 0.01) return `$${value.toFixed(6)}`;
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatInr(value, rate) {
  if (!rate || value === null || value === undefined) return null;
  return `≈ ₹${(value * rate).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

const formatNumber = (n) => (n || 0).toLocaleString('en-IN');

function Card({ title, value, sub, color = 'text-gray-900' }) {
  return (
    <div className="bg-white rounded-lg shadow p-6">
      <div className="text-sm font-medium text-gray-600 mb-2">{title}</div>
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
      {sub && <div className="text-xs text-gray-500 mt-2">{sub}</div>}
    </div>
  );
}

function Section({ title, children, note }) {
  return (
    <div className="bg-white rounded-lg shadow mb-8">
      <div className="p-6 border-b border-gray-200">
        <h2 className="text-xl font-semibold text-gray-900">{title}</h2>
        {note && <p className="text-xs text-gray-500 mt-1">{note}</p>}
      </div>
      <div className="p-6 overflow-x-auto">{children}</div>
    </div>
  );
}

function UsageTable({ rows, labelKey, labelTitle }) {
  if (!rows.length) return <p className="text-gray-500">No recorded usage in this range.</p>;
  return (
    <table className="min-w-full divide-y divide-gray-200 text-sm">
      <thead className="bg-gray-50">
        <tr>
          <th className="px-4 py-2 text-left font-medium text-gray-500">{labelTitle}</th>
          <th className="px-4 py-2 text-right font-medium text-gray-500">Requests</th>
          <th className="px-4 py-2 text-right font-medium text-gray-500">Input / cached / output tokens</th>
          <th className="px-4 py-2 text-right font-medium text-gray-500">Audio (min)</th>
          <th className="px-4 py-2 text-right font-medium text-gray-500">Est. cost</th>
          <th className="px-4 py-2 text-right font-medium text-gray-500">Unknown cost</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-200">
        {rows.map((r) => (
          <tr key={r[labelKey]}>
            <td className="px-4 py-2 text-gray-900">{r[labelKey]}</td>
            <td className="px-4 py-2 text-right">{formatNumber(r.requests)}{r.failedRequests ? ` (${r.failedRequests} failed)` : ''}</td>
            <td className="px-4 py-2 text-right">{formatNumber(r.inputTokens)} / {formatNumber(r.cachedInputTokens)} / {formatNumber(r.outputTokens)}</td>
            <td className="px-4 py-2 text-right">{(r.audioSeconds / 60).toFixed(1)}</td>
            <td className="px-4 py-2 text-right font-semibold">{formatUsd(r.costUsd)}</td>
            <td className={`px-4 py-2 text-right ${r.unknownCostRequests ? 'text-amber-600' : 'text-gray-400'}`}>{r.unknownCostRequests}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DailyChart({ daily }) {
  const max = Math.max(...daily.map((d) => d.costUsd), 0);
  if (max === 0) return <p className="text-gray-500">No recorded cost in this range.</p>;
  return (
    <div className="flex items-end gap-1 h-48">
      {daily.map((d) => (
        <div key={d.date} className="flex-1 flex flex-col items-center justify-end h-full min-w-0" title={`${d.date}: ${formatUsd(d.costUsd)} (${d.requests} requests${d.unknownCostRequests ? `, ${d.unknownCostRequests} unknown cost` : ''})`}>
          <div
            className={`w-full rounded-t ${d.unknownCostRequests ? 'bg-amber-400' : 'bg-orange-500'}`}
            style={{ height: `${(d.costUsd / max) * 100}%`, minHeight: d.costUsd > 0 ? '2px' : 0 }}
          />
          {daily.length <= 14 && <div className="text-[10px] text-gray-500 mt-1 truncate">{d.date.slice(5)}</div>}
        </div>
      ))}
    </div>
  );
}

function AiCosts() {
  const [preset, setPreset] = useState('today');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchCosts = async (selected = preset) => {
    if (selected === 'custom' && (!customFrom || !customTo)) return;
    try {
      setLoading(true);
      const params = selected === 'custom' ? { preset: 'custom', from: customFrom, to: customTo } : { preset: selected };
      const res = await getAiCosts(params);
      setData(res.data.data);
      setError(null);
    } catch (err) {
      console.error('Error fetching AI costs:', err);
      setError(err.response?.data?.errors?.join(', ') || 'Failed to load AI cost data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (preset !== 'custom') fetchCosts(preset);
  }, [preset]);

  const rate = data?.currency.usdToInr;
  const health = data?.trackingHealth;
  const healthIssues = health && [
    health.trackingErrorsInRange > 0 && `${health.trackingErrorsInRange} usage record(s) failed to save in this range - those costs are missing.`,
    health.process.failures > 0 && `${health.process.failures} tracking failure(s) on this server since ${new Date(health.process.since).toLocaleString('en-IN')}.`,
    health.unknownCostRequests > 0 && `${health.unknownCostRequests} request(s) have unknown cost (missing usage data or failed requests) and are excluded from totals.`,
    health.failedRequests > 0 && `${health.failedRequests} OpenAI request(s) failed. Failed requests are usually not billed, but a timeout or dropped connection after OpenAI received the request may still be billed.`
  ].filter(Boolean);

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-wrap justify-between items-center gap-4 mb-6">
          <h1 className="text-3xl font-bold text-gray-900">AI Cost Analytics</h1>
          <button onClick={() => fetchCosts()} className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
            Refresh
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 mb-4">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              onClick={() => setPreset(p.key)}
              className={`px-4 py-2 rounded-lg text-sm ${preset === p.key ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 shadow hover:bg-gray-100'}`}
            >
              {p.label}
            </button>
          ))}
          {preset === 'custom' && (
            <>
              <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="border rounded-lg px-3 py-2 text-sm" />
              <span className="text-gray-500">to</span>
              <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="border rounded-lg px-3 py-2 text-sm" />
              <button onClick={() => fetchCosts('custom')} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">Apply</button>
            </>
          )}
        </div>

        <div className="bg-blue-50 border border-blue-200 text-blue-800 text-sm rounded-lg p-4 mb-6">
          Costs are <strong>estimated from recorded usage</strong> using configured OpenAI prices - they are not OpenAI's billed amounts.
          Usage is recorded only from when tracking was deployed; earlier costs are not reconstructed. Dates are IST calendar days.
          {rate ? ` INR values are approximate (1 USD ≈ ₹${rate}).` : ''}
        </div>

        {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-4 mb-6">{error}</div>}
        {loading && <div className="text-gray-500 mb-6">Loading…</div>}

        {data && !loading && (
          <>
            {healthIssues.length > 0 && (
              <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-lg p-4 mb-6">
                <div className="font-semibold mb-1">Tracking health</div>
                <ul className="list-disc pl-5 space-y-1">{healthIssues.map((m) => <li key={m}>{m}</li>)}</ul>
              </div>
            )}

            <p className="text-sm text-gray-600 mb-4">
              {data.range.fromDate === data.range.toDate ? data.range.fromDate : `${data.range.fromDate} → ${data.range.toDate}`} ({data.range.days} day{data.range.days !== 1 ? 's' : ''}, IST)
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
              <Card title="Total estimated OpenAI cost" value={formatUsd(data.totals.costUsd)} sub={formatInr(data.totals.costUsd, rate) || 'Known-cost requests only'} color="text-orange-600" />
              <Card
                title="API requests"
                value={formatNumber(data.totals.requests)}
                sub={`${data.totals.failedRequests} failed · ${data.totals.unknownCostRequests} unknown cost`}
              />
              <Card
                title="Tokens"
                value={formatNumber(data.totals.inputTokens + data.totals.outputTokens)}
                sub={`In ${formatNumber(data.totals.inputTokens)} (cached ${formatNumber(data.totals.cachedInputTokens)}) · Out ${formatNumber(data.totals.outputTokens)} · Audio ${(data.totals.audioSeconds / 60).toFixed(1)} min`}
              />
              <Card
                title="Avg cost per active learner"
                value={formatUsd(data.averages.costPerUserWithAiUsageUsd)}
                sub={`Attributed cost ÷ ${data.users.incurredAiCost} learner(s) with AI usage`}
                color="text-blue-600"
              />
              <Card
                title="Avg cost per learner sent a lesson"
                value={formatUsd(data.averages.costPerLearnerSentLessonUsd)}
                sub={`Their attributed cost ÷ ${data.users.sentLesson} learner(s)`}
                color="text-blue-600"
              />
              <Card
                title="Cost per completed lesson"
                value={formatUsd(data.averages.costPerCompletedLessonUsd)}
                sub={`All recorded AI cost ÷ ${data.lessons.completed} lesson(s) completed`}
                color="text-purple-600"
              />
            </div>

            <Section title="Learners">
              <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-center">
                {[
                  ['Registered users', data.users.registered, 'all time'],
                  ['Active subscribed', data.users.activeSubscribed, 'right now'],
                  ['Sent a lesson', data.users.sentLesson, 'in range'],
                  ['Completed a lesson', data.users.completedLesson, 'in range'],
                  ['Incurred AI cost', data.users.incurredAiCost, 'in range']
                ].map(([label, value, sub]) => (
                  <div key={label}>
                    <div className="text-2xl font-bold text-gray-900">{formatNumber(value)}</div>
                    <div className="text-sm text-gray-600">{label}</div>
                    <div className="text-xs text-gray-400">{sub}</div>
                  </div>
                ))}
              </div>
            </Section>

            <Section title="Daily estimated cost" note="Amber bars include requests with unknown cost.">
              <DailyChart daily={data.daily} />
            </Section>

            <Section title="Cost by operation">
              <UsageTable rows={data.byOperation} labelKey="operation" labelTitle="Operation" />
            </Section>

            <Section title="Cost by model">
              <UsageTable rows={data.byModel} labelKey="model" labelTitle="Model" />
            </Section>

            <Section
              title="Cost per learner"
              note={data.perUserTruncated ? 'Showing the 200 highest-cost learners.' : 'Includes onboarding, daily lessons, voice practice and retries.'}
            >
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium text-gray-500">Learner</th>
                    <th className="px-4 py-2 text-right font-medium text-gray-500">Requests</th>
                    <th className="px-4 py-2 text-right font-medium text-gray-500">Lessons</th>
                    <th className="px-4 py-2 text-right font-medium text-gray-500">Voice</th>
                    <th className="px-4 py-2 text-right font-medium text-gray-500">Onboarding</th>
                    <th className="px-4 py-2 text-right font-medium text-gray-500">Total</th>
                    <th className="px-4 py-2 text-right font-medium text-gray-500">Unknown cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {data.perUser.map((u) => (
                    <tr key={u.userId}>
                      <td className="px-4 py-2 text-gray-900">{u.name} <span className="text-gray-400">{u.phone}</span></td>
                      <td className="px-4 py-2 text-right">{formatNumber(u.requests)}</td>
                      <td className="px-4 py-2 text-right">{formatUsd(u.lessonCostUsd)}</td>
                      <td className="px-4 py-2 text-right">{formatUsd(u.voiceCostUsd)}</td>
                      <td className="px-4 py-2 text-right">{formatUsd(u.onboardingCostUsd)}</td>
                      <td className="px-4 py-2 text-right font-semibold">{formatUsd(u.costUsd)}</td>
                      <td className={`px-4 py-2 text-right ${u.unknownCostRequests ? 'text-amber-600' : 'text-gray-400'}`}>{u.unknownCostRequests}</td>
                    </tr>
                  ))}
                  <tr className="bg-gray-50">
                    <td className="px-4 py-2 text-gray-700 italic">Unattributed (not linked to a learner)</td>
                    <td className="px-4 py-2 text-right">{formatNumber(data.unattributed.requests)}</td>
                    <td colSpan={3} />
                    <td className="px-4 py-2 text-right font-semibold">{formatUsd(data.unattributed.costUsd)}</td>
                    <td className="px-4 py-2 text-right">{data.unattributed.unknownCostRequests}</td>
                  </tr>
                </tbody>
              </table>
              {data.perUser.length === 0 && <p className="text-gray-500 mt-4">No learner-attributed usage in this range.</p>}
            </Section>

            <Section title="30-day OpenAI cost forecast" note="AI cost only - excludes WhatsApp, AWS, database and payment gateway costs. Not a total operating cost.">
              {data.forecast.warnings.length > 0 && (
                <ul className="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-lg p-4 mb-4 list-disc pl-8 space-y-1">
                  {data.forecast.warnings.map((w) => <li key={w}>{w}</li>)}
                </ul>
              )}
              {!data.forecast.available ? (
                <p className="text-gray-500">{data.forecast.reason}</p>
              ) : (
                <>
                  <table className="min-w-full divide-y divide-gray-200 text-sm mb-4">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-2 text-left font-medium text-gray-500">Learners</th>
                        <th className="px-4 py-2 text-right font-medium text-gray-500">Learning (30 days)</th>
                        <th className="px-4 py-2 text-right font-medium text-gray-500">Unattributed (30 days)</th>
                        <th className="px-4 py-2 text-right font-medium text-gray-500">Est. 30-day AI cost</th>
                        <th className="px-4 py-2 text-right font-medium text-gray-500">+ One-time onboarding</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {data.forecast.rows.map((r) => (
                        <tr key={r.learners}>
                          <td className="px-4 py-2 text-gray-900">{formatNumber(r.learners)}</td>
                          <td className="px-4 py-2 text-right">{formatUsd(r.recurring30DayUsd)}</td>
                          <td className="px-4 py-2 text-right">{formatUsd(r.unattributed30DayUsd)}</td>
                          <td className="px-4 py-2 text-right font-semibold">
                            {formatUsd(r.total30DayUsd)}
                            {rate && <div className="text-xs text-gray-500 font-normal">{formatInr(r.total30DayUsd, rate)}</div>}
                          </td>
                          <td className="px-4 py-2 text-right">{r.oneTimeOnboardingUsd === null ? 'not observed' : formatUsd(r.oneTimeOnboardingUsd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="text-sm text-gray-600 space-y-1">
                    <p>
                      Based on {data.forecast.assumptions.basisDays} day(s): {data.forecast.assumptions.learnersSentLesson} learner(s) over{' '}
                      {formatNumber(data.forecast.assumptions.learnerDays)} enrolled learner-day(s) were sent {data.forecast.assumptions.lessonsSent} lesson(s){' '}
                      ({data.forecast.assumptions.lessonsPerLearnerPerDay.toFixed(2)} per learner-day).
                      Observed learning cost: {formatUsd(data.forecast.assumptions.perLearnerDayUsd)} per learner-day ={' '}
                      {formatUsd(data.forecast.assumptions.perLearner30DayUsd)} per learner per 30 days.
                    </p>
                    <ul className="list-disc pl-5 text-xs text-gray-500">
                      {data.forecast.assumptions.notes.map((n) => <li key={n}>{n}</li>)}
                    </ul>
                  </div>
                </>
              )}
            </Section>

            <p className="text-xs text-gray-400">
              Pricing version {data.pricing.version}:{' '}
              {Object.entries(data.pricing.models).map(([model, p]) => (
                p.billing === 'tokens'
                  ? `${model} $${p.inputPer1M} in / $${p.cachedInputPer1M} cached / $${p.outputPer1M} out per 1M tokens`
                  : `${model} $${p.perAudioMinute} per audio minute`
              )).join(' · ')}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

export default AiCosts;
