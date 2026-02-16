import React, { useEffect, useState } from 'react';
import { getUsers, updateUser } from '../api';
import { formatDate } from '../utils/formatDate';

const STATES = ['NEW', 'READY', 'WAITING_START', 'IN_LESSON', 'COMPLETED_TODAY', 'PAUSED'];

export default function Users() {
  const [users, setUsers] = useState([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchUsers();
  }, [filter]);

  async function fetchUsers() {
    setLoading(true);
    setError(null);
    try {
      const res = await getUsers(filter ? { state: filter } : {});
      // Ensure data is an array
      setUsers(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      console.error('Failed to fetch users:', err);
      setError(err.message || 'Failed to load users');
      setUsers([]); // Set empty array on error
    } finally {
      setLoading(false);
    }
  }

  async function handleStateChange(id, state) {
    await updateUser(id, { state });
    fetchUsers();
  }

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Users</h1>
      
      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
          <p className="font-bold">Error</p>
          <p>{error}</p>
          <p className="text-sm mt-2">Please check if the backend API is running and accessible.</p>
        </div>
      )}
      
      <div className="mb-2">
        <label>Filter by state: </label>
        <select value={filter} onChange={e => setFilter(e.target.value)} className="border p-1 rounded">
          <option value="">All</option>
          {STATES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full bg-white rounded shadow">
          <thead>
            <tr>
              <th className="p-2">Name</th>
              <th className="p-2">Phone</th>
              <th className="p-2">State</th>
              <th className="p-2">Current Day</th>
              <th className="p-2">Last Seen</th>
              <th className="p-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? <tr><td colSpan={6} className="text-center">Loading...</td></tr> :
              users.length === 0 ? (
                <tr><td colSpan={6} className="text-center text-gray-500 py-4">
                  {error ? 'Unable to load users' : 'No users found'}
                </td></tr>
              ) :
              users.map(u => (
                <tr key={u._id}>
                  <td className="p-2">{u.name}</td>
                  <td className="p-2">{u.phone}</td>
                  <td className="p-2">{u.state}</td>
                  <td className="p-2">{u.currentDay}</td>
                  <td className="p-2">{formatDate(u.lastSeenAt)}</td>
                  <td className="p-2">
                    <select value={u.state} onChange={e => handleStateChange(u._id, e.target.value)} className="border p-1 rounded">
                      {STATES.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
