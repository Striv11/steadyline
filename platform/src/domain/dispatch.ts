/**
 * Auto-dispatch: choose who should take a job.
 *
 * Hard constraints (a candidate is eligible only if all hold):
 *  - has the service's skill and is active
 *  - a shift covers the whole job window
 *  - no overlap with their other open jobs, including travel time between them
 *  - under their daily job cap
 * Among eligible candidates, minimize a cost that combines travel from where
 * they will be just before the job (previous job or home/site), and workload.
 */
export interface Point {
  lat: number;
  lng: number;
}

export function haversineKm(a: Point, b: Point): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Urban travel estimate: road distance ≈ 1.35 × straight line, 20 km/h average, plus 10 min parking/stairs. */
export function travelMinutes(a: Point, b: Point): number {
  const km = haversineKm(a, b) * 1.35;
  return Math.ceil((km / 20) * 60) + 10;
}

export interface Window {
  start: number; // epoch ms
  end: number;
}

export interface CandidateJob extends Window {
  at: Point;
}

export interface Candidate {
  id: string;
  name: string;
  skills: string[];
  base: Point; // home, or clinic site
  shifts: Window[];
  jobs: CandidateJob[]; // their open jobs that day
  maxJobsPerDay: number;
}

export interface JobRequest extends Window {
  skill: string;
  at: Point; // patient address, or clinic site
}

export interface Ranked {
  id: string;
  name: string;
  cost: number;
  travelMin: number;
  reason: string;
}

export interface Rejected {
  id: string;
  name: string;
  reason: string;
}

const MIN = 60_000;

/** Rank everyone; return eligible candidates (best first) and the reasons others were excluded. */
export function rank(
  job: JobRequest,
  candidates: Candidate[],
): { eligible: Ranked[]; rejected: Rejected[] } {
  const eligible: Ranked[] = [];
  const rejected: Rejected[] = [];
  for (const c of candidates) {
    const no = (reason: string) => rejected.push({ id: c.id, name: c.name, reason });
    if (!c.skills.includes(job.skill)) {
      no(`lacks skill ${job.skill}`);
      continue;
    }
    if (!c.shifts.some((s) => s.start <= job.start && s.end >= job.end)) {
      no('not on shift for the whole visit');
      continue;
    }
    if (c.jobs.length >= c.maxJobsPerDay) {
      no(`already has ${c.jobs.length} jobs (cap ${c.maxJobsPerDay})`);
      continue;
    }
    const sorted = [...c.jobs].sort((a, b) => a.start - b.start);
    const before = sorted.filter((j) => j.end <= job.start).at(-1);
    const after = sorted.find((j) => j.start >= job.end);
    const clash = sorted.find((j) => j.start < job.end && j.end > job.start);
    if (clash) {
      no('overlaps another job');
      continue;
    }
    const from = before?.at ?? c.base;
    const travelIn = travelMinutes(from, job.at);
    const freeFrom = before ? before.end : Math.min(...c.shifts.map((s) => s.start));
    if (before && before.end + travelIn * MIN > job.start) {
      no(`cannot get there in time (${travelIn} min from the previous job)`);
      continue;
    }
    if (after && job.end + travelMinutes(job.at, after.at) * MIN > after.start) {
      no('would be late for the next job');
      continue;
    }
    void freeFrom;
    // Cost: minutes of travel, plus 15 min-equivalent per existing job to spread the load.
    const cost = travelIn + 15 * c.jobs.length;
    eligible.push({
      id: c.id,
      name: c.name,
      cost,
      travelMin: travelIn,
      reason: `${travelIn} min away, ${c.jobs.length} job(s) that day`,
    });
  }
  eligible.sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name));
  return { eligible, rejected };
}
