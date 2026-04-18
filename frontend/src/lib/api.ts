import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api/v1',
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('payflow_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('payflow_token');
      localStorage.removeItem('payflow_merchant');
      window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

export default api;

export function formatPaise(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export const STATUS_COLORS: Record<string, string> = {
  created:    'bg-slate-700/60 text-slate-300',
  authorized: 'bg-blue-500/15 text-blue-400',
  captured:   'bg-emerald-500/15 text-emerald-400',
  failed:     'bg-red-500/15 text-red-400',
  blocked:    'bg-red-500/20 text-red-400 border border-red-500/30',
  refunded:   'bg-amber-500/15 text-amber-400',
  pending:    'bg-orange-500/15 text-orange-400',
  delivered:  'bg-emerald-500/15 text-emerald-400',
};
