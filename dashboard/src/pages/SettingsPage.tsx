import React, { useEffect, useState } from 'react';
import { Save, TestTube, Play, Pause, Zap, CheckCircle, XCircle } from 'lucide-react';
import { settingsApi } from '../utils/api';

export default function SettingsPage() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    settingsApi.get().then(s => { setSettings(s); setLoading(false); });
  }, []);

  const update = (key: string, value: string) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  const save = async () => {
    setSaving(true);
    try {
      await settingsApi.update(settings);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  const testTelegram = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await settingsApi.testTelegram();
      setTestResult({ success: r.success, message: r.success ? 'اتصال ناجح!' : r.error || 'فشل الاتصال' });
    } catch (e: unknown) {
      setTestResult({ success: false, message: 'فشل الاتصال' });
    } finally {
      setTesting(false);
    }
  };

  const runCheck = async () => {
    await settingsApi.runCheck();
    alert('تم بدء فحص يدوي');
  };

  const toggleMonitoring = async () => {
    const current = settings.monitoring_active === 'true';
    await settingsApi.toggleMonitoring(!current);
    update('monitoring_active', (!current).toString());
  };

  if (loading) return <div className="text-gray-600 text-center py-20">جاري التحميل...</div>;

  const isActive = settings.monitoring_active === 'true';

  return (
    <div className="max-w-2xl space-y-6 animate-slide-up">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-2xl font-bold text-white">الإعدادات</h1>
        <div className="flex gap-2">
          <button
            onClick={toggleMonitoring}
            className={`btn-ghost flex items-center gap-2 ${isActive ? 'text-red-400 hover:text-red-300' : 'text-brand-400 hover:text-brand-300'}`}
          >
            {isActive ? <Pause size={14} /> : <Play size={14} />}
            {isActive ? 'إيقاف المراقبة' : 'تشغيل المراقبة'}
          </button>
          <button onClick={runCheck} className="btn-ghost flex items-center gap-2">
            <Zap size={14} />
            فحص يدوي
          </button>
          <button onClick={save} disabled={saving} className="btn-primary flex items-center gap-2">
            <Save size={14} />
            {saved ? 'تم الحفظ ✓' : saving ? 'جاري الحفظ...' : 'حفظ'}
          </button>
        </div>
      </div>

      {/* Telegram settings */}
      <div className="card space-y-4">
        <h2 className="text-sm font-semibold text-brand-400 uppercase tracking-wider font-mono">Telegram</h2>
        <div>
          <label className="text-xs text-gray-500 mb-1 block">Bot Token</label>
          <input
            className="input w-full"
            type="password"
            placeholder="123456:ABC-DEF..."
            value={settings.telegram_bot_token || ''}
            onChange={e => update('telegram_bot_token', e.target.value)}
          />
        </div>
        <div>
          <label className="text-xs text-gray-500 mb-1 block">Chat ID</label>
          <input
            className="input w-full"
            placeholder="-100123456789"
            value={settings.telegram_chat_id || ''}
            onChange={e => update('telegram_chat_id', e.target.value)}
          />
        </div>
        <div className="flex items-center gap-3">
          <button onClick={testTelegram} disabled={testing} className="btn-ghost flex items-center gap-2">
            <TestTube size={14} />
            {testing ? 'جاري الاختبار...' : 'اختبار الاتصال'}
          </button>
          {testResult && (
            <span className={`flex items-center gap-1 text-sm ${testResult.success ? 'text-green-400' : 'text-red-400'}`}>
              {testResult.success ? <CheckCircle size={14} /> : <XCircle size={14} />}
              {testResult.message}
            </span>
          )}
        </div>
      </div>

      {/* AI settings */}
      <div className="card space-y-4">
        <h2 className="text-sm font-semibold text-brand-400 uppercase tracking-wider font-mono">AI Provider</h2>
        <div>
          <label className="text-xs text-gray-500 mb-1 block">المزود</label>
          <select
            className="input w-full"
            value={settings.ai_provider || 'claude'}
            onChange={e => update('ai_provider', e.target.value)}
          >
            <option value="claude">Claude (Anthropic)</option>
            <option value="openai">OpenAI</option>
            <option value="gemini">Google Gemini</option>
            <option value="openrouter">OpenRouter</option>
          </select>
        </div>
        <div>
          <label className="text-xs text-gray-500 mb-1 block">النموذج</label>
          <input
            className="input w-full"
            placeholder="claude-haiku-4-5-20251001"
            value={settings.ai_model || ''}
            onChange={e => update('ai_model', e.target.value)}
          />
        </div>
      </div>

      {/* Monitoring settings */}
      <div className="card space-y-4">
        <h2 className="text-sm font-semibold text-brand-400 uppercase tracking-wider font-mono">المراقبة</h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs text-gray-500 mb-1 block">فترة الفحص (ثانية)</label>
            <input
              className="input w-full"
              type="number"
              min="30"
              max="3600"
              value={settings.check_interval || '60'}
              onChange={e => update('check_interval', e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">الحد الأدنى للدرجة</label>
            <input
              className="input w-full"
              type="number"
              min="0"
              max="100"
              value={settings.min_score || '50'}
              onChange={e => update('min_score', e.target.value)}
            />
          </div>
        </div>

        <div className="flex items-center justify-between p-3 bg-surface-700 rounded-lg">
          <span className="text-sm text-gray-300">حالة المراقبة</span>
          <div className={`flex items-center gap-2 text-sm font-medium ${isActive ? 'text-brand-400' : 'text-gray-500'}`}>
            <div className={`w-2 h-2 rounded-full ${isActive ? 'bg-brand-400 animate-pulse' : 'bg-gray-600'}`} />
            {isActive ? 'نشطة' : 'متوقفة'}
          </div>
        </div>
      </div>
    </div>
  );
}
