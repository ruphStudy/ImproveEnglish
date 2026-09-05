import axios from 'axios';

// Use environment variable for API URL
// Development: http://localhost:3000
// Production: https://api.fluencyloop.in
const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL + '/api',
});

// Admin endpoints (users/logs/analytics/registration-*) require an
// x-admin-secret header (see backend/middleware/adminAuth.js). The secret is
// entered once by the admin at runtime (see AdminSecretGate) and kept only in
// sessionStorage - it must NEVER be baked into the build/bundle, since that
// would publish it to every visitor of this public site.
const ADMIN_SECRET_STORAGE_KEY = 'fluencyloop_admin_secret';

export function getStoredAdminSecret() {
  try {
    return sessionStorage.getItem(ADMIN_SECRET_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export function setStoredAdminSecret(secret) {
  try {
    sessionStorage.setItem(ADMIN_SECRET_STORAGE_KEY, secret);
  } catch {
    // sessionStorage unavailable (e.g. private browsing) - secret just won't persist across reloads
  }
}

export function clearStoredAdminSecret() {
  try {
    sessionStorage.removeItem(ADMIN_SECRET_STORAGE_KEY);
  } catch {
    // ignore
  }
}

// Harmless no-op for public endpoints (create-order/order-status/plans) since
// they ignore unknown headers - only admin-protected routes check this one.
api.interceptors.request.use((config) => {
  const secret = getStoredAdminSecret();
  if (secret) {
    config.headers['x-admin-secret'] = secret;
  }
  return config;
});

export const getUsers = (params) => api.get('/users', { params });
export const updateUser = (id, data) => api.patch(`/users/${id}`, data);
export const getLogs = (params) => api.get('/logs', { params });
export const getRegistrationLogs = (params) => api.get('/registration-logs', { params });
export const getRegistrationStats = () => api.get('/registration-stats');

// Payment APIs
export const createOrder = (data) => api.post('/payments/create-order', data);
export const getOrderStatus = (orderId) => api.get(`/payments/order-status/${orderId}`);

// Plan APIs
export const getPlans = () => api.get('/plans');

export default api;
