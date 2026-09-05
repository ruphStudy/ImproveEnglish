import { useState, useEffect } from 'react';
import { getUsers, getStoredAdminSecret, setStoredAdminSecret, clearStoredAdminSecret } from '../api';

/**
 * Gates the internal admin UI behind the same x-admin-secret the backend's
 * adminAuth middleware requires (see backend/middleware/adminAuth.js). The
 * secret is entered once per browser session and kept only in
 * sessionStorage - never in an env var baked into this public bundle, which
 * would publish it to any visitor.
 */
export default function AdminSecretGate({ children }) {
  const [verified, setVerified] = useState(false);
  const [checking, setChecking] = useState(true);
  const [input, setInput] = useState('');
  const [error, setError] = useState('');

  async function verify(secret) {
    setChecking(true);
    setError('');
    setStoredAdminSecret(secret);
    try {
      await getUsers({ limit: 1 });
      setVerified(true);
    } catch (err) {
      clearStoredAdminSecret();
      setVerified(false);
      if (err.response && (err.response.status === 401 || err.response.status === 503)) {
        setError('Incorrect admin secret, or the server has none configured.');
      } else {
        setError('Could not reach the server. Please try again.');
      }
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    const existing = getStoredAdminSecret();
    if (existing) {
      verify(existing);
    } else {
      setChecking(false);
    }
  }, []);

  if (checking) {
    return <div className="min-h-screen flex items-center justify-center text-gray-500">Loading…</div>;
  }

  if (!verified) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <form
          className="bg-white shadow rounded-lg p-8 w-full max-w-sm"
          onSubmit={(e) => {
            e.preventDefault();
            verify(input);
          }}
        >
          <h1 className="text-lg font-bold mb-4">Admin Access</h1>
          <input
            type="password"
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Admin secret"
            className="w-full px-4 py-2 border border-gray-300 rounded-lg mb-3"
          />
          {error && <p className="text-red-600 text-sm mb-3">{error}</p>}
          <button
            type="submit"
            className="w-full py-2 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700"
          >
            Enter
          </button>
        </form>
      </div>
    );
  }

  return children;
}
