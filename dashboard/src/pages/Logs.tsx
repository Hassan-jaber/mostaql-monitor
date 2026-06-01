import React, { useEffect, useState, useCallback } from 'react';
import { Trash2, RefreshCw } from 'lucide-react';
import { logsApi } from '../utils/api';
import { formatDistanceToNow } from 'date-fns';
import { ar } from 'date-fns/locale';

interface LogEntry {
  id: number;
  level: string;
  category: string;
  message: string;
  metadata: string | null;
  created_at: string;
}

const LEVEL_COLORS: Record<string, string> = {
  info: 'text-blue-400 bg-blue-900/20',
  error: 'text-red-400 bg-red-900/20',
  warn: 'text-yellow-400 bg-yellow-900/20',
  debug: 'text-gray-500 bg-surface-700',
};

const CATEGORY_COLORS: Record<string, string> = {
  monitoring: 'text-brand-400',
  scraping: 'text-purple-400',
  ai: 'text-cyan-400',
  notification: 'text-orange-400',
  matching: 'text-lime-400',
};

export default function Logs() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [category, setCategory] = useState('');
  const [level, setLevel] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string | number> = { page, limit: 50 };
      if (category) params.category = category;
      if (level) params.level = level;
      const r = await logsApi.list(params);
      setLogs(r.data);
      setTotal(r.total);
    } finally {
      setLoading(false);
    }
  }, [category, level, page]);

  useEffect(() => { load(); }, [load]);

  const clearOld = async () => {
    await logsApi.clear();
    load();
  };

  return (
    <div className="space-y-4 animate-slide-up">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="font-display text-2xl font-bold text-white">السجلات</h1>
          <span className="badge bg-surface-600 text-gray-400">{total}</span>
        </div>
        <div className="flex gap-2">
          <button onClick={load} className="btn-ghost flex items-center gap-2">
            <RefreshCw size={13} />
          </button>
          <button onClick={clearOld} className="btn-ghost flex items-center gap-2 text-red-400 hover:text-red-300">
            <Trash2 size={13} />
            حذف القديمة
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-2">
        <select className="input w-40" value={category} onChange={e => { setCategory(e.target.value); setPage(1); }}>
          <option value="">كل الفئات</option>
          <option value="monitoring">monitoring</option>
          <option value="scraping">scraping</option>
          <option value="ai">ai</option>
          <option value="notification">notification</option>
          <option value="matching">matching</option>
        </select>
        <select className="input w-32" value={level} onChange={e => { setLevel(e.target.value); setPage(1); }}>
          <option value="">كل المستويات</option>
          <option value="info">info</option>
          <option value="error">error</option>
          <option value="warn">warn</option>
          <option value="debug">debug</option>
        </select>
      </div>

      {/* Log entries */}
      <div className="space-y-1.5 font-mono text-xs">
        {loading && <div className="text-gray-600 text-center py-10">جاري التحميل...</div>}
        {!loading && logs.length === 0 && (
          <div className="text-gray-600 text-center py-10">لا توجد سجلات</div>
        )}
        {!loading && logs.map(log => (
          <div key={log.id} className="flex items-start gap-3 p-3 bg-surface-800 border border-surface-600 rounded-lg hover:border-surface-500 transition-colors">
            <span className={`badge shrink-0 ${LEVEL_COLORS[log.level] || 'text-gray-400'}`}>
              {log.level}
            </span>
            <span className={`shrink-0 ${CATEGORY_COLORS[log.category] || 'text-gray-500'}`}>
              [{log.category}]
            </span>
            <span className="text-gray-300 flex-1 break-all">{log.message}</span>
            <span className="text-gray-600 shrink-0 text-[10px]">
              {formatDistanceToNow(new Date(log.created_at), { addSuffix: true, locale: ar })}
            </span>
          </div>
        ))}
      </div>

      {/* Simple pagination */}
      {total > 50 && (
        <div className="flex gap-2 justify-center">
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
            className="btn-ghost disabled:opacity-30"
          >السابق</button>
          <span className="text-gray-500 text-sm py-2">{page}</span>
          <button
            onClick={() => setPage(p => p + 1)}
            disabled={page * 50 >= total}
            className="btn-ghost disabled:opacity-30"
          >التالي</button>
        </div>
      )}
    </div>
  );
}
