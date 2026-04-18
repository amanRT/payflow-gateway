import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import api, { formatDate, STATUS_COLORS } from '../lib/api';
import { usePolling } from '../hooks/usePolling';

interface Delivery {
  id: string; payment_id: string; event_type: string; status: string;
  attempt_count: number; response_status_code: number | null;
  response_body: string | null; last_attempted_at: string | null;
  created_at: string; ai_diagnosis: string | null;
}

const Skeleton = ({ className }: { className?: string }) => <div className={`skeleton rounded ${className}`} />;
const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.03 } } };
const row = { hidden: { opacity: 0, y: 6 }, show: { opacity: 1, y: 0, transition: { duration: 0.18 } } };

export default function Webhooks() {
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [testLoading, setTestLoading] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const limit = 20;

  function load(p = page) {
    setLoading(true);
    api.get(`/webhooks?page=${p}&limit=${limit}`)
      .then(({ data }) => { setDeliveries(data.deliveries); setTotal(data.total); })
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, [page]);
  usePolling(() => load(), 5000);

  async function retry(id: string) {
    setRetrying(id);
    try { await api.post(`/webhooks/${id}/retry`); load(); }
    finally { setRetrying(null); }
  }

  async function sendTest() {
    setTestLoading(true); setTestResult(null);
    try {
      const { data } = await api.post('/webhooks/test');
      setTestResult({ success: data.success, message: data.message });
    } catch (err: any) {
      setTestResult({ success: false, message: err.response?.data?.error?.message || 'Failed' });
    } finally {
      setTestLoading(false);
      setTimeout(() => setTestResult(null), 4000);
    }
  }

  function toggle(id: string) {
    setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="p-8 w-full">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-white">Webhooks</h1>
          <p className="text-slate-500 text-sm mt-0.5">Delivery logs and retry history</p>
        </div>
        <div className="flex items-center gap-3">
          <AnimatePresence>
            {testResult && (
              <motion.span initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 10 }}
                className={`text-sm px-4 py-2 rounded-xl border ${testResult.success
                  ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                  : 'bg-red-500/10 text-red-400 border-red-500/20'}`}>
                {testResult.message}
              </motion.span>
            )}
          </AnimatePresence>
          <motion.button onClick={sendTest} disabled={testLoading} whileTap={{ scale: 0.97 }}
            className="bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors flex items-center gap-2">
            {testLoading
              ? <><svg className="animate-spin w-3.5 h-3.5" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>Sending...</>
              : <><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/></svg>Send Test</>}
          </motion.button>
        </div>
      </div>

      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}
        className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-800">
              {['Payment', 'Event', 'Status', 'Attempts', 'HTTP', 'Last Try', ''].map(h => (
                <th key={h} className="text-left px-5 py-3.5 text-xs font-semibold text-slate-500 uppercase tracking-wide">{h}</th>
              ))}
            </tr>
          </thead>
          <motion.tbody variants={stagger} initial="hidden" animate={loading ? 'hidden' : 'show'}>
            {loading ? (
              [...Array(5)].map((_, i) => (
                <tr key={i} className="border-t border-slate-800/50">
                  {[28, 24, 16, 12, 12, 20, 10].map((w, j) => (
                    <td key={j} className="px-5 py-3.5"><Skeleton className={`h-4 w-${w}`} /></td>
                  ))}
                </tr>
              ))
            ) : deliveries.length === 0 ? (
              <tr><td colSpan={7} className="px-5 py-16 text-center">
                <div className="flex flex-col items-center gap-2 text-slate-600">
                  <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>
                  <p className="text-sm">No webhook deliveries yet</p>
                </div>
              </td></tr>
            ) : deliveries.map(d => (
              <>
                <motion.tr key={d.id} variants={row} className="border-t border-slate-800/50 hover:bg-slate-800/30 transition-colors group">
                  <td className="px-5 py-3.5 font-mono text-xs text-slate-500 group-hover:text-blue-400 transition-colors">{d.payment_id}</td>
                  <td className="px-5 py-3.5">
                    <span className="bg-violet-500/10 text-violet-400 border border-violet-500/20 text-xs px-2.5 py-1 rounded-full font-medium">{d.event_type}</span>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${STATUS_COLORS[d.status] || 'bg-slate-700 text-slate-300'}`}>{d.status}</span>
                  </td>
                  <td className="px-5 py-3.5 text-slate-400 font-medium">{d.attempt_count}</td>
                  <td className="px-5 py-3.5">
                    {d.response_status_code
                      ? <span className={`text-xs font-mono font-semibold ${d.response_status_code < 300 ? 'text-emerald-400' : 'text-red-400'}`}>{d.response_status_code}</span>
                      : <span className="text-slate-700 text-xs">—</span>}
                  </td>
                  <td className="px-5 py-3.5 text-slate-500 whitespace-nowrap text-xs">
                    {d.last_attempted_at ? formatDate(d.last_attempted_at) : <span className="text-slate-700">—</span>}
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-2">
                      {d.status === 'failed' && (
                        <motion.button onClick={() => retry(d.id)} disabled={retrying === d.id} whileTap={{ scale: 0.95 }}
                          className="text-xs text-blue-400 hover:text-blue-300 font-semibold disabled:opacity-40 transition-colors">
                          {retrying === d.id
                            ? <svg className="animate-spin w-3.5 h-3.5" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                            : 'Retry'}
                        </motion.button>
                      )}
                      {d.status === 'failed' && d.ai_diagnosis && (
                        <motion.button onClick={() => toggle(d.id)} whileTap={{ scale: 0.95 }}
                          className="text-xs text-violet-400 hover:text-violet-300 font-semibold transition-colors flex items-center gap-1">
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
                          {expanded.has(d.id) ? 'Hide' : 'AI'}
                        </motion.button>
                      )}
                    </div>
                  </td>
                </motion.tr>

                {d.status === 'failed' && d.ai_diagnosis && (
                  <AnimatePresence>
                    {expanded.has(d.id) && (
                      <motion.tr key={`${d.id}-diag`}
                        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                        transition={{ duration: 0.18 }}>
                        <td colSpan={7} className="px-5 py-0 bg-violet-500/5 border-t border-violet-500/10">
                          <motion.div initial={{ y: -8, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -8, opacity: 0 }}
                            className="py-3.5 flex items-start gap-3">
                            <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center flex-shrink-0 mt-0.5">
                              <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
                            </div>
                            <div>
                              <p className="text-xs font-semibold text-violet-400 mb-1">AI Diagnosis</p>
                              <p className="text-xs text-slate-400 leading-relaxed max-w-3xl">{d.ai_diagnosis}</p>
                            </div>
                          </motion.div>
                        </td>
                      </motion.tr>
                    )}
                  </AnimatePresence>
                )}
              </>
            ))}
          </motion.tbody>
        </table>

        {totalPages > 1 && (
          <div className="flex items-center justify-between px-5 py-3.5 border-t border-slate-800 bg-slate-900/50">
            <p className="text-sm text-slate-500">Page {page} of {totalPages}</p>
            <div className="flex gap-2">
              {[{ l: '← Prev', fn: () => setPage(p => Math.max(1, p-1)), d: page===1 },
                { l: 'Next →', fn: () => setPage(p => Math.min(totalPages, p+1)), d: page===totalPages }
              ].map(({ l, fn, d }) => (
                <motion.button key={l} onClick={fn} disabled={d} whileTap={{ scale: 0.97 }}
                  className="px-3.5 py-1.5 text-sm border border-slate-700 rounded-xl disabled:opacity-30 hover:bg-slate-800 text-slate-400 transition-colors">{l}
                </motion.button>
              ))}
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
}
