// The numbers of a day for the daily report, counted from what is saved on this phone. The rep sees them before sending, and they are
// sent with the report (the website also counts the same things from the synced records).

const localDay = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function figuresFor(store, day) {
  const calls = store.calls.filter((c) => localDay(c.started_at) === day);
  const worked = store.enquiries.filter((e) => localDay(e.opened_at) === day || e.timeline.some((t) => localDay(t.at) === day));

  return {
    calls: calls.length,
    calls_missed: calls.filter((c) => c.direction === 'missed').length,
    talk_seconds: calls.reduce((sum, c) => sum + c.duration_seconds, 0),
    meetings: store.meetings.filter((m) => localDay(m.meeting_at) === day).length,
    enquiries_new: store.enquiries.filter((e) => localDay(e.opened_at) === day).length,
    enquiries_worked: worked.length,
    expenses_paise: store.expenses.filter((e) => e.expense_date === day).reduce((sum, e) => sum + e.amount_paise, 0),
  };
}

// The enquiries the rep touched that day (opened, or a note / status change), for the report screen.
export function enquiriesWorked(store, day) {
  return store.enquiries.filter((e) => localDay(e.opened_at) === day || e.timeline.some((t) => localDay(t.at) === day));
}
