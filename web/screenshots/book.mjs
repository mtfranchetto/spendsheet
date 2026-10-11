/**
 * book.mjs — an invented household with thirty months behind it, for pictures.
 *
 * The browser tests' book (`tests/book.mjs`) is built to carry one of each
 * thing the page draws differently, inside forty days. That is the right book
 * to test against and a poor one to photograph: every chart on it is a single
 * step, and the long view answers "the ledger holds 1 complete month" in nine
 * places. This one is the opposite trade — ordinary rows, and enough of them
 * that a rolling year, a year-on-year and a typical month all have something
 * to say.
 *
 * It starts from that same book as the Worker would send it, so the tabs, the
 * header rows, the seeded categories and the pending holds are the real ones,
 * and replaces three things: the ledger, the balances the ledger has to add up
 * to, and the consent that is six days from expiring — a warning that is the
 * first thing on the test book's Home and would be the first thing in the
 * README. It also keeps one pending hold of the two.
 *
 * **Nobody's data.** Every row is generated here from the lists below; the
 * merchants are high-street names and the amounts come from a seeded
 * generator, so two runs on the same day draw the same book.
 *
 * Dates are counted back from today on the book's calendar, because the page
 * cuts its windows on the real clock. A screenshot therefore shows the month
 * it was taken in.
 */

import { batch, bookToday } from '../e2e/worker.mjs';

const MONTHS_BACK = 30;

