import axios from 'axios';

// Use environment variable for API URL
// Development: http://localhost:3000
// Production: https://api.fluencyloop.in
const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL + '/api',
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
