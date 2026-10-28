import { PLAN_DAYS, addDays, startOfDay } from '../core/meeting.js';
import { h, icon } from './dom.js';
import { dayString, formatTime } from './format.js';
import { dateInput, timeInput } from './pickers.js';

// "When?" for a planned meeting: day chips (Today, Tomorrow, the day after, Pick date) and time chips (10 am, 12 pm, 3 pm, 5 pm, Other).
// The chosen moment lives in `state.when` (a Date); the picker only changes it. `state.touched` becomes true once the rep picks a time
// themself (a time the rep set by hand is never moved by the route's automatic spacing).

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TIMES = [[10, '10 am'], [12, '12 pm'], [15, '3 pm'], [17, '5 pm']];

export const shortDay = (date) => `${DAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`;
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export function whenChips(state, { onChange = () => {} } = {}) {
  const dayBox = h('div', { class: 'chips', role: 'radiogroup', 'aria-label': 'Day' });
  const timeBox = h('div', { class: 'chips', role: 'radiogroup', 'aria-label': 'Time' });

  const today = () => startOfDay(new Date());
  const limits = () => ({ min: dayString(today()), max: dayString(addDays(today(), PLAN_DAYS)) });

  const dayPicker = dateInput({ ...limits(), value: dayString(state.when), pickerTitle: 'Which day?', 'aria-label': 'Day' });
  const timePicker = timeInput({ value: `${String(state.when.getHours()).padStart(2, '0')}:${String(state.when.getMinutes()).padStart(2, '0')}`, pickerTitle: 'What time?', 'aria-label': 'Time' });
  dayPicker.hidden = true;
  timePicker.hidden = true;

  const setDay = (date) => {
    state.when = new Date(date.getFullYear(), date.getMonth(), date.getDate(), state.when.getHours(), state.when.getMinutes());
    draw();
    onChange();
  };
  const setTime = (hh, mm) => {
    state.when = new Date(state.when.getFullYear(), state.when.getMonth(), state.when.getDate(), hh, mm);
    state.touched = true;
    draw();
    onChange();
  };

  dayPicker.addEventListener('change', () => {
    const [y, m, d] = dayPicker.value.split('-').map(Number);
    setDay(new Date(y, m - 1, d));
  });
  timePicker.addEventListener('change', () => {
    const [hh, mm] = timePicker.value.split(':').map(Number);
    setTime(hh, mm);
  });

  function draw() {
    const t0 = today();
    const choices = [[t0, 'Today'], [addDays(t0, 1), 'Tomorrow'], [addDays(t0, 2), shortDay(addDays(t0, 2))]];
    const onChoice = choices.some(([d]) => sameDay(d, state.when));

    dayBox.replaceChildren(
      ...choices.map(([date, label]) => h('button', {
        type: 'button', class: 'filter big', role: 'radio', 'aria-checked': String(sameDay(date, state.when)), onclick: () => setDay(date),
      }, label)),
      h('button', {
        type: 'button', class: 'filter big with-icon', role: 'radio', 'aria-checked': String(!onChoice),
        onclick() {
          dayPicker.value = dayString(state.when);
          dayPicker.click();
        },
      }, icon('calendar', 16), onChoice ? 'Pick date' : shortDay(state.when)));

    const hh = state.when.getHours();
    const onTime = state.when.getMinutes() === 0 && TIMES.some(([hour]) => hour === hh);

    timeBox.replaceChildren(
      ...TIMES.map(([hour, label]) => h('button', {
        type: 'button', class: 'filter big', role: 'radio', 'aria-checked': String(onTime && hh === hour), onclick: () => setTime(hour, 0),
      }, label)),
      h('button', {
        type: 'button', class: 'filter big with-icon', role: 'radio', 'aria-checked': String(!onTime),
        onclick() {
          timePicker.value = `${String(hh).padStart(2, '0')}:${String(state.when.getMinutes()).padStart(2, '0')}`;
          timePicker.click();
        },
      }, icon('alarm', 16), onTime ? 'Other' : formatTime(state.when)));
  }

  draw();

  return {
    days: h('div', null, h('p', { class: 'eyebrow' }, 'Day'), dayBox, dayPicker),
    times: h('div', null, h('p', { class: 'eyebrow' }, 'Time'), timeBox, timePicker),
    redraw: draw,
  };
}
