import React, { useEffect, useState } from 'react';
import { getRegistrationLogs } from '../api';
import { formatDate } from '../utils/formatDate';

const STATUSES = ['SUCCESS', 'ERROR', 'DUPLICATE'];

export default function RegistrationLogs() {
  const [logs, setLogs] = useState([]);
  const [status, setStatus] = useState('');
  const [phone, setPhone] = useState('');
  const [date, setDate] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchLogs();
  }, [status, date, phone]);

  async function fetchLogs() {
    setLoading(true);
    setError(null);
    try {
      const params = {};
      if (status) params.status = status;
      if (phone) params.phone = phone;
      if (date) params.startDate = date;
      const res = await getRegistrationLogs(params);
      setLogs(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      console.error('Failed to fetch registration logs:', err);
      setError(err.message || 'Failed to load registration logs');
      setLogs([]);
    } finally {
      setLoading(false);
    }
  }

  const getStatusColor = (status) => {
    switch (status) {
      case 'SUCCESS':
        return 'bg-green-100 text-green-800';
      case 'ERROR':
        return 'bg-red-100 text-red-800';
      case 'DUPLICATE':
        return 'bg-yellow-100 text-yellow-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Registration Logs</h1>
      
      <div className="mb-4 flex gap-4 flex-wrap">
        <div>
          <label className="mr-2">Status: </label>
          <select 
            value={status} 
            onChange={e => setStatus(e.target.value)} 
            className="border p-2 rounded"
          >
            <option value="">All</option>
            {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        
        <div>
          <label className="mr-2">Phone: </label>
          <input 
            type="text" 
            value={phone} 
            onChange={e => setPhone(e.target.value)} 
            placeholder="Search by phone"
            className="border p-2 rounded"
          />
        </div>
        
        <div>
          <label className="mr-2">Date: </label>
          <input 
            type="date" 
            value={date} 
            onChange={e => setDate(e.target.value)} 
            className="border p-2 rounded"
          />
        </div>
        
        <button 
          onClick={fetchLogs}
          className="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600"
        >
          Refresh
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full bg-white rounded shadow">
          <thead className="bg-gray-100">
            <tr>
              <th className="p-3 text-left">Status</th>
              <th className="p-3 text-left">Name</th>
              <th className="p-3 text-left">Phone</th>
              <th className="p-3 text-left">Email</th>
              <th className="p-3 text-left">Message</th>
              <th className="p-3 text-left">IP Address</th>
              <th className="p-3 text-left">Created At</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7} className="text-center p-4">Loading...</td>
              </tr>
            ) : logs.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-center p-4">No logs found</td>
              </tr>
            ) : (
              logs.map(log => (
                <tr key={log._id} className="border-t hover:bg-gray-50">
                  <td className="p-3">
                    <span className={`px-2 py-1 rounded text-xs font-semibold ${getStatusColor(log.status)}`}>
                      {log.status}
                    </span>
                  </td>
                  <td className="p-3">{log.name || '-'}</td>
                  <td className="p-3">{log.phone || '-'}</td>
                  <td className="p-3">{log.email || '-'}</td>
                  <td className="p-3">
                    <div className="max-w-xs">
                      <div className="font-medium">{log.message}</div>
                      {log.errorDetails && (
                        <div className="text-xs text-red-600 mt-1">{log.errorDetails}</div>
                      )}
                    </div>
                  </td>
                  <td className="p-3 text-sm text-gray-600">{log.ipAddress || '-'}</td>
                  <td className="p-3 text-sm">{formatDate(log.createdAt)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      
      <div className="mt-4 text-sm text-gray-600">
        Showing {logs.length} registration attempts
      </div>
    </div>
  );
}
