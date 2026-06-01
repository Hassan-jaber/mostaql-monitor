import axios from 'axios';

export const api = axios.create({
  baseURL: '/api',
  timeout: 10000,
});

export interface Project {
  id: number;
  project_id: string;
  title: string;
  url: string;
  budget: string;
  description: string;
  skills: string;
  score: number;
  classification: 'Excellent' | 'Good' | 'Average' | 'Ignore';
  reason: string;
  summary: string;
  estimated_duration: string;
  recommended_bid: string;
  proposal: string;
  claude_prompt: string;
  matched_keywords: string;
  created_at: string;
  sent_at: string | null;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface Stats {
  total: number;
  today: number;
  sent: number;
  avgScore: number;
  byClassification: Record<string, number>;
  daily: Array<{ date: string; count: number }>;
  scoreDistribution: Array<{ range: string; count: number }>;
  topKeywords: Array<{ keyword: string; count: number }>;
}

export const projectsApi = {
  list: (params?: Record<string, string | number>) =>
    api.get<PaginatedResponse<Project>>('/projects', { params }).then(r => r.data),
  get: (id: string) =>
    api.get<Project>(`/projects/${id}`).then(r => r.data),
  stats: () =>
    api.get<Stats>('/projects/stats').then(r => r.data),
};

export const settingsApi = {
  get: () =>
    api.get<Record<string, string>>('/settings').then(r => r.data),
  update: (settings: Record<string, string>) =>
    api.put('/settings', settings).then(r => r.data),
  testTelegram: () =>
    api.post('/settings/test-telegram').then(r => r.data),
  toggleMonitoring: (active: boolean) =>
    api.post('/settings/toggle-monitoring', { active }).then(r => r.data),
  runCheck: () =>
    api.post('/settings/run-check').then(r => r.data),
};

export const logsApi = {
  list: (params?: Record<string, string | number>) =>
    api.get('/logs', { params }).then(r => r.data),
  clear: () =>
    api.delete('/logs').then(r => r.data),
};
