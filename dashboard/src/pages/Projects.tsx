import React, { useEffect, useState, useCallback } from 'react';
import { Search, ExternalLink, ChevronLeft, ChevronRight, Filter, Copy, Check } from 'lucide-react';
import { projectsApi, Project, PaginatedResponse } from '../utils/api';
import { formatDistanceToNow } from 'date-fns';
import { ar } from 'date-fns/locale';

export default function Projects() {
  const [data, setData] = useState<PaginatedResponse<Project> | null>(null);
  const [search, setSearch] = useState('');
  const [classification, setClassification] = useState('');
  const [minScore, setMinScore] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Project | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string | number> = { page, limit: 15 };
      if (search) params.search = search;
      if (classification) params.classification = classification;
      if (minScore) params.minScore = parseInt(minScore);
      const result = await projectsApi.list(params);
      setData(result);
    } finally {
      setLoading(false);
    }
  }, [search, classification, minScore, page]);

  useEffect(() => { load(); }, [load]);

  const copy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div className="flex gap-4 h-[calc(100vh-48px)]">
      {/* List panel */}
      <div className="flex-1 flex flex-col space-y-4 min-w-0">
        <div className="flex items-center gap-3">
          <h1 className="font-display text-2xl font-bold text-white">المشاريع</h1>
          {data && <span className="badge bg-surface-600 text-gray-400">{data.total}</span>}
        </div>

        {/* Filters */}
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500" />
            <input
              className="input w-full pr-8"
              placeholder="البحث في المشاريع..."
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(1); }}
            />
          </div>
          <select
            className="input w-36"
            value={classification}
            onChange={e => { setClassification(e.target.value); setPage(1); }}
          >
            <option value="">كل التصنيفات</option>
            <option value="Excellent">ممتاز</option>
            <option value="Good">جيد</option>
            <option value="Average">متوسط</option>
            <option value="Ignore">تجاهل</option>
          </select>
          <input
            className="input w-28"
            placeholder="حد الدرجة"
            type="number"
            min="0"
            max="100"
            value={minScore}
            onChange={e => { setMinScore(e.target.value); setPage(1); }}
          />
        </div>

        {/* Project list */}
        <div className="flex-1 overflow-y-auto space-y-2 pb-4">
          {loading && <div className="text-center text-gray-600 py-10">جاري التحميل...</div>}
          {!loading && data?.data.length === 0 && (
            <div className="text-center text-gray-600 py-10">لا توجد مشاريع</div>
          )}
          {!loading && data?.data.map(p => (
            <button
              key={p.id}
              onClick={() => setSelected(p)}
              className={`w-full text-right p-4 rounded-xl border transition-all ${
                selected?.id === p.id
                  ? 'border-brand-500/50 bg-surface-700'
                  : 'border-surface-600 bg-surface-800 hover:border-surface-500 hover:bg-surface-700'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-200 truncate">{p.title}</div>
                  <div className="flex items-center gap-2 mt-1.5">
                    <span className="text-xs text-gray-500 font-mono">{p.budget}</span>
                    <span className="text-gray-700">·</span>
                    <span className="text-xs text-gray-600">
                      {formatDistanceToNow(new Date(p.created_at), { addSuffix: true, locale: ar })}
                    </span>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1.5 shrink-0">
                  <span className={`text-lg font-bold font-mono leading-none ${getScoreColor(p.score)}`}>
                    {p.score}
                  </span>
                  <ClassificationBadge c={p.classification} />
                </div>
              </div>
            </button>
          ))}
        </div>

        {/* Pagination */}
        {data && data.totalPages > 1 && (
          <div className="flex items-center justify-between pt-2">
            <span className="text-xs text-gray-500">
              {((page - 1) * 15) + 1}–{Math.min(page * 15, data.total)} من {data.total}
            </span>
            <div className="flex gap-1">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="btn-ghost p-1.5 disabled:opacity-30"
              >
                <ChevronRight size={14} />
              </button>
              <button
                onClick={() => setPage(p => Math.min(data.totalPages, p + 1))}
                disabled={page === data.totalPages}
                className="btn-ghost p-1.5 disabled:opacity-30"
              >
                <ChevronLeft size={14} />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Detail panel */}
      <div className="w-96 shrink-0 overflow-y-auto">
        {selected ? (
          <div className="space-y-4 animate-slide-up">
            <div className="card">
              <div className="flex items-start justify-between gap-2 mb-3">
                <h2 className="text-sm font-semibold text-white leading-snug">{selected.title}</h2>
                <a href={selected.url} target="_blank" rel="noopener" className="text-brand-400 hover:text-brand-300 shrink-0">
                  <ExternalLink size={14} />
                </a>
              </div>

              <div className="flex items-center gap-3 mb-4">
                <span className={`text-3xl font-display font-bold ${getScoreColor(selected.score)}`}>
                  {selected.score}
                </span>
                <div>
                  <ClassificationBadge c={selected.classification} />
                  <div className="text-xs text-gray-500 mt-1 font-mono">{selected.budget}</div>
                </div>
              </div>

              <div className="space-y-2 text-xs text-gray-400">
                <div><span className="text-gray-600">السبب: </span>{selected.reason}</div>
                {selected.estimated_duration && (
                  <div><span className="text-gray-600">المدة: </span>{selected.estimated_duration}</div>
                )}
                {selected.recommended_bid && (
                  <div><span className="text-gray-600">العرض: </span>{selected.recommended_bid}</div>
                )}
              </div>

              {selected.summary && (
                <div className="mt-3 p-3 bg-surface-700 rounded-lg text-xs text-gray-400 leading-relaxed">
                  {selected.summary}
                </div>
              )}
            </div>

            {selected.proposal && (
              <div className="card">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-xs font-semibold text-gray-300">العرض المقترح</h3>
                  <button onClick={() => copy(selected.proposal, 'proposal')} className="btn-ghost py-1 px-2 text-xs flex items-center gap-1">
                    {copied === 'proposal' ? <Check size={12} className="text-brand-400" /> : <Copy size={12} />}
                    نسخ
                  </button>
                </div>
                <p className="text-xs text-gray-400 leading-relaxed whitespace-pre-wrap">{selected.proposal}</p>
              </div>
            )}

            {selected.claude_prompt && (
              <div className="card">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-xs font-semibold text-gray-300">Claude Deep Analysis</h3>
                  <button onClick={() => copy(selected.claude_prompt, 'claude')} className="btn-ghost py-1 px-2 text-xs flex items-center gap-1">
                    {copied === 'claude' ? <Check size={12} className="text-brand-400" /> : <Copy size={12} />}
                    نسخ
                  </button>
                </div>
                <p className="text-xs text-gray-400 leading-relaxed whitespace-pre-wrap">{selected.claude_prompt}</p>
              </div>
            )}
          </div>
        ) : (
          <div className="h-full flex items-center justify-center">
            <div className="text-center text-gray-700">
              <Filter size={32} className="mx-auto mb-2 opacity-30" />
              <p className="text-sm">اختر مشروعاً لعرض التفاصيل</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ClassificationBadge({ c }: { c: string }) {
  const map: Record<string, string> = {
    Excellent: 'badge-excellent', Good: 'badge-good', Average: 'badge-average', Ignore: 'badge-ignore',
  };
  const labels: Record<string, string> = {
    Excellent: 'ممتاز', Good: 'جيد', Average: 'متوسط', Ignore: 'تجاهل',
  };
  return <span className={map[c] || 'badge-ignore'}>{labels[c] || c}</span>;
}

function getScoreColor(score: number) {
  if (score >= 80) return 'score-excellent';
  if (score >= 60) return 'score-good';
  if (score >= 40) return 'score-average';
  return 'score-ignore';
}
