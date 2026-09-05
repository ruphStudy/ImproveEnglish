import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Users from './pages/Users';
import Logs from './pages/Logs';
import RegistrationLogs from './pages/RegistrationLogs';
import BuyPlan from './pages/BuyPlan';
import Analytics from './pages/Analytics';
import PrivacyPolicy from './pages/PrivacyPolicy';
import Terms from './pages/Terms';
import Contact from './pages/Contact';
import AdminSecretGate from './components/AdminSecretGate';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public routes - no admin navigation */}
        <Route path="/buy" element={<BuyPlan />} />
        <Route path="/privacy-policy" element={<PrivacyPolicy />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="/contact" element={<Contact />} />
        
        {/* Admin routes with navigation - gated behind the admin secret, since
            Prompt 3 protects /api/users, /api/logs, /api/analytics/*, etc. */}
        <Route path="/*" element={
          <AdminSecretGate>
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
          </AdminSecretGate>
        } />
      </Routes>
    </BrowserRouter>
  );
}
