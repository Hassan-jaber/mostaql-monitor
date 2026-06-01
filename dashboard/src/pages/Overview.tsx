import React, { useEffect, useState } from 'react';
import { TrendingUp, Bell, Calendar, Zap, RefreshCw, Star } from 'lucide-react';
import { projectsApi, Stats, Project } from '../utils/api';
import { formatDistanceToNow } from 'date-fns';
import { ar } from 'date-fns/locale';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

export default function Overview() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [recentProjects, setRecentProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const [s, p] = await Promise.all([
        projectsApi.stats(),
        projectsApi.list({ limit: 5, page: 1 }),
      ]);
      setStats(s);
      setRecentProjects(p.data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  if (loading) return <LoadingSkeleton />;

  return (
    <div className="space-y-6 animate-slide-up">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold text-white">نظرة عامة</h1>
          <p className="text-gray-500 text-sm mt-1">مراقبة مشاريع Front-End على مستقل</p>
        </div>
        <button onClick={load} className="btn-ghost flex items-center gap-2">
          <RefreshCw size={14} />
          تحديث
        </button>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-4 gap-4">
        <StatCard icon={TrendingUp} label="إجمالي المشاريع" value={stats?.total || 0} color="brand" />
        <StatCard icon={Bell} label="الإشعارات المرسلة" value={stats?.sent || 0} color="blue" />
        <StatCard icon={Calendar} label="مشاريع اليوم" value={stats?.today || 0} color="purple" />
        <StatCard icon={Zap} label="متوسط الدرجة" value={`${stats?.avgScore || 0}%`} color="amber" />
      </div>

      {/* Classification breakdown */}
      <div className="grid grid-cols-2 gap-4">
        <div className="card">
          <h3 className="text-sm font-semibold text-gray-300 mb-4">التصنيفات</h3>
          <div className="space-y-3">
            {[
              { label: 'ممتاز', key: 'Excellent', color: 'bg-green-500' },
              { label: 'جيد', key: 'Good', color: 'bg-lime-500' },
              { label: 'متوسط', key: 'Average', color: 'bg-yellow-500' },
              { label: 'تجاهل', key: 'Ignore', color: 'bg-gray-600' },
            ].map(({ label, key, color }) => {
              const count = stats?.byClassification[key] || 0;
              const total = stats?.total || 1;
              const pct = Math.round((count / total) * 100);
              return (
                <div key={key}>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-gray-400">{label}</span>
                    <span className="text-gray-400 font-mono">{count}</span>
                  </div>
                  <div className="h-1.5 bg-surface-600 rounded-full overflow-hidden">
                    <div
                      className={`h-full ${color} rounded-full transition-all duration-700`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Activity chart */}
        <div className="card">
          <h3 className="text-sm font-semibold text-gray-300 mb-4">النشاط الأخير</h3>
          <ResponsiveContainer width="100%" height={120}>
            <AreaChart data={stats?.daily.slice(-14) || []}>
              <defs>
                <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="date" hide />
              <YAxis hide />
              <Tooltip
                contentStyle={{ background: '#141a15', border: '1px solid #253024', borderRadius: '8px', fontSize: '12px' }}
                labelStyle={{ color: '#9ca3af' }}
                itemStyle={{ color: '#22c55e' }}
              />
              <Area type="monotone" dataKey="count" stroke="#22c55e" fill="url(#areaGrad)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Recent projects */}
      <div className="card">
        <h3 className="text-sm font-semibold text-gray-300 mb-4 flex items-center gap-2">
          <Star size={14} className="text-brand-400" />
          أحدث المشاريع
        </h3>
        <div className="space-y-2">
          {recentProjects.length === 0 && (
            <p className="text-gray-600 text-sm text-center py-4">لا توجد مشاريع بعد</p>
          )}
          {recentProjects.map(p => (
            <div key={p.id} className="flex items-center justify-between p-3 bg-surface-700 rounded-lg hover:bg-surface-600 transition-colors">
              <div className="flex-1 min-w-0">
                <a href={p.url} target="_blank" rel="noopener" className="text-sm text-gray-200 hover:text-brand-400 transition-colors font-medium truncate block">
                  {p.title}
                </a>
                <div className="flex items-center gap-3 mt-1">
                  <span className="text-xs text-gray-500">{p.budget}</span>
                  <span className="text-xs text-gray-600">
                    {formatDistanceToNow(new Date(p.created_at), { addSuffix: true, locale: ar })}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2 mr-3">
                <span className={`text-sm font-bold font-mono ${getScoreColor(p.score)}`}>{p.score}</span>
                <ClassificationBadge c={p.classification} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, color }: { icon: React.ElementType; label: string; value: string | number; color: string }) {
  const colors: Record<string, string> = {
    brand: 'text-brand-400 bg-brand-900/30',
    blue: 'text-blue-400 bg-blue-900/30',
    purple: 'text-purple-400 bg-purple-900/30',
    amber: 'text-amber-400 bg-amber-900/30',
  };
  return (
    <div className="stat-card">
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${colors[color]}`}>
        <Icon size={16} />
      </div>
      <div className="text-2xl font-display font-bold text-white mt-1">{value}</div>
      <div className="text-xs text-gray-500">{label}</div>
    </div>
  );
}

function ClassificationBadge({ c }: { c: string }) {
  const map: Record<string, string> = {
    Excellent: 'badge-excellent',
    Good: 'badge-good',
    Average: 'badge-average',
    Ignore: 'badge-ignore',
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

function LoadingSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="h-8 bg-surface-700 rounded w-48" />
      <div className="grid grid-cols-4 gap-4">
        {[...Array(4)].map((_, i) => <div key={i} className="h-28 bg-surface-700 rounded-xl" />)}
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="h-48 bg-surface-700 rounded-xl" />
        <div className="h-48 bg-surface-700 rounded-xl" />
      </div>
    </div>
  );
}
