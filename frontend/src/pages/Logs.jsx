import React, { useEffect, useState } from 'react';
import { getLogs } from '../api';
import { formatDate } from '../utils/formatDate';

const TYPES = ['LESSON_GENERATED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'ERROR'];

export default function Logs() {
  const [logs, setLogs] = useState([]);
  const [type, setType] = useState('');
  const [date, setDate] = useState('');

  useEffect(() => {
    fetchLogs();
  }, [type, date]);

  async function fetchLogs() {
    const params = {};
    if (type) params.type = type;
    if (date) params.startDate = date;
    const res = await getLogs(params);
    setLogs(res.data);
  }

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Logs</h1>
      <div className="mb-2 flex gap-4">
        <div>
          <label>Type: </label>
          <select value={type} onChange={e => setType(e.target.value)} className="border p-1 rounded">
            <option value="">All</option>
            {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label>Date: </label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} className="border p-1 rounded" />
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full bg-white rounded shadow">
          <thead>
            <tr>
              <th className="p-2">Type</th>
              <th className="p-2">Phone</th>
              <th className="p-2">Message</th>
              <th className="p-2">Created At</th>
            </tr>
          </thead>
          <tbody>
            {logs.map(l => (
              <tr key={l._id}>
                <td className="p-2">{l.type}</td>
                <td className="p-2">{l.phone}</td>
                <td className="p-2">{l.message}</td>
                <td className="p-2">{formatDate(l.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
