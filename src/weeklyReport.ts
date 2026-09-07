export interface WeeklyReport {
  week_start: string;
  week_end: string;
  total_sessions: number;
  involved_projects: number;
  total_git: number;
  by_project: ProjectReport[];
  git: GitCommit[];
  markdown: string;
}

export interface ProjectReport {
  project: string;
  sessions: number;
  days: DayRow[];
  commits: CommitEntry[];
}

export interface DayRow {
  date: string;
  topics: string[];
  count: number;
}

export interface CommitEntry {
  date: string;
  subject: string;
}

export interface GitCommit {
  project: string;
  count: number;
}
