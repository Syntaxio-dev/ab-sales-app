import * as work from '../core/mywork.js';
import * as rules from '../core/rules.js';
import { ValidationError } from '../data/store.js';
import { h, icon } from './dom.js';
import { dayString, formatDay, formatDayTime, parseDay } from './format.js';
import { restrict } from './inputs.js';
import { chipGroup, confirmDialog, field, openPage, toast, validate } from './kit.js';
import { empty } from './parts.js';

// "Tasks & notes" (v1.20): ONE page with three parts, opened from the card on Home.
//  - Tasks: what the manager gave the rep (from the website), with files, the e-mail to send the result to, and the rep's status;
//  - To-do: the rep's own short list (private);
//  - Notes: the rep's own notes (private).
// Everything here is built from the same pieces as the other screens (cards, list rows, chips, the segmented switch): no colour of its own.

let tab = 'tasks';
let noteQuery = '';
let todoDraft = '';   // what is typed in the new to-do box and its date: kept while the list redraws
let todoDue = null;
let todoError = '';   // the message under the new to-do box: kept while the list redraws (a sync must not wipe it)

export function resetWorkView() {
  todoError = '';
  tab = 'tasks';
  noteQuery = '';
  todoDraft = '';
  todoDue = null;
}

const TASK_CHIP = { new: 'today', in_progress: '', done: 'approved', blocked: 'late', cancelled: 'rejected' };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---- the card on Home ---------------------------------------------------------------------------------------------------

export function workCard(app) {
  const store = app.store;
  const fresh = work.newTaskCount(store.tasks);
  const open = store.tasks.filter(work.isOpenTask).length;
  const todos = store.todos.filter((t) => !t.done).length;
  const late = store.tasks.filter((t) => work.isOverdue(t)).length;

  return h('div', { class: 'card pad stack' },
    h('p', { class: 'eyebrow', style: { marginBottom: 0 } }, 'Tasks & notes'),
    h('strong', null, fresh ? `${plural(fresh, 'new task', 'new tasks')} from your manager` : open ? `${plural(open, 'task', 'tasks')} to do` : 'No tasks from your manager'),
    h('p', { class: 'muted small' }, [late ? `${late} late` : null, plural(todos, 'to-do', 'to-dos') + ' open', plural(store.memos.length, 'note', 'notes')].filter(Boolean).join(' · ')),
    h('button', { class: `btn small-btn${fresh ? ' primary' : ''}`, onclick: () => openWork(app, { tab: fresh || open ? 'tasks' : 'todo' }) }, icon('clipboard', 18), 'Open'));
}

// ---- the page --------------------------------------------------------------------------------------------------------------

export function openWork(app, { tab: first = null } = {}) {
  const store = app.store;
  if (first) tab = first;

  const body = h('div', { class: 'stack' });
  let page = null;

  const draw = () => {
    const parts = [['tasks', 'Tasks'], ['todo', 'To-do'], ['notes', 'Notes']];
    const fresh = work.newTaskCount(store.tasks);

    const seg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Tasks, to-do or notes' },
      ...parts.map(([value, label]) => h('button', {
        type: 'button', role: 'radio', 'aria-checked': String(value === tab),
        onclick() { tab = value; draw(); },
      }, label + (value === 'tasks' && fresh ? ` (${fresh})` : ''))));

    // the box the rep is typing in (found again by its label): a redraw must never take the keyboard away
    const active = document.activeElement;
    const keep = active && body.contains(active) && ['INPUT', 'TEXTAREA'].includes(active.tagName) ? { label: active.getAttribute('aria-label'), at: active.selectionStart } : null;

    const view = tab === 'tasks' ? tasksView(app) : tab === 'todo' ? todoView(app) : notesView(app, draw);
    body.replaceChildren(seg, view);

    if (keep?.label) {
      const again = [...body.querySelectorAll('input, textarea')].find((el) => el.getAttribute('aria-label') === keep.label);
      again?.focus();
      try { again?.setSelectionRange(keep.at, keep.at); } catch { /* a box without a caret */ }
    }
  };

  const stop = store.subscribe(draw);
  draw();
  page = openPage({ title: 'Tasks & notes', body, onClose: stop });
  return page;
}

