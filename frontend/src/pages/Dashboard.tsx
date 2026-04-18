import { useEffect, useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import api, { formatPaise, formatDate, STATUS_COLORS } from '../lib/api';
import { usePolling } from '../hooks/usePolling';

interface Summary { total_volume: number; total_payments: number; successful_payments: number; failed_payments: number; success_rate: number; avg_transaction: number }
interface DailyPoint { date: string; volume: number; count: number }
interface Payment { id: string; amount: number; status: string; description: string | null; created_at: string }
interface AnomalyResult { has_anomaly: boolean; severity?: 'low' | 'medium' | 'high'; message?: string }

const Skeleton = ({ className }: { className?: string }) => <div className={`skeleton rounded-lg ${className}`} />;

function useCountUp(target: number, duration = 1000) {
  const [value, setValue] = useState(0);
  const raf = useRef<number>();
  useEffect(() => {
    if (!target) { setValue(0); return; }
    const start = performance.now();
    const from = value;
    const tick = (now: number) => {
      const p = Math.min((now - start) / duration, 1);
      const ease = 1 - Math.pow(1 - p, 3);
      setValue(Math.floor(from + ease * (target - from)));
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => { if (raf.current) cancelAnimationFrame(raf.current); };
  }, [target]);
  return value;
}

function useClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

const SEVERITY_STYLES = {
  low:    { border: 'border-amber-500/30',  bg: 'bg-amber-500/10',  text: 'text-amber-400',  dot: 'bg-amber-400'  },
  medium: { border: 'border-orange-500/30', bg: 'bg-orange-500/10', text: 'text-orange-400', dot: 'bg-orange-400' },
  high:   { border: 'border-red-500/30',    bg: 'bg-red-500/10',    text: 'text-red-400',    dot: 'bg-red-500'    },
};

const CARDS = [
  { key: 'total_volume',    label: 'Total Volume',    from: 'from-blue-500',    to: 'to-blue-600',    shadow: 'shadow-blue-900/40',    icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg> },
  { key: 'total_payments',  label: 'Transactions',    from: 'from-violet-500',  to: 'to-violet-600',  shadow: 'shadow-violet-900/40',  icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg> },
  { key: 'success_rate',    label: 'Success Rate',    from: 'from-emerald-500', to: 'to-emerald-600', shadow: 'shadow-emerald-900/40', icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg> },
  { key: 'avg_transaction', label: 'Avg Transaction', from: 'from-indigo-500',  to: 'to-indigo-600',  shadow: 'shadow-indigo-900/40',  icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"/></svg> },
];

function StatCard({ label, value, from, to, shadow, icon, index, loading }: any) {
  const num = useCountUp(loading ? 0 : Math.round(typeof value === 'number' ? value : 0));
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.07, duration: 0.3 }}
      whileHover={{ y: -3, transition: { duration: 0.15 } }}
      className="bg-slate-900 border border-slate-800 hover:border-slate-700 rounded-2xl p-5 transition-colors"
    >
      {loading ? (
        <><Skeleton className="h-3.5 w-24 mb-4" /><Skeleton className="h-8 w-32" /></>
      ) : (
        <>
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm text-slate-400">{label}</p>
            <div className={`w-9 h-9 rounded-xl bg-gradient-to-br ${from} ${to} flex items-center justify-center text-white shadow-lg ${shadow}`}>{icon}</div>
          </div>
          <p className="text-2xl font-bold text-white tracking-tight">
            {label === 'Success Rate' ? `${value}%`
              : label === 'Transactions' ? num.toLocaleString()
              : formatPaise(num)}
          </p>
        </>
      )}
    </motion.div>
  );
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 shadow-2xl">
      <p className="text-slate-400 text-xs mb-1">{label}</p>
      <p className="text-white font-semibold text-sm">{formatPaise(payload[0].value)}</p>
    </div>
  );
};

const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.04 } } };
const fadeUp = { hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0, transition: { duration: 0.2 } } };