/** mulberry32: small, seeded, and the same on every machine. */
function generator(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ACCOUNT_IDS = { Revolut: 'acc-1', Fineco: 'acc-2', Wallet: 'w-1', Degiro: 'a-1' };

/** What the accounts hold today. The ledger below is what led here. */
const BALANCES = { Revolut: 1240.87, Fineco: 26480.55, Wallet: 85, Degiro: 31500 };

/** [account, category, subcategory, merchants, per month, least, most, labels] */
const EVERYDAY = [
  ['Revolut', 'Food & Drink', 'Groceries', ['COOP SUPERMERCATO VIA ROMA', 'ESSELUNGA SPA TORINO', 'CONAD CITY', 'LIDL ITALIA'], 8, 22, 96],
  ['Revolut', 'Food & Drink', 'Bars & Cafes', ['BAR CENTRALE', 'CAFFE VERGNANO', 'PASTICCERIA GHIGO'], 6, 1.3, 9],
  ['Revolut', 'Food & Drink', 'Restaurants', ['TRATTORIA DA GINO', 'PIZZERIA AL PORTICO', 'SUSHI KOI'], 3, 24, 72],
  ['Revolut', 'Food & Drink', 'Delivery', ['GLOVO', 'DELIVEROO'], 1, 14, 32],
  ['Revolut', 'Transport', 'Fuel', ['Q8 EASY', 'ENI STATION 4471'], 2, 42, 71],
  ['Revolut', 'Transport', 'Public transport', ['TRENITALIA', 'GTT TORINO'], 2, 3.4, 39],
  ['Revolut', 'Transport', 'Tolls & Parking', ['ADDEBITO UNIPOLMOVE', 'PARCHEGGIO ROMA'], 1, 4, 22],
  ['Fineco', 'Shopping', 'Clothing', ['DECATHLON', 'ZARA', 'UNIQLO'], 0.7, 25, 140],
  ['Revolut', 'Shopping', 'Books', ['LIBRERIA LUXEMBURG', 'FELTRINELLI'], 0.5, 12, 34],
  ['Fineco', 'Shopping', 'Home', ['IKEA COLLEGNO', 'LEROY MERLIN'], 0.4, 20, 160],
  ['Revolut', 'Health', 'Pharmacy', ['FARMACIA SAN MARCO'], 1, 6, 38],
  ['Revolut', 'Life & Entertainment', 'Cinema & Events', ['CINEMA MASSIMO', 'TICKETONE'], 0.8, 9, 58]
];

/** [day, account, category, subcategory, description, amount] — every month. */
const STANDING = [
  [1, 'Fineco', 'Housing', 'Rent', 'AFFITTO', -1050],
  [3, 'Revolut', 'Life & Entertainment', 'Streaming', 'SPOTIFY', -10.99],
  [5, 'Fineco', 'Health', 'Fitness', 'VIRGIN ACTIVE', -49],
  [7, 'Revolut', 'Life & Entertainment', 'Streaming', 'NETFLIX.COM', -14.99],
  [8, 'Fineco', 'Housing', 'Internet', 'FASTWEB', -27.95],
  [12, 'Fineco', 'Housing', 'Phone', 'ILIAD', -9.99]
];

/** Colder months cost more to light and heat; index is the calendar month, January first. */
const WINTER = [1.5, 1.4, 1.2, 1, 0.8, 0.7, 0.8, 0.7, 0.8, 1, 1.2, 1.5];

/** What Degiro was revalued by, oldest quarter first — a market, not a line. */
const REVALUED = [620, -380, 910, 1240, -760, 430, 1380, -290, 870, 1150];

/**
 * The household as `values.batchGet` would return it: the test book's tabs
 * with its own ledger, balances and consents.
 */
export function picturedBatch() {
  const random = generator(20240611);
  const between = (least, most) => Math.round((least + random() * (most - least)) * 100) / 100;
  const pick = (list) => list[Math.floor(random() * list.length)];

  const today = bookToday();
  const serial = (year, month, date) => Date.UTC(year, month - 1, date) / 86400000 + 25569;
  const todaySerial = serial(today.year, today.month, today.date);

  const rows = [];
  let count = 0;
  const add = (day, account, amount, description, category, subcategory, extra = {}) => {
    if (day > todaySerial) return null;
    const type = category === 'Transfer' ? 'transfer' : category === 'Income' ? 'income' : 'expense';
    const row = {
      uid: 'p-' + ++count, account_id: ACCOUNT_IDS[account], account_name: account,
      booking_date: day, transaction_date: day + (extra.time || 0), amount, amount_base: amount,
      currency: 'EUR', description, source: extra.source || 'enablebanking', imported_at: day,
      category, subcategory, type, in_reports: type !== 'transfer',
      confirmed: true, category_source: 'override', labels: extra.labels || '',
      transfer_group: extra.group || ''
    };
    rows.push(row);
    return row;
  };
  /** Both legs of one move, which is what makes it a transfer rather than a spend and an income. */
  const move = (day, from, to, amount, subcategory, there, back, source) => {
    const out = add(day, from, -amount, there, 'Transfer', subcategory);
    if (!out) return;
    out.transfer_group = 'tr:' + out.uid;
    add(day, to, amount, back, 'Transfer', subcategory, { group: out.transfer_group, source });
  };

  for (let back = MONTHS_BACK; back >= 0; back--) {
    const first = new Date(Date.UTC(today.year, today.month - 1 - back, 1));
    const year = first.getUTCFullYear();
    const month = first.getUTCMonth() + 1;
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const on = (date) => serial(year, month, Math.min(date, days));
    const someDay = () => on(1 + Math.floor(random() * days));

    for (const [date, account, category, subcategory, description, amount] of STANDING) {
      add(on(date), account, amount, description, category, subcategory);
    }
    add(on(27), 'Fineco', back > 14 ? 2650 : 2850, 'STIPENDIO', 'Income', 'Salary');
    if (month === 12) add(on(20), 'Fineco', 1500, 'TREDICESIMA', 'Income', 'Bonus');
    add(on(15), 'Fineco', -between(52, 74) * WINTER[month - 1], 'ENEL ENERGIA', 'Housing', 'Electricity');
    if (WINTER[month - 1] > 1) add(on(18), 'Fineco', -between(60, 95) * WINTER[month - 1], 'ENI PLENITUDE', 'Housing', 'Gas');
    if (month === 3) add(on(10), 'Fineco', -418, 'UNIPOLSAI ASSICURAZIONI', 'Insurance', 'Vehicle');

    move(on(2), 'Fineco', 'Revolut', 900, 'Between accounts', 'BONIFICO A REVOLUT', 'BONIFICO DA FINECO');
    move(on(9), 'Revolut', 'Wallet', 100, 'Cash withdrawal', 'PRELIEVO ATM VIA GARIBALDI', 'Transfer from Revolut', 'transfer-leg');
    for (const [what, subcategory] of [['Caffè e cornetto', 'Bars & Cafes'], ['Mercato di Porta Palazzo', 'Groceries'], ['Gelato', 'Bars & Cafes']]) {
      add(someDay(), 'Wallet', -between(3, 38), what, 'Food & Drink', subcategory, { source: 'manual', time: between(8, 19) / 24 });
    }

    for (const [account, category, subcategory, merchants, perMonth, least, most] of EVERYDAY) {
      const times = Math.floor(perMonth) + (random() < perMonth % 1 ? 1 : 0);
      for (let i = 0; i < times; i++) add(someDay(), account, -between(least, most), pick(merchants), category, subcategory);
    }

    if (month === 7) {
      add(on(4), 'Fineco', -between(180, 320), 'RYANAIR DUBLIN', 'Life & Entertainment', 'Flights', { labels: 'travel' });
      add(on(19), 'Fineco', -between(520, 780), 'BOOKING.COM AMSTERDAM', 'Life & Entertainment', 'Accommodation', { labels: 'travel' });
      for (let i = 0; i < 4; i++) add(on(19 + i), 'Revolut', -between(28, 84), 'RESTAURANTE O PESCADOR', 'Food & Drink', 'Restaurants', { labels: 'travel' });
    }
    if (month === 12) for (let i = 0; i < 3; i++) add(on(12 + 3 * i), 'Fineco', -between(35, 120), 'LA RINASCENTE', 'Shopping', 'Gifts');
    if (back % 3 === 1) add(on(28), 'Degiro', REVALUED[(MONTHS_BACK - back) / 3 | 0] ?? 500, 'Value updated', 'Transfer', 'Valuation change', { source: 'manual' });
  }

  // The last few days of card spending are the machine's guess, not yet agreed
  // with — which is what fills the review queue and takes the tick off a row.
  for (const row of rows) {
    if (row.booking_date > todaySerial - 4 && row.type === 'expense' && row.source === 'enablebanking') {
      row.confirmed = '';
      row.category_source = 'rule';
    }
  }
  rows.sort((a, b) => a.booking_date - b.booking_date);

  const base = batch();
  const edit = (entry, change) => {
    const [header, ...body] = entry.values;
    return { ...entry, values: [header, ...body.map((cells) => {
      const row = header.map((_, i) => cells[i] ?? '');
      for (const [name, value] of Object.entries(change(Object.fromEntries(header.map((h, i) => [h, row[i]]))))) {
        row[header.indexOf(name)] = value;
      }
      return row;
    })] };
  };

  const valueRanges = base.valueRanges.map((entry) => {
    if (/'transactions'/.test(entry.range)) {
      const header = entry.values[0];
      return { ...entry, values: [header, ...rows.map((row) => header.map((name) => row[name] ?? ''))] };
    }
    if (/'accounts'/.test(entry.range)) {
      return edit(entry, (account) => ({
        balance: BALANCES[account.name],
        ...(account.kind === 'bank' ? { balance_api: BALANCES[account.name] } : {}),
        ...(account.kind === 'asset' ? { balance_manual: BALANCES[account.name] } : {}),
        balance_updated_at: todaySerial
      }));
    }
    if (/'_status'/.test(entry.range)) {
      return edit(entry, () => ({ valid_until: todaySerial + 71, days_left: 71, last_success: todaySerial }));
    }
    // One hold says what a hold looks like; two push the first record off the screen.
    if (/'pending'/.test(entry.range)) return { ...entry, values: entry.values.slice(0, 2) };
    return entry;
  });
  return { valueRanges };
}
