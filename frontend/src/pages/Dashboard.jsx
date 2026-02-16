import React, { useEffect, useState } from 'react';
import { getUsers, getLogs, getRegistrationStats } from '../api';

export default function Dashboard() {
  const [stats, setStats] = useState({ total: 0, byState: {}, lessonsToday: 0 });
  const [regStats, setRegStats] = useState({ total: 0, success: 0, duplicate: 0, error: 0, todayTotal: 0 });
  const [error, setError] = useState(null);

  useEffect(() => {
    async function fetchStats() {
      try {
        const usersRes = await getUsers();
        const logsRes = await getLogs({ type: 'LESSON_GENERATED' });
        const regStatsRes = await getRegistrationStats();
        
        // Safely handle array responses
        const users = Array.isArray(usersRes.data) ? usersRes.data : [];
        const logs = Array.isArray(logsRes.data) ? logsRes.data : [];
        
        const byState = {};
        users.forEach(u => {
          byState[u.state] = (byState[u.state] || 0) + 1;
        });
        
        setStats({
          total: users.length,
          byState,
          lessonsToday: logs.filter(l => new Date(l.createdAt).toDateString() === new Date().toDateString()).length
        });
        
        setRegStats(regStatsRes.data || { total: 0, success: 0, duplicate: 0, error: 0, todayTotal: 0 });
      } catch (err) {
        console.error('Failed to fetch dashboard stats:', err);
        setError(err.message || 'Failed to load dashboard data');
      }
    }
    fetchStats();
  }, []);

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Dashboard</h1>
      
      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
          <p className="font-bold">Error</p>
          <p>{error}</p>
          <p className="text-sm mt-2">Please check if the backend API is running at: {import.meta.env.VITE_API_URL}</p>
        </div>
      )}
      
      <h2 className="text-xl font-semibold mb-3 mt-6">User Statistics</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white p-4 rounded shadow">
          <div className="text-gray-500">Total Users</div>
          <div className="text-3xl font-bold">{stats.total}</div>
        </div>
        <div className="bg-white p-4 rounded shadow">
          <div className="text-gray-500">Users by State</div>
          <ul className="mt-2">
            {Object.entries(stats.byState).map(([state, count]) => (
              <li key={state} className="text-sm">{state}: <b>{count}</b></li>
            ))}
          </ul>
        </div>
        <div className="bg-white p-4 rounded shadow">
          <div className="text-gray-500">Lessons Generated Today</div>
          <div className="text-3xl font-bold">{stats.lessonsToday}</div>
        </div>
      </div>
      
      <h2 className="text-xl font-semibold mb-3 mt-6">Registration Statistics</h2>
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
        <div className="bg-white p-4 rounded shadow">
          <div className="text-gray-500 text-sm">Total Attempts</div>
          <div className="text-3xl font-bold">{regStats.total}</div>
        </div>
        <div className="bg-green-50 p-4 rounded shadow border border-green-200">
          <div className="text-green-600 text-sm">Success</div>
          <div className="text-3xl font-bold text-green-700">{regStats.success}</div>
        </div>
        <div className="bg-yellow-50 p-4 rounded shadow border border-yellow-200">
          <div className="text-yellow-600 text-sm">Duplicates</div>
          <div className="text-3xl font-bold text-yellow-700">{regStats.duplicate}</div>
        </div>
        <div className="bg-red-50 p-4 rounded shadow border border-red-200">
          <div className="text-red-600 text-sm">Errors</div>
          <div className="text-3xl font-bold text-red-700">{regStats.error}</div>
        </div>
        <div className="bg-blue-50 p-4 rounded shadow border border-blue-200">
          <div className="text-blue-600 text-sm">Today's Attempts</div>
          <div className="text-3xl font-bold text-blue-700">{regStats.todayTotal}</div>
        </div>
      </div>
    </div>
  );
}