// ---- tasks from the manager ----------------------------------------------------------------------------------------------------

function dueText(task) {
  if (!task.due_at) return '';
  const when = new Date(task.due_at);
  return `${work.isOverdue(task) ? 'Late, was due' : 'Due'} ${formatDayTime(when)}`;
}

function taskRow(app, task) {
  const late = work.isOverdue(task);

  return h('button', { class: 'item', type: 'button', onclick: () => openTaskPage(app, task.id) },
    h('span', { class: 'avatar' }, icon('clipboard', 20)),
    h('span', { class: 'grow' },
      h('span', { class: 'title' }, task.title),
      h('span', { class: 'sub' }, [dueText(task) || 'No date', task.priority === 'high' ? 'High priority' : null, task.files.length ? plural(task.files.length, 'file', 'files') : null].filter(Boolean).join(' · ')),
      task.assigned_by_name ? h('span', { class: 'sub added' }, `From ${task.assigned_by_name}`) : null),
    h('span', { class: 'end' }, h('span', { class: `chip ${late ? 'late' : TASK_CHIP[task.status] ?? ''}` }, late && task.status !== 'blocked' ? 'Late' : work.taskStatusLabel(task.status))));
}

function tasksView(app) {
  const { open, finished } = work.sortTasks(app.store.tasks);
  const list = (items) => h('div', { class: 'list' }, items.map((t) => taskRow(app, t)));

  if (!open.length && !finished.length) {
    return empty('clipboard', 'No tasks yet', 'When your manager gives you a task, for example to send a quotation, it shows here with its files. It arrives when the app syncs with the office.');
  }

  return h('div', { class: 'stack' },
    open.length ? h('div', null, h('p', { class: 'eyebrow', style: { marginBottom: '10px' } }, `To do (${open.length})`), list(open)) : h('div', { class: 'card pad muted' }, 'Nothing waiting. Well done.'),
    finished.length ? h('div', null, h('p', { class: 'eyebrow', style: { marginBottom: '10px' } }, `Finished (${finished.length})`), list(finished.slice(0, 20))) : null);
}

