import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
});

export const getUsers = (params) => api.get('/users', { params });
export const updateUser = (id, data) => api.patch(`/users/${id}`, data);
export const getLogs = (params) => api.get('/logs', { params });
export const getRegistrationLogs = (params) => api.get('/registration-logs', { params });
export const getRegistrationStats = () => api.get('/registration-stats');

export default api;
