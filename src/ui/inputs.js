import { COUNTRIES, DEFAULT_COUNTRY, countryOf, joinPhone, phoneProblem, splitPhone } from '../core/phone.js';
import { BUSINESS_STRIP, PERSON_STRIP, PLACE_STRIP } from '../core/rules.js';
import { h } from './dom.js';
import { slot } from './kit.js';

// Boxes that only take what they are for. The rules in core/rules.js are the real check (and the store repeats them); these boxes make
// the wrong thing hard to type in the first place: a phone box takes digits only, a name box takes no digits, a quantity box only numbers.

const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

// While typing or pasting: remove what the box may not hold, keep the cursor where it was.
export function restrict(input, strip, { collapse = true } = {}) {
  input.addEventListener('input', () => {
    const before = input.value;
    let clean = before.replace(CONTROL, '').replace(strip, '');
    if (collapse) clean = clean.replace(/^\s+/, '').replace(/\s{2,}/g, ' ');
    if (clean === before) return;

    const fromEnd = before.length - (input.selectionStart ?? before.length);
    input.value = clean;
    try {
      const at = Math.max(0, clean.length - fromEnd);
      input.setSelectionRange(at, at);
    } catch {
      // some input types (email) have no cursor to move
    }
  });
  return input;
}

const textProps = { class: 'input', type: 'text', autocomplete: 'off' };

/** A person's name: letters, spaces and . ' - (no digits). */
export const personInput = (props = {}) => restrict(h('input', { ...textProps, maxLength: 100, autocapitalize: 'words', ...props }), PERSON_STRIP);

/** A company, product or brand list: letters, digits, spaces and & / ( ) . , ' + # : - */
export const businessInput = (props = {}) => restrict(h('input', { ...textProps, maxLength: 150, autocapitalize: 'words', ...props }), BUSINESS_STRIP);

/** A town or city: letters, spaces and . , ' - */
export const placeInput = (props = {}) => restrict(h('input', { ...textProps, maxLength: 100, autocapitalize: 'words', ...props }), PLACE_STRIP);

// The towns the team visits most, one tap under the Place box. The box still takes any other place.
export const RAJASTHAN_CITIES = ['Jaipur', 'Jodhpur', 'Udaipur', 'Kota', 'Ajmer', 'Bikaner', 'Bhilwara', 'Alwar', 'Sikar', 'Bhiwadi', 'Neemrana', 'Pali'];

/** Quick-pick chips for a Place box: a tap fills the box, typing something else clears the highlight. */
export function cityPicks(input) {
  const el = h('div', { class: 'chips quick-picks', role: 'group', 'aria-label': 'Quick picks for the place' });
  const same = (a, b) => a.trim().toLowerCase() === b.toLowerCase();

  const draw = () => el.replaceChildren(...RAJASTHAN_CITIES.map((city) => h('button', {
    class: 'filter', type: 'button', 'aria-pressed': String(same(input.value, city)),
    onclick() {
      input.value = city;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      draw();
    },
  }, city)));

  input.addEventListener('input', draw);
  draw();
  return el;
}

/** A position (job title): the same characters the shared list allows. */
export const positionInput = (props = {}) => restrict(h('input', { ...textProps, maxLength: 60, autocapitalize: 'words', ...props }), /[^\p{L}\p{N} &/().,'-]/gu);

/** An e-mail address: no spaces, lower case. */
export const emailInput = (props = {}) => restrict(h('input', { class: 'input', type: 'email', inputMode: 'email', autocomplete: 'off', autocapitalize: 'off', spellcheck: false, maxLength: 150, ...props }), /[\s,;:<>()[\]\\"]/g, { collapse: false });

/** A whole number (a quantity). */
export const numberInput = (props = {}) => restrict(h('input', { ...textProps, inputMode: 'numeric', maxLength: 6, ...props }), /\D/g, { collapse: false });

/** An amount of money: digits and one decimal point. */
export const moneyInput = (props = {}) => restrict(h('input', { ...textProps, inputMode: 'decimal', maxLength: 12, ...props }), /[^\d.,]/g, { collapse: false });

/** The employee code or phone number on the sign-in page. */
export const loginInput = (props = {}) => restrict(h('input', { ...textProps, maxLength: 40, autocapitalize: 'characters', ...props }), /[^A-Za-z0-9+ -]/g, { collapse: false });

// ---- the phone box: a country code and the number ------------------------------------------------------------------

/**
 * A phone number as two boxes: the country code (India first) and the number, digits only. Pasting "+91 98765 43210" or
 * "098765 43210" is understood. `landline`: an office board number may start with any digit 1-9 (a mobile starts with 6-9).
 * Returns the same shape as field() plus:
 *   .value      "+919876543210", or '' when empty
 *   .problem()  the message to show, or null (also when empty and not required)
 */
export function phoneField(label, { value = '', required = false, landline = false, hint = null, ariaLabel = null } = {}) {
  const start = splitPhone(value);
  const select = h('select', { class: 'input', 'aria-label': 'Country code' });
  const number = h('input', {
    class: 'input', type: 'tel', inputMode: 'numeric', autocomplete: 'off', placeholder: '98765 43210', 'aria-label': ariaLabel ?? label, value: start.national,
  });

  const codes = COUNTRIES.some((c) => c.code === start.country) ? COUNTRIES : [...COUNTRIES, countryOf(start.country)];
  select.replaceChildren(...codes.map((c) => h('option', { value: c.code, title: c.name }, `${c.iso} +${c.code}`)));
  select.value = start.country;

  const maxDigits = () => countryOf(select.value).max;

  // digits only; a pasted "+91 ..." / "0..." / "91..." in front of a full number is dropped
  const tidy = () => {
    let digits = number.value.replace(/\D+/g, '');
    const code = select.value;

    if (digits.length > maxDigits() && digits.startsWith(code)) digits = digits.slice(code.length);
    if (code === DEFAULT_COUNTRY && digits.length === 11 && digits[0] === '0') digits = digits.slice(1);

    digits = digits.slice(0, maxDigits());
    if (digits !== number.value) number.value = digits;
  };
  number.addEventListener('input', tidy);
  select.addEventListener('change', tidy);
  tidy();

  const error = h('div', { class: 'err', role: 'alert' });
  const labelEl = h('label', { htmlFor: (number.id = `phone${Math.random().toString(36).slice(2, 8)}`) }, label);
  const el = h('div', { class: 'field' }, labelEl, h('div', { class: 'phone-row' }, select, number), hint ? h('div', { class: 'muted small' }, hint) : null, error);
  const f = slot(el, number, error);

  return {
    ...f,
    get value() { return joinPhone(select.value, number.value); },
    problem() {
      const digits = number.value.replace(/\D+/g, '');
      if (!digits) return required ? `${label.replace(/ \(optional\)$/i, '')} is required.` : null;
      return phoneProblem(select.value, digits, { landline });
    },
  };
}
