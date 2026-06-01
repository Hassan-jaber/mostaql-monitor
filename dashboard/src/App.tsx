import React, { useState } from 'react';
import { LayoutDashboard, FolderOpen, BarChart3, Settings, FileText, Activity } from 'lucide-react';
import Overview from './pages/Overview';
import Projects from './pages/Projects';
import Statistics from './pages/Statistics';
import SettingsPage from './pages/SettingsPage';
import Logs from './pages/Logs';

type Page = 'overview' | 'projects' | 'statistics' | 'settings' | 'logs';

const navItems = [
  { id: 'overview' as Page, icon: LayoutDashboard, label: 'نظرة عامة' },
  { id: 'projects' as Page, icon: FolderOpen, label: 'المشاريع' },
  { id: 'statistics' as Page, icon: BarChart3, label: 'الإحصائيات' },
  { id: 'settings' as Page, icon: Settings, label: 'الإعدادات' },
  { id: 'logs' as Page, icon: FileText, label: 'السجلات' },
];

export default function App() {
  const [page, setPage] = useState<Page>('overview');

  return (
    <div className="min-h-screen bg-surface-900 flex" dir="rtl">
      {/* Scan line effect */}
      <div className="scan-line" />

      {/* Sidebar */}
      <aside className="w-64 bg-surface-800 border-l border-surface-600 flex flex-col fixed top-0 right-0 h-full z-10">
        {/* Logo */}
        <div className="p-6 border-b border-surface-600">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-brand-600 rounded-lg flex items-center justify-center">
              <Activity size={16} className="text-white" />
            </div>
            <div>
              <div className="font-display font-bold text-white text-sm leading-none">Mostaql</div>
              <div className="text-brand-400 text-xs font-mono mt-0.5">MONITOR v1.0</div>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 p-3 space-y-1">
          {navItems.map(item => (
            <button
              key={item.id}
              onClick={() => setPage(item.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
                page === item.id
                  ? 'bg-brand-600/20 text-brand-400 border border-brand-600/30'
                  : 'text-gray-400 hover:text-gray-200 hover:bg-surface-700'
              }`}
            >
              <item.icon size={16} />
              {item.label}
            </button>
          ))}
        </nav>

        {/* Footer */}
        <div className="p-4 border-t border-surface-600">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 bg-brand-400 rounded-full animate-pulse" />
            <span className="text-xs text-gray-500 font-mono">MONITORING ACTIVE</span>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 mr-64 min-h-screen">
        <div className="p-6 animate-fade-in">
          {page === 'overview' && <Overview />}
          {page === 'projects' && <Projects />}
          {page === 'statistics' && <Statistics />}
          {page === 'settings' && <SettingsPage />}
          {page === 'logs' && <Logs />}
        </div>
      </main>
    </div>
  );
}
