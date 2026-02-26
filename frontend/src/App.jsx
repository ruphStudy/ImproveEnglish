import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Users from './pages/Users';
import Logs from './pages/Logs';
import RegistrationLogs from './pages/RegistrationLogs';
import BuyPlan from './pages/BuyPlan';
import Analytics from './pages/Analytics';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public route - no navigation */}
        <Route path="/buy" element={<BuyPlan />} />
        
        {/* Admin routes with navigation */}
        <Route path="/*" element={
          <div className="min-h-screen bg-gray-50">
            <nav className="bg-white shadow p-4 flex gap-6">
              <a href="/" className="font-bold">Dashboard</a>
              <a href="/users">Users</a>
              <a href="/analytics" className="text-purple-600">Analytics</a>
              <a href="/registration-logs" className="text-green-600">Registration Logs</a>
              <a href="/logs">System Logs</a>
            </nav>
            <div className="p-4">
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/users" element={<Users />} />
                <Route path="/analytics" element={<Analytics />} />
                <Route path="/registration-logs" element={<RegistrationLogs />} />
                <Route path="/logs" element={<Logs />} />
                <Route path="*" element={<Navigate to="/" />} />
              </Routes>
            </div>
          </div>
        } />
      </Routes>
    </BrowserRouter>
  );
}
