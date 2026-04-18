import { useState, useEffect, FormEvent } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import api from '../lib/api';

function Section({ title, subtitle, children, delay = 0 }: { title: string; subtitle?: React.ReactNode; children: React.ReactNode; delay?: number }) {
  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay, duration: 0.3 }}
      className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
      <div className="px-6 py-5 border-b border-slate-800/60">
        <h2 className="text-sm font-semibold text-white">{title}</h2>
        {subtitle && <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>}
      </div>
      <div className="px-6 py-5">{children}</div>
    </motion.div>
  );
}

const Skeleton = ({ className }: { className?: string }) => <div className={`skeleton rounded-lg ${className}`} />;

const inputCls = 'bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all w-full';

export default function Settings() {
  const [merchant, setMerchant] = useState<any>(null);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [showKey, setShowKey] = useState(false);
  const [confirmRegen, setConfirmRegen] = useState(false);

  useEffect(() => {
    api.get('/merchants/me').then(({ data }) => {
      setMerchant(data.merchant);
      setWebhookUrl(data.merchant.webhook_url || '');
      localStorage.setItem('payflow_merchant', JSON.stringify(data.merchant));
    });
  }, []);

  async function saveWebhookUrl(e: FormEvent) {
    e.preventDefault(); setSaving(true); setSaveStatus('idle');
    try {
      await api.put('/merchants/webhook-url', { webhook_url: webhookUrl || null });
      setMerchant((m: any) => ({ ...m, webhook_url: webhookUrl }));
      setSaveStatus('success');
      setTimeout(() => setSaveStatus('idle'), 3000);
    } catch { setSaveStatus('error'); }
    finally { setSaving(false); }
  }

  async function regenerateKey() {
    setRegenerating(true);
    try {
      const { data } = await api.post('/merchants/regenerate-key');
      setMerchant((m: any) => ({ ...m, api_key: data.api_key }));
      localStorage.setItem('payflow_merchant', JSON.stringify({ ...merchant, api_key: data.api_key }));
      setConfirmRegen(false);
    } finally { setRegenerating(false); }
  }

  function copyKey() {
    if (!merchant?.api_key) return;
    navigator.clipboard.writeText(merchant.api_key);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (!merchant) {
    return (
      <div className="p-8 max-w-3xl space-y-5">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
            <Skeleton className="h-4 w-32 mb-4" /><Skeleton className="h-10 w-full" />
          </div>
        ))}
      </div>
    );
  }

  const initial = (merchant.name || 'M')[0].toUpperCase();

  return (
    <div className="p-8 max-w-3xl">
      <div className="mb-7">
        <h1 className="text-xl font-bold text-white">Settings</h1>
        <p className="text-slate-500 text-sm mt-0.5">Manage your account, API keys, and webhooks</p>
      </div>

      <div className="space-y-5">
        {/* Account */}
        <Section title="Account" subtitle="Your merchant profile" delay={0.05}>
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white text-lg font-bold shadow-lg shadow-blue-900/40 flex-shrink-0">
              {initial}
            </div>
            <div className="grid grid-cols-2 gap-x-8 gap-y-2 flex-1">
              {[['Business Name', merchant.name], ['Email', merchant.email]].map(([label, val]) => (
                <div key={label}>
                  <p className="text-xs text-slate-500 font-medium mb-0.5">{label}</p>
                  <p className="text-sm font-semibold text-slate-100">{val}</p>
                </div>
              ))}
            </div>
          </div>
        </Section>

        {/* API Key */}
        <Section title="API Key" subtitle={<>Use <code className="bg-slate-800 text-blue-400 px-1.5 py-0.5 rounded-md font-mono">x-api-key</code> header for payment API calls</>} delay={0.1}>
          <div className="flex items-center gap-2 mb-4">
            <div className="flex-1 bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 font-mono text-sm text-slate-300 overflow-hidden truncate">
              {showKey ? merchant.api_key : '•'.repeat(Math.min(merchant.api_key?.length ?? 40, 40))}
            </div>
            <motion.button whileTap={{ scale: 0.95 }} onClick={() => setShowKey(v => !v)}
              className="px-3.5 py-2.5 text-sm border border-slate-700 bg-slate-800 rounded-xl hover:bg-slate-700 transition-colors text-slate-300 font-medium whitespace-nowrap">
              {showKey ? 'Hide' : 'Show'}
            </motion.button>
            <motion.button whileTap={{ scale: 0.95 }} onClick={copyKey}
              className={`px-3.5 py-2.5 text-sm border rounded-xl transition-all font-medium whitespace-nowrap ${
                copied ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' : 'border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-300'
              }`}>
              <AnimatePresence mode="wait">
                {copied ? (
                  <motion.span key="c" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} className="flex items-center gap-1">
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7"/></svg>Copied
                  </motion.span>
                ) : (
                  <motion.span key="copy" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}>Copy</motion.span>
                )}
              </AnimatePresence>
            </motion.button>
          </div>

          <div className="border-t border-slate-800 pt-4">
            <p className="text-xs text-red-400/80 mb-3">Regenerating invalidates the current key immediately. All integrations will break.</p>
            <AnimatePresence mode="wait">
              {!confirmRegen ? (
                <motion.button key="btn" onClick={() => setConfirmRegen(true)} whileTap={{ scale: 0.97 }}
                  initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                  className="bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 px-4 py-2 rounded-xl text-sm font-medium transition-colors">
                  Regenerate API Key
                </motion.button>
              ) : (
                <motion.div key="confirm" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
                  className="flex items-center gap-3 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
                  <p className="text-sm text-red-400 font-medium flex-1">Confirm? Cannot be undone.</p>
                  <button onClick={() => setConfirmRegen(false)} className="text-sm text-slate-500 hover:text-slate-300 px-3 py-1.5 rounded-lg hover:bg-slate-800 transition-colors">Cancel</button>
                  <motion.button onClick={regenerateKey} disabled={regenerating} whileTap={{ scale: 0.97 }}
                    className="bg-red-600 hover:bg-red-500 disabled:opacity-60 text-white px-3 py-1.5 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5">
                    {regenerating ? <><svg className="animate-spin w-3.5 h-3.5" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>Regenerating</> : 'Confirm'}
                  </motion.button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </Section>

        {/* Webhook */}
        <Section title="Webhook Endpoint" subtitle={<>Events posted with <code className="bg-slate-800 text-blue-400 px-1.5 py-0.5 rounded-md font-mono">X-PayFlow-Signature</code> header</>} delay={0.15}>
          <form onSubmit={saveWebhookUrl}>
            <div className="flex gap-2 mb-3">
              <input type="url" value={webhookUrl} onChange={e => setWebhookUrl(e.target.value)}
                placeholder="https://your-server.com/webhooks/payflow"
                className={inputCls} />
              <motion.button type="submit" disabled={saving} whileTap={{ scale: 0.97 }}
                className="bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors flex items-center gap-1.5 whitespace-nowrap">
                {saving ? <><svg className="animate-spin w-3.5 h-3.5" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>Saving</> : 'Save'}
              </motion.button>
            </div>
            <AnimatePresence>
              {saveStatus === 'success' && (
                <motion.p initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                  className="text-sm text-emerald-400 flex items-center gap-1.5 mb-3">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                  Saved successfully
                </motion.p>
              )}
            </AnimatePresence>
          </form>

          <div className="bg-slate-800/60 rounded-xl p-4 border border-slate-700/50">
            <p className="text-xs font-semibold text-slate-400 mb-3">Events delivered</p>
            <div className="space-y-2.5">
              {[
                { event: 'payment.captured', desc: 'Payment successfully captured' },
                { event: 'payment.failed', desc: 'Payment failed' },
                { event: 'payment.refunded', desc: 'Payment fully or partially refunded' },
              ].map(({ event, desc }) => (
                <div key={event} className="flex items-center gap-3">
                  <code className="text-violet-400 bg-violet-500/10 border border-violet-500/20 px-2 py-0.5 rounded-lg text-xs font-mono">{event}</code>
                  <span className="text-slate-500 text-xs">{desc}</span>
                </div>
              ))}
            </div>
          </div>
        </Section>
      </div>
    </div>
  );
}