export function openTaskPage(app, id) {
  const store = app.store;
  const body = h('div', { class: 'stack' });
  let page = null;

  // what the rep has picked and typed for the update (kept while the page redraws)
  const state = { status: null, note: null };

  const draw = () => {
    const task = store.taskById(id);
    if (!task) { // cancelled and removed by the office
      page?.close();
      return;
    }

    const line = (key, value) => (value ? h('div', { class: 'detail-line' }, h('span', { class: 'k' }, key), h('span', { class: 'v' }, value)) : null);
    const mail = work.mailLink(task.send_to_email, task.title);
    const finished = !work.isOpenTask(task);
    state.status ??= work.repMayChooseStatus(task.status) ? task.status : null;
    state.note ??= task.rep_note ?? '';

    const group = chipGroup(work.TASK_STATUSES.filter((s) => s.rep).map((s) => ({ value: s.value, label: s.label })), state.status, (value) => { state.status = value; });
    const noteInput = restrict(h('textarea', { class: 'input', rows: 3, maxLength: work.MAX_TASK_NOTE, 'aria-label': 'Your note', placeholder: 'For example: quotation sent to the buyer on 26 Nov, or why you cannot do it', value: state.note }), /[<>]/g, { collapse: false });
    noteInput.addEventListener('input', () => { state.note = noteInput.value; });
    const statusSlot = field('Where are you with it?', group.el);
    const noteSlot = field('Your note for the manager (optional)', noteInput);

    const save = h('button', { class: 'btn primary block' }, 'Save');
    save.addEventListener('click', async () => {
      const problem = state.status ? work.taskUpdateProblem({ status: state.status, note: state.note }, task) : null;
      if (!validate([[statusSlot, state.status ? null : 'Pick Started, Done or Cannot do.'], [noteSlot, problem]])) return;

      save.disabled = true;
      try {
        await store.saveTaskUpdate({ id: task.id, status: state.status, note: state.note });
        toast(state.status === 'done' ? 'Marked as done. Well done!' : 'Saved. Your manager can see it.');
        state.status = null;
        state.note = null;
        document.activeElement?.blur?.(); // the keyboard goes away, and the page shows the new status
        draw();
      } catch (error) {
        save.disabled = false;
        toast(error instanceof ValidationError ? error.message : 'Could not save. Please try again.');
      }
    });

    body.replaceChildren(...[
      h('div', { class: 'card pad' },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
          h('span', { class: 'avatar' }, icon('clipboard', 20)),
          h('div', { class: 'grow', style: { minWidth: '0' } }, h('h2', { style: { fontSize: '19px' } }, task.title))),
        h('div', { style: { marginTop: '10px' } },
          h('div', { class: 'detail-line' }, h('span', { class: 'k' }, 'Status'), h('span', { class: 'v' }, h('span', { class: `chip ${work.isOverdue(task) ? 'late' : TASK_CHIP[task.status] ?? ''}` }, work.taskStatusLabel(task.status)))),
          line('From', task.assigned_by_name),
          line('Due', task.due_at ? `${formatDay(new Date(task.due_at))}, ${formatDayTime(new Date(task.due_at)).split(', ').at(-1)}${work.isOverdue(task) ? ' (late)' : ''}` : ''),
          line('Priority', task.priority === 'high' ? 'High' : '')),
        task.description ? h('p', { class: 'task-text', style: { marginTop: '12px' } }, task.description) : null),

      task.send_to_email ? h('div', { class: 'card pad stack' },
        h('p', { class: 'eyebrow', style: { marginBottom: 0 } }, 'Send the result to'),
        h('strong', { style: { overflowWrap: 'anywhere' } }, task.send_to_email),
        mail ? h('a', { class: 'btn block', href: mail }, icon('share', 18), 'Write the e-mail') : null,
        h('p', { class: 'muted small' }, 'Your mail app opens with this address. Attach the finished file there.')) : null,

      h('div', null,
        h('p', { class: 'eyebrow', style: { marginBottom: '10px' } }, `Files (${task.files.length})`),
        task.files.length
          ? h('div', { class: 'list' }, task.files.map((file) => fileRow(app, task, file)))
          : h('div', { class: 'card pad muted' }, 'No files with this task.')),

      task.status === 'cancelled'
        ? h('div', { class: 'card pad muted' }, 'Your manager cancelled this task. You do not need to do it.')
        : h('div', { class: 'card pad stack' },
          h('p', { class: 'eyebrow', style: { marginBottom: 0 } }, finished ? 'Your update' : 'Your update'),
          statusSlot.el, noteSlot.el, save,
          task.rep_updated_at ? h('p', { class: 'muted small' }, `Last update ${formatDayTime(new Date(task.rep_updated_at))}${task.synced ? '' : ' (not sent to the office yet)'}`) : null),
    ].filter(Boolean));
  };

  const stop = store.subscribe(() => {
    const typing = document.activeElement && body.contains(document.activeElement) && document.activeElement.tagName === 'TEXTAREA';
    if (!typing) draw();
  });
  draw();
  page = openPage({ title: 'Task', body, onClose: stop });
}

function fileRow(app, task, file) {
  const row = h('button', { class: 'item', type: 'button', onclick: () => openFile(app, task, file) },
    h('span', { class: 'avatar' }, icon(work.isImageMime(file.mime) ? 'image' : 'receipt', 20)),
    h('span', { class: 'grow' },
      h('span', { class: 'title', style: { overflowWrap: 'anywhere' } }, work.fileLabel(file)),
      h('span', { class: 'sub' }, file.size ? work.sizeText(file.size) : 'File')),
    h('span', { class: 'end' }, h('span', { class: 'chip' }, 'Open')));

  // "not on this phone yet" is said on the row, once it is known
  app.store.hasTaskFile(task.id, file.id).then((has) => {
    if (!has) row.querySelector('.chip').textContent = 'Waiting';
  });
  return row;
}