export default function Dashboard() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [daily, setDaily] = useState<DailyPoint[]>([]);
  const [recent, setRecent] = useState<Payment[]>([]);
  const [anomaly, setAnomaly] = useState<AnomalyResult | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [, setLastUpdated] = useState<Date | null>(null);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  const prevIds = useRef<Set<string>>(new Set());

  async function fetchData(isInitial = false) {
    try {
      const [s, d, p] = await Promise.all([
        api.get('/analytics/summary'),
        api.get('/analytics/daily'),
        api.get('/payments?limit=6'),
      ]);
      setSummary(s.data);
      setDaily(d.data.data);

      const incoming: Payment[] = p.data.payments;
      const incomingIds = new Set(incoming.map(x => x.id));
      if (!isInitial) {
        const added = new Set([...incomingIds].filter(id => !prevIds.current.has(id)));
        if (added.size > 0) {
          setNewIds(added);
          setTimeout(() => setNewIds(new Set()), 3000);
        }
      }
      prevIds.current = incomingIds;
      setRecent(incoming);
      setLastUpdated(new Date());
    } catch { /* silent */ }
    finally { if (isInitial) setLoading(false); }
  }

  useEffect(() => {
    fetchData(true);
    api.get('/analytics/anomalies').catch(() => null).then(a => { if (a) setAnomaly(a.data); });
  }, []);

  usePolling(() => fetchData(false), 5000);

  const sev = anomaly?.severity ? SEVERITY_STYLES[anomaly.severity] : null;
  const clock = useClock();
  const timeStr = clock.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });

  return (
    <div className="p-8 w-full">
      {/* Header */}
      <div className="flex items-start justify-between mb-7">
        <div>
          <h1 className="text-xl font-bold text-white">Dashboard</h1>
          <p className="text-slate-500 text-sm mt-0.5">Overview of your payment activity</p>
        </div>
        <div className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-emerald-500/8 border border-emerald-500/20 shadow-lg shadow-emerald-900/10">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
          </span>
          <span className="text-xs font-semibold text-emerald-400 tracking-wide uppercase">Live</span>
          <span className="w-px h-3 bg-emerald-500/30" />
          <span className="text-xs font-mono text-emerald-300/80 tabular-nums">{timeStr}</span>
        </div>
      </div>

      {/* Anomaly */}
      {anomaly?.has_anomaly && !dismissed && sev && (
        <motion.div initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }}
          className={`flex items-start justify-between gap-4 border ${sev.border} ${sev.bg} rounded-2xl px-5 py-4 mb-6`}>
          <div className="flex items-start gap-3">
            <div className={`w-2 h-2 rounded-full ${sev.dot} mt-1.5 flex-shrink-0 animate-pulse`} />
            <div>
              <p className={`font-semibold text-sm ${sev.text}`}>
                AI Anomaly Detected
                <span className="ml-2 text-xs font-normal opacity-60 uppercase tracking-wide">{anomaly.severity}</span>
              </p>
              {anomaly.message && <p className={`text-sm mt-0.5 ${sev.text} opacity-80`}>{anomaly.message}</p>}
            </div>
          </div>
          <button onClick={() => setDismissed(true)} className={`${sev.text} opacity-40 hover:opacity-100 text-xl leading-none`}>&times;</button>
        </motion.div>
      )}

      {/* Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {CARDS.map((c, i) => (
          <StatCard key={c.key} label={c.label} value={summary ? (summary as any)[c.key] : 0}
            from={c.from} to={c.to} shadow={c.shadow} icon={c.icon} index={i} loading={loading} />
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Chart */}
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.28 }}
          className="lg:col-span-2 bg-slate-900 border border-slate-800 rounded-2xl p-6">
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-sm font-semibold text-white">Volume — Last 30 Days</h2>
            <span className="text-xs text-slate-500 bg-slate-800 px-2.5 py-1 rounded-full border border-slate-700">{daily.length} days</span>
          </div>
          {loading ? <Skeleton className="h-64 w-full" /> : daily.length === 0 ? (
            <div className="h-64 flex flex-col items-center justify-center text-slate-600">
              <svg className="w-10 h-10 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/></svg>
              <p className="text-sm">No data yet — create some payments</p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={daily}>
                <defs>
                  <linearGradient id="vg" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#475569' }} tickFormatter={v => v.slice(5)} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: '#475569' }} tickFormatter={v => `₹${(v/100).toFixed(0)}`} axisLine={false} tickLine={false} />
                <Tooltip content={<CustomTooltip />} />
                <Area type="monotone" dataKey="volume" stroke="#3b82f6" strokeWidth={2} fill="url(#vg)" dot={false} activeDot={{ r: 4, fill: '#3b82f6', strokeWidth: 0 }} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </motion.div>

        {/* Recent */}
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.32 }}
          className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-white">Recent Payments</h2>
            <span className="text-xs text-slate-600">auto-refresh</span>
          </div>
          {loading ? (
            <div className="space-y-4">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="flex justify-between">
                  <div className="space-y-1.5"><Skeleton className="h-3 w-28" /><Skeleton className="h-2.5 w-20" /></div>
                  <div className="space-y-1.5 flex flex-col items-end"><Skeleton className="h-3.5 w-16" /><Skeleton className="h-4 w-14 rounded-full" /></div>
                </div>
              ))}
            </div>
          ) : recent.length === 0 ? (
            <p className="text-slate-600 text-sm">No payments yet</p>
          ) : (
            <motion.div variants={stagger} initial="hidden" animate="show" className="space-y-3">
              <AnimatePresence>
                {recent.map(p => (
                  <motion.div key={p.id} variants={fadeUp}
                    initial={newIds.has(p.id) ? { opacity: 0, x: 20, backgroundColor: 'rgba(59,130,246,0.1)' } : false}
                    animate={{ opacity: 1, x: 0, backgroundColor: 'rgba(0,0,0,0)' }}
                    transition={{ duration: 0.4 }}
                    className="flex items-start justify-between gap-2 group rounded-xl p-1 -m-1">
                    <div className="min-w-0">
                      <p className="text-xs font-mono text-slate-500 truncate group-hover:text-blue-400 transition-colors">{p.id}</p>
                      <p className="text-xs text-slate-600 mt-0.5">{formatDate(p.created_at)}</p>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="text-sm font-semibold text-white">{formatPaise(p.amount)}</p>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[p.status] || 'bg-slate-700 text-slate-300'}`}>{p.status}</span>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
            </motion.div>
          )}
        </motion.div>
      </div>
    </div>
  );
}
