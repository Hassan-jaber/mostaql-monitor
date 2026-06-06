export interface ScrapedProject {
  project_id: string;
  title: string;
  url: string;
  budget: string;
  description: string;
  skills: string[];
  posted_at?: string;
}

export interface ProjectRecord {
  id: number;
  project_id: string;
  title: string;
  url: string;
  budget: string;
  description: string;
  skills: string;
  classification: string;
  reason: string;
  matched_keywords: string;
  created_at: string;
  sent_at: string | null;
}

export interface ProjectFilter {
  search?: string;
  classification?: string;
  page?: number;
  limit?: number;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}
