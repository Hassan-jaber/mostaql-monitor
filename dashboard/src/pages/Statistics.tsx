import React, { useEffect, useState } from 'react';
import { projectsApi, Stats } from '../utils/api';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend
} from 'recharts';

const PIE_COLORS = ['#22c55e', '#84cc16', '#f59e0b', '#6b7280'];
const PIE_LABELS = ['Excellent', 'Good', 'Average', 'Ignore'];

export default function Statistics() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    projectsApi.stats().then(s => { setStats(s); setLoading(false); });
  }, []);

  if (loading) return <div className="text-gray-600 text-center py-20">جاري التحميل...</div>;
  if (!stats) return null;

  const pieData = PIE_LABELS.map((label, i) => ({
    name: label,
    value: stats.byClassification[label] || 0,
    color: PIE_COLORS[i],
  })).filter(d => d.value > 0);

  const tooltipStyle = {
    contentStyle: { background: '#141a15', border: '1px solid #253024', borderRadius: '8px', fontSize: '12px' },
    labelStyle: { color: '#9ca3af' },
    itemStyle: { color: '#22c55e' },
  };

  return (
    <div className="space-y-6 animate-slide-up">
      <h1 className="font-display text-2xl font-bold text-white">الإحصائيات</h1>

      <div className="grid grid-cols-2 gap-4">
        {/* Daily chart */}
        <div className="card">
          <h3 className="text-sm font-semibold text-gray-300 mb-4">المشاريع اليومية (آخر 14 يوم)</h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={stats.daily.slice(-14)}>
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#6b7280' }} />
              <YAxis tick={{ fontSize: 10, fill: '#6b7280' }} />
              <Tooltip {...tooltipStyle} />
              <Bar dataKey="count" fill="#22c55e" radius={[4, 4, 0, 0]} opacity={0.8} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Classification pie */}
        <div className="card">
          <h3 className="text-sm font-semibold text-gray-300 mb-4">توزيع التصنيفات</h3>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie data={pieData} cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={3} dataKey="value">
                {pieData.map((entry, i) => (
                  <Cell key={i} fill={entry.color} opacity={0.9} />
                ))}
              </Pie>
              <Tooltip {...tooltipStyle} />
              <Legend formatter={v => <span style={{ color: '#9ca3af', fontSize: '11px' }}>{v}</span>} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Score distribution */}
        <div className="card">
          <h3 className="text-sm font-semibold text-gray-300 mb-4">توزيع الدرجات</h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={stats.scoreDistribution}>
              <XAxis dataKey="range" tick={{ fontSize: 11, fill: '#6b7280' }} />
              <YAxis tick={{ fontSize: 10, fill: '#6b7280' }} />
              <Tooltip {...tooltipStyle} />
              <Bar dataKey="count" fill="#3b82f6" radius={[4, 4, 0, 0]} opacity={0.8} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Top keywords */}
        <div className="card">
          <h3 className="text-sm font-semibold text-gray-300 mb-4">أكثر الكلمات المفتاحية تطابقاً</h3>
          <div className="space-y-2">
            {(stats.topKeywords || []).slice(0, 8).map(({ keyword, count }, i) => (
              <div key={keyword} className="flex items-center gap-3">
                <span className="text-xs text-gray-600 font-mono w-4">{i + 1}</span>
                <div className="flex-1">
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-gray-300 font-mono">{keyword}</span>
                    <span className="text-gray-500">{count}</span>
                  </div>
                  <div className="h-1 bg-surface-600 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-brand-500 rounded-full"
                      style={{ width: `${Math.min(100, (count / (stats.topKeywords[0]?.count || 1)) * 100)}%` }}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