// A picture is shown here; any other file (PDF, Excel, Word ...) is handed to the phone's own app through the share sheet.
async function openFile(app, task, file) {
  const bytes = await app.store.taskFileFor(task.id, file.id);
  if (!bytes) return void toast('This file is not on your phone yet. It arrives with the next sync.');

  if (work.isImageMime(file.mime) && rules.imageKind(bytes)) {
    const url = URL.createObjectURL(new Blob([bytes], { type: file.mime }));
    openPage({ title: work.fileLabel(file), body: h('div', { class: 'stack' }, h('img', { class: 'bill', src: url, alt: work.fileLabel(file) })), onClose: () => URL.revokeObjectURL(url) });
    return undefined;
  }

  app.suspendAutoLock = true; // another app opens: the phone must not lock this one meanwhile
  try {
    await app.platform.shareBytes(work.fileLabel(file), bytes, file.mime);
  } catch (error) {
    if (!/cancel|dismiss/i.test(String(error?.message))) toast('The file could not be opened.');
  } finally {
    app.suspendAutoLock = false;
  }
  return undefined;
}

// ---- my to-do list (private) ---------------------------------------------------------------------------------------------------

function todoView(app) {
  const store = app.store;
  const today = dayString();
  const tomorrow = dayString(new Date(Date.now() + 86_400_000));
  const { open, done, late } = work.sortTodos(store.todos, today);

  const input = restrict(h('input', { class: 'input', type: 'text', maxLength: work.MAX_TODO, autocomplete: 'off', placeholder: 'Add a to-do, for example: call Greenlam about the specs', 'aria-label': 'New to-do', value: todoDraft }), /[<>]/g, { collapse: true });
  const error = h('div', { class: 'err', role: 'alert' }, todoError);
  input.addEventListener('input', () => { todoDraft = input.value; todoError = ''; error.textContent = ''; });
  const dueChips = h('div', { class: 'chips', role: 'radiogroup', 'aria-label': 'When' });
  const drawChips = () => dueChips.replaceChildren(...[['No date', null], ['Today', today], ['Tomorrow', tomorrow]].map(([label, value]) => h('button', {
    type: 'button', class: 'filter', role: 'radio', 'aria-checked': String(todoDue === value), onclick() { todoDue = value; drawChips(); },
  }, label)));
  drawChips();

  const add = async () => {
    todoError = '';
    error.textContent = '';
    const title = input.value;
    try {
      todoDraft = ''; // before the save: the save redraws the page, and the new box must start empty
      await store.saveTodo({ title, due_date: todoDue });
      input.value = '';
      input.focus();
    } catch (e) {
      todoDraft = title; // what was typed stays, so it can be corrected
      todoError = e instanceof ValidationError ? e.message : 'Could not save. Please try again.';
      error.textContent = todoError;
    }
  };
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); add(); } });

  const row = (t) => {
    const lateOne = !t.done && t.due_date && t.due_date < today;
    return h('div', { class: `item${t.done ? ' todo-done' : ''}` },
      h('button', {
        type: 'button', class: 'todo-check', role: 'checkbox', 'aria-checked': String(t.done), 'aria-label': t.done ? `Mark ${t.title} as not done` : `Mark ${t.title} as done`,
        async onclick() { await store.setTodoDone(t.id, !t.done); },
      }, t.done ? icon('check', 16) : null),
      h('span', { class: 'grow' },
        h('span', { class: 'title', style: { overflowWrap: 'anywhere' } }, t.title),
        t.due_date ? h('span', { class: 'sub' }, t.due_date === today ? 'Today' : t.due_date === tomorrow ? 'Tomorrow' : formatDay(parseDay(t.due_date))) : null),
      lateOne ? h('span', { class: 'end' }, h('span', { class: 'chip late' }, 'Late')) : null,
      h('button', {
        type: 'button', class: 'icon-btn', 'aria-label': `Delete ${t.title}`,
        async onclick() {
          if (await confirmDialog({ title: 'Delete this to-do?', text: t.title })) await store.deleteTodo(t.id);
        },
      }, icon('close', 18)));
  };

  return h('div', { class: 'stack' },
    h('div', { class: 'card pad stack' },
      input, dueChips, error,
      h('button', { class: 'btn primary block', type: 'button', onclick: add }, icon('plus', 18), 'Add to-do')),
    open.length
      ? h('div', null, h('p', { class: 'eyebrow', style: { marginBottom: '10px' } }, `To do (${open.length})${late.length ? ` · ${late.length} late` : ''}`), h('div', { class: 'list' }, open.map(row)))
      : h('div', { class: 'card pad muted' }, done.length ? 'Everything is done. Add the next thing above.' : 'Your list is empty. What do you need to do today?'),
    done.length ? h('div', null, h('p', { class: 'eyebrow', style: { marginBottom: '10px' } }, `Done (${done.length})`), h('div', { class: 'list' }, done.slice(0, 15).map(row))) : null,
    h('p', { class: 'muted small' }, 'Only you see your to-do list. It is saved on this phone and at the office, so a new phone gets it back.'));
}

