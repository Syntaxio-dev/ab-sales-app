// "Tasks & notes" (v1.20): the rep's own to-do list and notes (private), and the TASKS the manager gives them from the website. Pure functions:
// no screen, no storage.
import * as rules from './rules.js';

export const MAX_TODO = 200;        // characters of one to-do
export const MAX_MEMO_TITLE = 120;
export const MAX_MEMO_BODY = 5000;
export const MAX_TASK_NOTE = 500;   // what the rep writes back on a task
export const MAX_OPEN_TODOS = 300;  // a to-do list is a short list: more than this is a mistake, not a plan
export const MAX_MEMOS = 300;

// ---- to-do (private to the rep) ---------------------------------------------------------------------------------------------

export const todoProblem = ({ title, due_date: due }, now = new Date()) => rules.firstError(
  rules.required(title, { min: 2, max: MAX_TODO, label: 'To-do' }),
  due && !/^\d{4}-\d{2}-\d{2}$/.test(due) ? 'Pick a valid date.' : null,
  due && Date.parse(`${due}T00:00:00`) > now.getTime() + 2 * 365 * 86_400_000 ? 'A to-do can be at most 2 years ahead.' : null,
);

// open first (the soonest date first, then the newest), done ones last (the newest done first)
export function sortTodos(list, today = '') {
  const open = list.filter((t) => !t.done).sort((a, b) => (a.due_date ?? '9999') .localeCompare(b.due_date ?? '9999') || b.created_at.localeCompare(a.created_at));
  const done = list.filter((t) => t.done).sort((a, b) => (b.done_at ?? '').localeCompare(a.done_at ?? ''));
  return { open, done, late: open.filter((t) => t.due_date && today && t.due_date < today), today: open.filter((t) => t.due_date === today) };
}

// ---- notes (private to the rep) --------------------------------------------------------------------------------------------------

export const memoProblem = ({ title, body }) => rules.firstError(
  rules.optional(title, { max: MAX_MEMO_TITLE, label: 'Title' }),
  rules.required(body, { min: 1, max: MAX_MEMO_BODY, label: 'Note' }),
);

// the title is optional: a note without one is shown by its first line
export const memoTitle = (memo) => memo.title || String(memo.body ?? '').split('\n').find((l) => l.trim())?.trim().slice(0, 60) || 'Note';

export const searchMemos = (memos, text) => {
  const q = String(text ?? '').trim().toLowerCase();
  return q ? memos.filter((m) => `${m.title} ${m.body}`.toLowerCase().includes(q)) : memos;
};

// ---- tasks from the manager --------------------------------------------------------------------------------------------------------

// value, label, who may set it. 'new' and 'cancelled' belong to the office; the rep moves a task on, or says why it cannot be done.
export const TASK_STATUSES = [
  { value: 'new', label: 'New', rep: false },
  { value: 'in_progress', label: 'Started', rep: true },
  { value: 'done', label: 'Done', rep: true },
  { value: 'blocked', label: 'Cannot do', rep: true },
  { value: 'cancelled', label: 'Cancelled', rep: false },
];
export const isTaskStatus = (v) => TASK_STATUSES.some((s) => s.value === v);
export const taskStatusLabel = (v) => TASK_STATUSES.find((s) => s.value === v)?.label ?? 'New';
export const repMayChooseStatus = (v) => TASK_STATUSES.find((s) => s.value === v)?.rep === true;
export const isOpenTask = (task) => ['new', 'in_progress', 'blocked'].includes(task.status);
export const PRIORITIES = ['normal', 'high'];

// What the rep sends back: the new status and a note ("cannot do" needs the reason).
export const taskUpdateProblem = ({ status, note }, task) => rules.firstError(
  repMayChooseStatus(status) ? null : 'Pick Started, Done or Cannot do.',
  task?.status === 'cancelled' ? 'The manager cancelled this task.' : null,
  rules.optional(note, { max: MAX_TASK_NOTE, label: 'Your note' }),
  status === 'blocked' && !String(note ?? '').trim() ? 'Tell the manager why you cannot do it.' : null,
);

// A task that is still to be done: the ones with a date first (soonest), high priority before normal, then the newest.
export function sortTasks(tasks) {
  const open = tasks.filter(isOpenTask).sort((a, b) => (a.due_at ?? '9999').localeCompare(b.due_at ?? '9999') || Number(b.priority === 'high') - Number(a.priority === 'high') || b.created_at.localeCompare(a.created_at));
  const finished = tasks.filter((t) => !isOpenTask(t)).sort((a, b) => (b.rep_updated_at ?? b.created_at).localeCompare(a.rep_updated_at ?? a.created_at));
  return { open, finished };
}

export const isOverdue = (task, now = Date.now()) => isOpenTask(task) && Boolean(task.due_at) && Date.parse(task.due_at) < now;

// How many tasks the rep has not opened yet (status new): the badge on Home.
export const newTaskCount = (tasks) => tasks.filter((t) => t.status === 'new').length;

// An e-mail the task says to send something to: only a plain address becomes a mail link, so nothing else can ever be put in the link.
export const mailLink = (email, subject = '') => (rules.email(email) === null && String(email ?? '').trim()
  ? `mailto:${String(email).trim()}${subject ? `?subject=${encodeURIComponent(String(subject).slice(0, 150))}` : ''}`
  : null);

// A file of a task: a short, safe label (the name comes from the office) and a size in words.
export const fileLabel = (file) => `${String(file.name ?? 'file').replace(/[\u0000-\u001F\u007F<>]/g, '').slice(0, 80) || 'file'}`;
export const sizeText = (bytes) => (bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
export const isImageMime = (mime) => ['image/jpeg', 'image/png', 'image/webp'].includes(mime);
