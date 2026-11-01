/**
 * Job lifecycle. A job is one unit of service: a home visit, a clinic
 * appointment or a delivery. Transitions are explicit and role-checked.
 *
 *   requested ─assign─▶ assigned ─start─▶ en_route ─arrive─▶ arrived ─begin─▶ in_progress ─complete─▶ completed
 *        │                 │                 │                  │                 │
 *        └──────────── cancel (patient before en_route; ops any time before completed) ──▶ cancelled
 *                          └─ no_show (staff/ops after arrived) ──▶ no_show
 * Clinic visits skip en_route ("arrive" is the patient checking in at the desk).
 */
export const JOB_STATUSES = [
  'requested',
  'assigned',
  'en_route',
  'arrived',
  'in_progress',
  'completed',
  'cancelled',
  'no_show',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export type JobKind = 'home_visit' | 'clinic_visit' | 'delivery';
export type Role = 'patient' | 'caregiver' | 'courier' | 'ops' | 'admin';

export type Action =
  'assign' | 'unassign' | 'start' | 'arrive' | 'begin' | 'complete' | 'cancel' | 'no_show';

interface Rule {
  from: JobStatus[];
  to: JobStatus;
  roles: Role[];
  /** Staff may act only on their own jobs; patients only on theirs. */
  kinds?: JobKind[];
}

const STAFF: Role[] = ['caregiver', 'courier'];
const OPS: Role[] = ['ops', 'admin'];

const RULES: Record<Action, Rule> = {
  assign: { from: ['requested', 'assigned'], to: 'assigned', roles: OPS },
  unassign: { from: ['assigned'], to: 'requested', roles: OPS },
  start: {
    from: ['assigned'],
    to: 'en_route',
    roles: [...STAFF, ...OPS],
    kinds: ['home_visit', 'delivery'],
  },
  arrive: { from: ['en_route', 'assigned'], to: 'arrived', roles: [...STAFF, ...OPS] },
  begin: {
    from: ['arrived'],
    to: 'in_progress',
    roles: [...STAFF, ...OPS],
    kinds: ['home_visit', 'clinic_visit'],
  },
  complete: { from: ['in_progress', 'arrived'], to: 'completed', roles: [...STAFF, ...OPS] },
  cancel: {
    from: ['requested', 'assigned', 'en_route', 'arrived'],
    to: 'cancelled',
    roles: ['patient', ...OPS],
  },
  no_show: { from: ['arrived', 'in_progress'], to: 'no_show', roles: [...STAFF, ...OPS] },
};

export class TransitionError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 403 | 409 = 409,
  ) {
    super(message);
  }
}

export interface JobRef {
  status: JobStatus;
  kind: JobKind;
  patient_id: string;
  staff_id: string | null;
}

/** Validate an action and return the next status, or throw with a precise reason. */
export function transition(
  job: JobRef,
  action: Action,
  actor: { id: string; role: Role },
): JobStatus {
  const rule = RULES[action];
  if (!rule) throw new TransitionError(`unknown action ${action}`, 400);
  if (!rule.roles.includes(actor.role))
    throw new TransitionError(`${actor.role} cannot ${action} a job`, 403);
  if (STAFF.includes(actor.role) && job.staff_id !== actor.id)
    throw new TransitionError('this job is not assigned to you', 403);
  if (actor.role === 'patient' && job.patient_id !== actor.id)
    throw new TransitionError('this is not your booking', 403);
  if (rule.kinds && !rule.kinds.includes(job.kind))
    throw new TransitionError(`${action} does not apply to a ${job.kind}`, 409);
  // Patients may cancel only before anyone is on the way.
  if (
    action === 'cancel' &&
    actor.role === 'patient' &&
    !['requested', 'assigned'].includes(job.status)
  )
    throw new TransitionError(
      'the caregiver is already on the way; call the clinic to cancel',
      409,
    );
  // Clinic visits: "arrive" is check-in from assigned. Home visits/deliveries must be en route first.
  if (action === 'arrive' && job.status === 'assigned' && job.kind !== 'clinic_visit')
    throw new TransitionError('start the trip before arriving', 409);
  // Deliveries complete on arrival (with OTP); visits must begin first.
  if (action === 'complete' && job.status === 'arrived' && job.kind !== 'delivery')
    throw new TransitionError('begin the visit before completing it', 409);
  if (!rule.from.includes(job.status))
    throw new TransitionError(`cannot ${action} a job that is ${job.status}`, 409);
  if (action === 'assign' || action === 'unassign') return rule.to;
  if (['start', 'arrive', 'begin', 'complete', 'no_show'].includes(action) && !job.staff_id)
    throw new TransitionError('assign someone first', 409);
  return rule.to;
}

export const isOpen = (s: JobStatus) => !['completed', 'cancelled', 'no_show'].includes(s);