// ---- my notes (private) ---------------------------------------------------------------------------------------------------------------

function notesView(app, redraw) {
  const store = app.store;
  const memos = work.searchMemos(store.memos, noteQuery);

  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search your notes', autocomplete: 'off', value: noteQuery, 'aria-label': 'Search notes' });
  search.addEventListener('input', () => {
    noteQuery = search.value;
    redraw(); // the page gives the focus back to this box
  });

  return h('div', { class: 'stack' },
    store.memos.length ? search : null,
    h('button', { class: 'btn primary block', type: 'button', onclick: () => openMemoPage(app) }, icon('plus', 18), 'New note'),
    memos.length
      ? h('div', { class: 'list' }, memos.map((m) => h('button', { class: 'item', type: 'button', onclick: () => openMemoPage(app, m.id) },
        h('span', { class: 'avatar' }, icon('edit', 20)),
        h('span', { class: 'grow' },
          h('span', { class: 'title', style: { overflowWrap: 'anywhere' } }, work.memoTitle(m)),
          h('span', { class: 'sub' }, `${m.body.replace(/\s+/g, ' ').slice(0, 70)}${m.body.length > 70 ? '...' : ''}`),
          h('span', { class: 'sub added' }, formatDayTime(new Date(m.updated_at)))))))
      : empty('search', store.memos.length ? 'No note found' : 'No notes yet', store.memos.length ? 'Try other words.' : 'Write what you need to remember: what a client said, a price, an idea. Only you can read your notes.'));
}

export function openMemoPage(app, id = null) {
  const store = app.store;
  const existing = id ? store.memoById(id) : null;
  if (id && !existing) return;

  const title = field('Title (optional)', restrict(h('input', { class: 'input', type: 'text', maxLength: work.MAX_MEMO_TITLE, autocomplete: 'off', value: existing?.title ?? '' }), /[<>]/g));
  const text = field('Note', restrict(h('textarea', { class: 'input', rows: 12, maxLength: work.MAX_MEMO_BODY, value: existing?.body ?? '', placeholder: 'Write here...' }), /[<>]/g, { collapse: false }));
  let page = null;

  const save = h('button', { class: 'btn primary block' }, 'Save note');
  save.addEventListener('click', async () => {
    if (!validate([[title, rules.optional(title.input.value, { max: work.MAX_MEMO_TITLE, label: 'Title' })], [text, rules.required(text.input.value, { min: 1, max: work.MAX_MEMO_BODY, label: 'The note' })]])) return;

    save.disabled = true;
    try {
      await store.saveMemo({ id: existing?.id, title: title.input.value, body: text.input.value });
      page.close();
    } catch (error) {
      save.disabled = false;
      toast(error instanceof ValidationError ? error.message : 'Could not save. Please try again.');
    }
  });

  page = openPage({
    title: existing ? 'Edit note' : 'New note',
    body: h('div', { class: 'stack' }, title.el, text.el,
      existing ? h('p', { class: 'muted small' }, `Last changed ${formatDayTime(new Date(existing.updated_at))}`) : null,
      existing ? h('button', {
        class: 'btn danger block',
        async onclick() {
          if (await confirmDialog({ title: 'Delete this note?', text: 'It cannot be undone.' })) {
            await store.deleteMemo(existing.id);
            page.close();
          }
        },
      }, icon('trash', 18), 'Delete note') : null),
    footer: save,
  });
}
