import { useEffect, useState, FormEvent, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import api, { formatPaise, formatDate, STATUS_COLORS } from '../lib/api';
import { usePolling } from '../hooks/usePolling';

interface Payment {
  id: string; amount: number; currency: string; status: string;
  description: string | null; idempotency_key: string;
  failure_reason: string | null; created_at: string;
  risk_score: number; risk_reason: string | null; risk_action: string;
}

type FraudResult =
  | { type: 'blocked'; reason: string }
  | { type: 'created'; payment: Payment }

const STATUSES = ['', 'created', 'authorized', 'captured', 'failed', 'blocked', 'refunded'];

function useClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

const RISK: Record<string, { bg: string; text: string; dot: string; border: string }> = {
  allow:  { bg: 'bg-emerald-500/10', text: 'text-emerald-400', dot: 'bg-emerald-400', border: 'border-emerald-500/20' },
  review: { bg: 'bg-amber-500/10',   text: 'text-amber-400',   dot: 'bg-amber-400',   border: 'border-amber-500/20'   },
  block:  { bg: 'bg-red-500/10',     text: 'text-red-400',     dot: 'bg-red-500',     border: 'border-red-500/20'     },
};

const Skeleton = ({ className }: { className?: string }) => <div className={`skeleton rounded ${className}`} />;
const inputCls = 'bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all';

function CreatePaymentPanel({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<FraudResult | null>(null);
  const idempKey = useRef(`ui-${Date.now()}`);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) return;
    setLoading(true);
    setResult(null);
    idempKey.current = `ui-${Date.now()}`;
    try {
      const { data } = await api.post('/payments', {
        amount: Math.round(Number(amount) * 100),
        description: description || undefined,
      }, { headers: { 'X-Idempotency-Key': idempKey.current } });
      setResult({ type: 'created', payment: data.payment });
      onCreated();
    } catch (err: any) {
      const msg = err.response?.data?.error?.message || 'Something went wrong';
      const code = err.response?.data?.error?.code;
      if (code === 'PAYMENT_BLOCKED') {
        setResult({ type: 'blocked', reason: msg });
        onCreated(); // refresh list so blocked payment appears
      } else {
        setResult({ type: 'blocked', reason: msg });
      }
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setResult(null);
    setAmount('');
    setDescription('');
  }

  const rStyle = result?.type === 'created'
    ? RISK[result.payment.risk_action] ?? RISK.allow
    : null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 16 }}
        transition={{ duration: 0.22, ease: 'easeOut' }}
        onClick={e => e.stopPropagation()}
        className="relative w-full max-w-md bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center">
              <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
              </svg>
            </div>
            <div>
              <h2 className="text-sm font-semibold text-white">Create Payment</h2>
              <p className="text-xs text-slate-500">AI fraud scan runs automatically</p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300 transition-colors text-xl leading-none">&times;</button>
        </div>

        <div className="px-6 py-5">
          <AnimatePresence mode="wait">
            {/* Form */}
            {!result && (
              <motion.form key="form" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                onSubmit={submit} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1.5">Amount (₹ rupees)</label>
                  <div className="relative">
                    <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500 text-sm font-medium">₹</span>
                    <input
                      type="number" min="1" step="0.01" value={amount}
                      onChange={e => setAmount(e.target.value)} required
                      placeholder="500.00"
                      className={`${inputCls} pl-7 w-full`}
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1.5">Description <span className="text-slate-600">(optional)</span></label>
                  <input type="text" value={description} onChange={e => setDescription(e.target.value)}
                    placeholder="Order payment, subscription..."
                    className={`${inputCls} w-full`} />
                </div>

                {/* AI hint */}
                <div className="flex items-start gap-2.5 bg-violet-500/8 border border-violet-500/15 rounded-xl px-3.5 py-3">
                  <svg className="w-3.5 h-3.5 text-violet-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                  <p className="text-xs text-slate-400">Claude AI will analyze this payment for fraud before processing. High-risk payments will be <span className="text-amber-400">flagged</span> or <span className="text-red-400">blocked</span>.</p>
                </div>

                <motion.button type="submit" disabled={loading || !amount} whileTap={{ scale: 0.97 }}
                  className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 disabled:opacity-40 text-white py-2.5 rounded-xl text-sm font-semibold transition-all flex items-center justify-center gap-2">
                  {loading ? (
                    <><svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>AI scanning...</>
                  ) : 'Create Payment'}
                </motion.button>
              </motion.form>
            )}

            {/* Blocked Result */}
            {result?.type === 'blocked' && (
              <motion.div key="blocked" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
                className="space-y-4">
                <div className="flex items-center gap-3 bg-red-500/10 border border-red-500/20 rounded-2xl px-5 py-4">
                  <div className="w-10 h-10 rounded-xl bg-red-500/20 flex items-center justify-center flex-shrink-0">
                    <svg className="w-5 h-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-red-400">Payment Blocked</p>
                    <p className="text-xs text-slate-500 mt-0.5">AI fraud detection triggered</p>
                  </div>
                </div>

                <div className="bg-slate-800/60 border border-slate-700 rounded-xl px-4 py-3">
                  <p className="text-xs font-semibold text-slate-400 mb-2 flex items-center gap-1.5">
                    <svg className="w-3.5 h-3.5 text-violet-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 10V3L4 14h7v7l9-11h-7z"/>
                    </svg>
                    Claude AI Reasoning
                  </p>
                  <p className="text-sm text-slate-300 leading-relaxed">{result.reason}</p>
                </div>

                <div className="flex gap-2">
                  <motion.button onClick={reset} whileTap={{ scale: 0.97 }}
                    className="flex-1 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 py-2.5 rounded-xl text-sm font-medium transition-colors">
                    Try Again
                  </motion.button>
                  <motion.button onClick={onClose} whileTap={{ scale: 0.97 }}
                    className="flex-1 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 py-2.5 rounded-xl text-sm font-medium transition-colors">
                    Close
                  </motion.button>
                </div>
              </motion.div>
            )}

            {/* Success Result */}
            {result?.type === 'created' && rStyle && (
              <motion.div key="success" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
                className="space-y-4">
                {/* Status banner */}
                <div className={`flex items-center gap-3 ${rStyle.bg} border ${rStyle.border} rounded-2xl px-5 py-4`}>
                  <div className={`w-10 h-10 rounded-xl ${rStyle.bg} border ${rStyle.border} flex items-center justify-center flex-shrink-0`}>
                    {result.payment.risk_action === 'allow' ? (
                      <svg className={`w-5 h-5 ${rStyle.text}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
                      </svg>
                    ) : (
                      <svg className={`w-5 h-5 ${rStyle.text}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
                      </svg>
                    )}
                  </div>
                  <div>
                    <p className={`text-sm font-semibold ${rStyle.text}`}>
                      {result.payment.risk_action === 'allow' ? 'Payment Created' : 'Created — Under Review'}
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5 font-mono">{result.payment.id}</p>
                  </div>
                </div>

                {/* AI Risk Assessment */}
                <div className="bg-slate-800/60 border border-slate-700 rounded-xl px-4 py-3 space-y-2.5">
                  <p className="text-xs font-semibold text-slate-400 flex items-center gap-1.5">
                    <svg className="w-3.5 h-3.5 text-violet-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 10V3L4 14h7v7l9-11h-7z"/>
                    </svg>
                    AI Risk Assessment
                  </p>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-500">Risk Score</span>
                    <div className="flex items-center gap-2">
                      <div className="w-24 h-1.5 bg-slate-700 rounded-full overflow-hidden">
                        <motion.div
                          initial={{ width: 0 }}
                          animate={{ width: `${result.payment.risk_score}%` }}
                          transition={{ duration: 0.8, ease: 'easeOut', delay: 0.2 }}
                          className={`h-full rounded-full ${
                            result.payment.risk_score < 40 ? 'bg-emerald-500' :
                            result.payment.risk_score < 70 ? 'bg-amber-500' : 'bg-red-500'
                          }`}
                        />
                      </div>
                      <span className={`text-xs font-bold ${rStyle.text}`}>{result.payment.risk_score}/100</span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-500">Action</span>
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${rStyle.bg} ${rStyle.text}`}>
                      {result.payment.risk_action}
                    </span>
                  </div>
                  {result.payment.risk_reason && (
                    <div>
                      <span className="text-xs text-slate-500 block mb-1">Reasoning</span>
                      <p className="text-xs text-slate-300 leading-relaxed">{result.payment.risk_reason}</p>
                    </div>
                  )}
                </div>

                {/* Payment details */}
                <div className="grid grid-cols-2 gap-2">
                  {[
                    ['Amount', formatPaise(result.payment.amount)],
                    ['Status', result.payment.status],
                  ].map(([k, v]) => (
                    <div key={k} className="bg-slate-800/40 rounded-xl px-3 py-2.5">
                      <p className="text-xs text-slate-500 mb-0.5">{k}</p>
                      <p className="text-sm font-semibold text-white">{v}</p>
                    </div>
                  ))}
                </div>

                <div className="flex gap-2">
                  <motion.button onClick={reset} whileTap={{ scale: 0.97 }}
                    className="flex-1 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 py-2.5 rounded-xl text-sm font-medium transition-colors">
                    New Payment
                  </motion.button>
                  <motion.button onClick={onClose} whileTap={{ scale: 0.97 }}
                    className="flex-1 bg-blue-600 hover:bg-blue-500 text-white py-2.5 rounded-xl text-sm font-medium transition-colors">
                    Done
                  </motion.button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </motion.div>
  );
}

export default function Payments() {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const limit = 20;
  const [filters, setFilters] = useState({ status: '', from: '', to: '' });
  const [applied, setApplied] = useState({ status: '', from: '', to: '' });
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const [nlQuery, setNlQuery] = useState('');
  const [nlLoading, setNlLoading] = useState(false);
  const [nlError, setNlError] = useState('');
  const [nlApplied, setNlApplied] = useState(false);
  const [nlDesc, setNlDesc] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [, setLastUpdated] = useState<Date | null>(null);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  const prevIds = useRef<Set<string>>(new Set());
  const [showCreate, setShowCreate] = useState(false);

  function buildParams() {
    const p = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (applied.status) p.set('status', applied.status);
    if (applied.from) p.set('from', applied.from);
    if (applied.to) p.set('to', applied.to);
    return p;
  }

  async function fetchPayments(isInitial = false) {
    if (nlApplied) return;
    if (isInitial) setLoading(true);
    try {
      const { data } = await api.get(`/payments?${buildParams()}`);
      const incoming: Payment[] = data.payments;
      if (!isInitial) {
        const inIds = new Set(incoming.map(x => x.id));
        const added = new Set([...inIds].filter(id => !prevIds.current.has(id)));
        if (added.size > 0) { setNewIds(added); setTimeout(() => setNewIds(new Set()), 3000); }
        prevIds.current = inIds;
      } else {
        prevIds.current = new Set(incoming.map(x => x.id));
      }
      setPayments(incoming); setTotal(data.total); setLastUpdated(new Date());
      setFetchError(false);
    } catch (err: any) {
      if (isInitial) setFetchError(true);
    } finally { if (isInitial) setLoading(false); }
  }

  useEffect(() => { fetchPayments(true); }, [page, applied]);
  usePolling(() => fetchPayments(false), 5000, !nlApplied);

  function applyFilters(e: FormEvent) {
    e.preventDefault(); setPage(1); setNlApplied(false); setNlQuery(''); setApplied({ ...filters });
  }

  function clearAll() {
    const empty = { status: '', from: '', to: '' };
    setFilters(empty); setApplied(empty); setNlQuery(''); setNlApplied(false); setNlError(''); setNlDesc(''); setPage(1);
  }

  async function runNl(e: FormEvent) {
    e.preventDefault();
    if (!nlQuery.trim()) return;
    setNlLoading(true); setNlError('');
    try {
      const { data } = await api.post('/analytics/nl-query', { q: nlQuery.trim() });
      setPayments(data.payments); setTotal(data.total); setNlApplied(true);
      const f = data.filters as any;
      const parts = [f.status && `status: ${f.status}`, f.from && `from: ${f.from}`, f.to && `to: ${f.to}`].filter(Boolean);
      setNlDesc(parts.join(' · ') || 'all payments');
    } catch { setNlError('AI query failed — use manual filters.'); }
    finally { setNlLoading(false); }
  }

  const totalPages = Math.ceil(total / limit);
  const clock = useClock();
  const timeStr = clock.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });

  return (
    <div className="p-8 w-full">
      {/* Create Payment Modal */}
      <AnimatePresence>
        {showCreate && (
          <CreatePaymentPanel
            onClose={() => setShowCreate(false)}
            onCreated={() => { setTimeout(() => fetchPayments(false), 500); }}
          />
        )}
      </AnimatePresence>

      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-white">Payments</h1>
          <p className="text-slate-500 text-sm mt-0.5">{total.toLocaleString()} total transactions</p>
        </div>
        <div className="flex items-center gap-3">
          {!nlApplied && (
            <div className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-emerald-500/8 border border-emerald-500/20 shadow-lg shadow-emerald-900/10">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
              </span>
              <span className="text-xs font-semibold text-emerald-400 tracking-wide uppercase">Live</span>
              <span className="w-px h-3 bg-emerald-500/30" />
              <span className="text-xs font-mono text-emerald-300/80 tabular-nums">{timeStr}</span>
            </div>
          )}
          <motion.button onClick={() => setShowCreate(true)} whileTap={{ scale: 0.97 }}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors shadow-lg shadow-blue-900/30">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4"/>
            </svg>
            New Payment
          </motion.button>
        </div>
      </div>

      {/* Filter Bar */}
      <motion.form onSubmit={applyFilters} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
        className="bg-slate-900 border border-slate-800 rounded-2xl p-4 mb-4 flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1.5">Status</label>
          <select value={filters.status} onChange={e => setFilters(f => ({ ...f, status: e.target.value }))}
            className={`${inputCls} bg-slate-800`}>
            {STATUSES.map(s => <option key={s} value={s} className="bg-slate-800">{s || 'All statuses'}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1.5">From</label>
          <input type="date" value={filters.from} onChange={e => setFilters(f => ({ ...f, from: e.target.value }))} className={inputCls} />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1.5">To</label>
          <input type="date" value={filters.to} onChange={e => setFilters(f => ({ ...f, to: e.target.value }))} className={inputCls} />
        </div>
        <motion.button type="submit" whileTap={{ scale: 0.97 }}
          className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors">
          Apply
        </motion.button>
        <button type="button" onClick={clearAll} className="text-slate-500 hover:text-slate-300 px-3 py-2 text-sm transition-colors">Clear</button>
      </motion.form>

      {/* AI Search */}
      <motion.form onSubmit={runNl} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}
        className="bg-slate-900 border border-slate-800 rounded-2xl p-4 mb-5">
        <div className="flex items-center gap-2 mb-2.5">
          <div className="w-5 h-5 rounded-md bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center">
            <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 10V3L4 14h7v7l9-11h-7z"/>
            </svg>
          </div>
          <span className="text-xs font-semibold text-slate-300">AI Search</span>
          <span className="text-xs text-slate-600">— plain English</span>
        </div>
        <div className="flex gap-2 items-start">
          <textarea ref={textareaRef} rows={2} value={nlQuery} onChange={e => setNlQuery(e.target.value)}
            placeholder='"show failed payments from last week" or "captured payments over ₹5000"'
            className="flex-1 bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-slate-100 placeholder-slate-600 resize-none focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent transition-all"
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runNl(e as any); } }}
          />
          <motion.button type="submit" disabled={nlLoading || !nlQuery.trim()} whileTap={{ scale: 0.97 }}
            className="bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 disabled:opacity-40 text-white px-4 py-2.5 rounded-xl text-sm font-medium transition-all flex items-center gap-1.5">
            {nlLoading
              ? <><svg className="animate-spin w-3.5 h-3.5" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>AI...</>
              : 'Search'}
          </motion.button>
        </div>
        <AnimatePresence>
          {nlError && <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="text-xs text-red-400 mt-1.5">{nlError}</motion.p>}
          {nlApplied && nlDesc && (
            <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-2 mt-2">
              <span className="text-xs text-violet-400 bg-violet-500/10 border border-violet-500/20 rounded-full px-2.5 py-0.5">{nlDesc}</span>
              <button type="button" onClick={clearAll} className="text-xs text-slate-500 hover:text-slate-300 underline">clear</button>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.form>

      {/* Table */}
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}
        className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-800">
              {['ID', 'Amount', 'Status', 'Risk', 'Description', 'Created'].map(h => (
                <th key={h} className="text-left px-5 py-3.5 text-xs font-semibold text-slate-500 uppercase tracking-wide">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              [...Array(6)].map((_, i) => (
                <tr key={i} className="border-t border-slate-800/50">
                  {[32, 20, 16, 16, 28, 20].map((w, j) => (
                    <td key={j} className="px-5 py-3.5"><Skeleton className={`h-4 w-${w}`} /></td>
                  ))}
                </tr>
              ))
            ) : fetchError ? (
              <tr><td colSpan={6} className="px-5 py-16 text-center">
                <div className="flex flex-col items-center gap-3">
                  <svg className="w-10 h-10 text-red-500/50" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>
                  <p className="text-sm text-red-400">Failed to load payments</p>
                  <button onClick={() => fetchPayments(true)} className="text-xs text-blue-400 hover:text-blue-300 underline">Retry</button>
                </div>
              </td></tr>
            ) : payments.length === 0 ? (
              <tr><td colSpan={6} className="px-5 py-16 text-center">
                <div className="flex flex-col items-center gap-3 text-slate-600">
                  <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>
                  <p className="text-sm">No payments yet</p>
                  <button onClick={() => setShowCreate(true)} className="text-xs text-blue-400 hover:text-blue-300 underline">Create your first payment</button>
                </div>
              </td></tr>
            ) : payments.map(p => {
              const r = RISK[p.risk_action] ?? RISK.allow;
              const isNew = newIds.has(p.id);
              return (
                <motion.tr key={p.id}
                  initial={isNew ? { y: -10, backgroundColor: 'rgba(59,130,246,0.18)' } : false}
                  animate={isNew ? { y: 0, backgroundColor: 'rgba(0,0,0,0)' } : {}}
                  transition={{ y: { duration: 0.3, ease: 'easeOut' }, backgroundColor: { duration: 2.5 } }}
                  className="border-t border-slate-800/50 hover:bg-slate-800/40 transition-colors group">
                  <td className="px-5 py-3.5 font-mono text-xs text-slate-500 group-hover:text-blue-400 transition-colors">{p.id}</td>
                  <td className="px-5 py-3.5 font-semibold text-white">{formatPaise(p.amount)}</td>
                  <td className="px-5 py-3.5">
                    <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${STATUS_COLORS[p.status] || 'bg-slate-700 text-slate-300'}`}>{p.status}</span>
                  </td>
                  <td className="px-5 py-3.5">
                    {p.risk_score > 0 || p.risk_action !== 'allow' ? (
                      <span title={p.risk_reason ?? undefined}
                        className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-medium cursor-default ${r.bg} ${r.text}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${r.dot}`} />
                        {p.risk_score} · {p.risk_action}
                      </span>
                    ) : <span className="text-slate-700 text-xs">—</span>}
                  </td>
                  <td className="px-5 py-3.5 text-slate-400 max-w-xs truncate">{p.description || <span className="text-slate-700">—</span>}</td>
                  <td className="px-5 py-3.5 text-slate-500 whitespace-nowrap text-xs">{formatDate(p.created_at)}</td>
                </motion.tr>
              );
            })}
          </tbody>
        </table>

        {totalPages > 1 && !nlApplied && (
          <div className="flex items-center justify-between px-5 py-3.5 border-t border-slate-800 bg-slate-900/50">
            <p className="text-sm text-slate-500">Page {page} of {totalPages} — {total} results</p>
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
