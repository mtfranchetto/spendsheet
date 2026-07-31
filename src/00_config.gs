/**
 * 00_config.gs — tab names, column layouts, defaults and seed data.
 *
 * Apps Script has no module system: it concatenates source files in name
 * order, so everything here is a top-level global available to every later
 * file. That is also why the files are numbered — load order is explicit
 * rather than accidental, and this one has to be first.
 *
 * Nothing in this file touches SpreadsheetApp. It is pure data plus two
 * pure helpers, so the test harness can load it on its own.
 */

var TABS = {
  TRANSACTIONS: 'transactions',
  PENDING: 'pending',
  ACCOUNTS: 'accounts',
  RULES: 'rules',
  CATEGORIES: 'categories',
  RECURRING: 'recurring',
  CASHFLOW: 'cashflow',
  DASHBOARD: 'dashboard',
  CASH_ENTRY: 'cash_entry',
  ANOMALIES: '_anomalies',
  STATUS: '_status',
  RUNS: '_runs',
  CONFIG: '_config',
  IMPORT_MAP: '_import_map',
  CATEGORY_MAP: '_category_map',
  MEMORY: '_memory',
  IMPORT_RAW: '_import_raw',
  IMPORT_STAGED: '_import_staged',
  TESTS: '_tests'
};

/**
 * transactions — the record of truth. Append-only, booked rows only, and
 * never sorted (a partial sort silently destroys row identity and every
 * formula reference at once — the classic spreadsheet catastrophe).
 *
 * The core contract: columns A-O are written by code and by nothing else.
 * P onward belong to formulas and to you. Sync only ever appends; it never
 * rewrites a row. That is what makes manual corrections safe.
 */
var TX_COLUMNS_CODE = [
  'uid',                    // A  SHA-256, see 06_dedup
  'account_id',             // B
  'account_name',           // C
  'booking_date',           // D
  'value_date',             // E
  'transaction_date',       // F
  'amount',                 // G  signed: negative = money out
  'currency',               // H
  'description',            // I  remittance_information joined
  'counterparty',           // J
  'entry_reference',        // K  booked-only, absent at some banks
  'bank_transaction_code',  // L
  'mcc',                    // M  merchant_category_code
  'source',                 // N  enablebanking | csv:<name> | manual
  'imported_at'             // O
];

var TX_COLUMNS_DERIVED = [
  'amount_eur',             // P  every report reads THIS, never `amount`
  'category_auto',          // Q  formula, from rules
  'subcategory_auto',       // R  formula
  'category_source',        // S  which cascade tier decided it
  'category_override',      // T  you type here; code never touches it
  'category',               // U  formula: override if present, else auto
  'subcategory',            // V  formula
  'type',                   // W  expense | income | transfer
  'transfer_group',         // X
  'notes',                  // Y
  'excluded'                // Z
];

var TX_COLUMNS = TX_COLUMNS_CODE.concat(TX_COLUMNS_DERIVED);

/** pending is rewritten wholesale every sync, so nothing here is worth annotating. */
var PENDING_COLUMNS = TX_COLUMNS_CODE.slice();

/**
 * accounts — `balance_api`, `balance_manual` and `balance` are deliberately
 * three columns. No column is ever written by both code and a formula, which
 * is what lets you add a manual account by typing a row instead of running a
 * script.
 */
var ACCOUNT_COLUMNS = [
  'account_id',           // A
  'name',                 // B
  'kind',                 // C  bank | cash | asset
  'provider',             // D
  'iban_masked',          // E
  'currency',             // F
  'opening_balance',      // G
  'balance_api',          // H  code writes, bank rows only
  'balance_manual',       // I  you write, asset rows only
  'balance',              // J  ARRAYFORMULA over all three kinds
  'balance_type',         // K  which of CLBD/ITBD/... was used
  'balance_updated_at',   // L
  'balances_raw',         // M  full typed set, for debugging
  'include_in_net_worth', // N
  'active',               // O
  // Which _status connection covers this account. Appended rather than
  // slotted in next to `provider`, because inserting a column mid-schema
  // renames headers without moving the data underneath them.
  'connection_id'         // P
];

var RULE_COLUMNS = [
  'priority', 'field', 'match_type', 'pattern',
  'account_filter', 'category', 'subcategory', 'type', 'enabled'
];

var CATEGORY_COLUMNS = ['category', 'subcategory', 'kind', 'icon'];

var RECURRING_COLUMNS = [
  'key', 'account_id', 'category', 'avg_amount', 'cadence_days',
  'occurrences', 'last_seen', 'next_expected', 'confidence', 'active'
];

var CASHFLOW_COLUMNS = ['date', 'opening', 'expected_in', 'expected_out', 'closing'];

var CASH_ENTRY_COLUMNS = ['date', 'account', 'amount', 'category', 'note', 'processed'];

var ANOMALY_COLUMNS = ['detected_at', 'account_id', 'kind', 'detail', 'raw_json'];

var STATUS_COLUMNS = [
  'connection_id', 'provider', 'session_id', 'state', 'valid_until',
  'days_left', 'last_success', 'last_error', 'accounts_covered'
];

var RUN_COLUMNS = [
  'run_id', 'started_at', 'duration_ms', 'trigger',
  'accounts_attempted', 'accounts_ok', 'rows_fetched', 'rows_inserted',
  'rows_duplicate', 'result', 'message'
];

var CONFIG_COLUMNS = ['key', 'value', 'description'];
var IMPORT_MAP_COLUMNS = ['preset', 'source_header', 'target_column'];
var CATEGORY_MAP_COLUMNS = ['preset', 'source_category', 'category', 'subcategory'];
var MEMORY_COLUMNS = ['merchant_key', 'category', 'subcategory', 'hits', 'last_seen'];
var TEST_COLUMNS = ['run_at', 'suite', 'name', 'result', 'detail'];

/** Anomaly kinds. Things go here instead of being silently dropped. */
var ANOMALY_KIND = {
  DUP_ENTRY_REF: 'dup_entry_ref',      // same ref, different amount/date — provider bug
  AMOUNT_CHANGED: 'amount_changed',
  UNMAPPED_COLUMN: 'unmapped_column',
  NON_EUR: 'non_eur',                  // no rate yet, so amount_eur is blank not wrong
  MISSING_BALANCE: 'missing_balance',
  UNKNOWN_BALANCE_TYPE: 'unknown_balance_type',
  NO_ACCOUNTS: 'no_accounts',          // a session we cannot read accounts out of
  UNPARSEABLE_AMOUNT: 'unparseable_amount',
  TRUNCATED: 'truncated',              // paging cap hit: we did NOT fetch everything
  FETCH_FAILED: 'fetch_failed',
  RATE_LIMITED: 'rate_limited',
  RAW_DUMP: 'raw_dump'                 // deliberate capture, for working out a shape
};

/** Transaction statuses. Only BOOK is allowed into `transactions`. */
var TX_STATUS = { BOOKED: 'BOOK', PENDING: 'PDNG' };

/** Which way the money went. The amount itself is unsigned — see 07_transactions. */
var CREDIT_DEBIT = { CREDIT: 'CRDT', DEBIT: 'DBIT' };

/**
 * How a run was started. Recorded in `_runs` because "it broke" and "it broke
 * when *I* ran it" are different problems.
 */
var RUN_TRIGGER = { MANUAL: 'manual', SCHEDULED: 'scheduled' };

var RUN_RESULT = { OK: 'OK', PARTIAL: 'PARTIAL', FAIL: 'FAIL' };

/** Script Properties owned by the sync, kept apart from the EB_* credentials. */
var SYNC_PROP = {
  CALL_BUDGET: 'SYNC_CALL_BUDGET',   // {date, counts:{uid:n}} — see callsUsedToday_
  CASH_SEQUENCE: 'SYNC_CASH_SEQUENCE'  // only ever goes up — see computeCashUid
};

/** A cell holds 50,000 characters; leave headroom rather than losing the row. */
var MAX_CELL_CHARS = 45000;

/**
 * Nobody has this many accounts. A record landing below this row means an
 * append went astray rather than that you are unusually banked — the shape
 * of the bug that once hid an account at row 1001 while every run reported
 * success.
 */
var MAX_PLAUSIBLE_ACCOUNTS = 200;

/**
 * Balance preference order.
 *
 * The API returns MULTIPLE typed balances per account and each bank supports
 * only some of them, so a single `balance` column cannot be filled
 * unconditionally — we take the first available in this order and record
 * which one it was in `balance_type`.
 *
 * CLBD closing booked · ITBD interim booked · ITAV interim available
 * XPCD expected · VALU value-dated · FWAV forward available · OTHR other
 */
var BALANCE_PREFERENCE = ['CLBD', 'ITBD', 'ITAV', 'XPCD', 'VALU', 'FWAV', 'OTHR'];

/** Which cascade tier assigned a category. Recorded per row so "why is this Groceries?" is answerable. */
var CATEGORY_SOURCE = {
  OVERRIDE: 'override',
  TRANSFER: 'transfer',
  MEMORY: 'memory',
  MCC: 'mcc',
  RULE: 'rule',
  UNCLASSIFIED: 'unclassified'
};

var TX_TYPE = { EXPENSE: 'expense', INCOME: 'income', TRANSFER: 'transfer' };
var ACCOUNT_KIND = { BANK: 'bank', CASH: 'cash', ASSET: 'asset' };

/** Non-secret settings, seeded into _config. Secrets live in Script Properties. */
var DEFAULT_CONFIG = [
  ['base_currency', 'EUR', 'Reporting currency. Every report reads amount_eur.'],
  ['timezone', 'Europe/Rome', 'Used for date stamping.'],
  ['sync_window_days', 90, 'Days of history requested on a routine sync.'],
  ['stale_threshold_days', 2, 'selfCheck alerts if the last success is older than this.'],
  ['empty_run_threshold_days', 3, 'Alert after this many consecutive days of 0 rows.'],
  ['consent_warning_days', 7, 'Warn when a bank consent has fewer days left than this.'],
  ['alert_email', '', 'Leave blank to use the account owner address.'],
  ['fetch_pending', 'yes', 'Set to no per-account to save one API call/day.'],
  ['max_calls_per_account_per_day', 4, 'Most ASPSPs cap unattended fetching here.'],
  ['snapshot_folder', 'spendsheet-backups', 'Drive folder for weekly CSV snapshots.'],
  ['runs_to_keep', 500, '_runs is trimmed to this many rows.'],
  ['sync_hour', 4, 'Hour(s) 0-23 the sync runs. Comma-separate for more than one, e.g. 4,16.'],
  ['selfcheck_hour', 9, 'Hour (0-23) the self-check runs. After the sync, so it has something to check.'],
  ['snapshot_hour', 5, 'Hour (0-23) the weekly Drive snapshot runs, on Sundays.'],
  ['import_preset', 'budgetbakers', 'Which _import_map and _category_map rows to use.'],
  ['import_batch', 'import1', 'Goes in the uid of imported rows. Change it before importing a second file.']
];

/**
 * Default category taxonomy. Drives the dropdowns on `categories`, and
 * `kind` is what keeps transfers out of spending reports.
 */
var DEFAULT_CATEGORIES = [
  ['Income', 'Salary', 'income', '💰'],
  ['Income', 'Bonus', 'income', '💰'],
  ['Income', 'Refund', 'income', '↩️'],
  ['Income', 'Interest', 'income', '📈'],
  ['Income', 'Other income', 'income', '💰'],
  ['Housing', 'Rent', 'expense', '🏠'],
  ['Housing', 'Mortgage', 'expense', '🏠'],
  ['Housing', 'Maintenance', 'expense', '🔧'],
  ['Housing', 'Furniture', 'expense', '🛋️'],
  ['Bills & Utilities', 'Electricity', 'expense', '⚡'],
  ['Bills & Utilities', 'Gas', 'expense', '🔥'],
  ['Bills & Utilities', 'Water', 'expense', '💧'],
  ['Bills & Utilities', 'Internet', 'expense', '🌐'],
  ['Bills & Utilities', 'Phone', 'expense', '📱'],
  ['Bills & Utilities', 'Subscriptions', 'expense', '🔁'],
  ['Food & Drink', 'Groceries', 'expense', '🛒'],
  ['Food & Drink', 'Restaurants', 'expense', '🍽️'],
  ['Food & Drink', 'Bars & Cafes', 'expense', '☕'],
  ['Food & Drink', 'Delivery', 'expense', '🛵'],
  ['Transport', 'Fuel', 'expense', '⛽'],
  ['Transport', 'Public transport', 'expense', '🚆'],
  ['Transport', 'Taxi', 'expense', '🚕'],
  ['Transport', 'Tolls & Parking', 'expense', '🅿️'],
  ['Transport', 'Car maintenance', 'expense', '🔧'],
  ['Shopping', 'Clothing', 'expense', '👕'],
  ['Shopping', 'Electronics', 'expense', '💻'],
  ['Shopping', 'Home', 'expense', '🏡'],
  ['Shopping', 'Books', 'expense', '📚'],
  ['Shopping', 'Gifts', 'expense', '🎁'],
  ['Health', 'Pharmacy', 'expense', '💊'],
  ['Health', 'Doctor', 'expense', '🩺'],
  ['Health', 'Fitness', 'expense', '🏋️'],
  ['Health', 'Insurance', 'expense', '🛡️'],
  ['Entertainment', 'Cinema & Events', 'expense', '🎬'],
  ['Entertainment', 'Hobbies', 'expense', '🎨'],
  ['Entertainment', 'Streaming', 'expense', '📺'],
  ['Travel', 'Flights', 'expense', '✈️'],
  ['Travel', 'Accommodation', 'expense', '🏨'],
  ['Travel', 'Holiday', 'expense', '🏖️'],
  ['Education', 'Courses', 'expense', '🎓'],
  ['Education', 'Books', 'expense', '📖'],
  ['Fees & Taxes', 'Bank fees', 'expense', '🏦'],
  ['Fees & Taxes', 'Taxes', 'expense', '🧾'],
  ['Fees & Taxes', 'Interest paid', 'expense', '💸'],
  ['Transfer', 'Between accounts', 'transfer', '🔄'],
  ['Transfer', 'Cash withdrawal', 'transfer', '🏧'],
  ['Other', 'Uncategorised', 'expense', '❓']
];

/**
 * Seed rules, in priority order.
 *
 * MCC first (priority 10-99): a standardised numeric code, so it is
 * language-independent and cannot be broken by a bank rewording its
 * descriptors. Text patterns second (100+): a fallback for the banks that
 * do not populate MCC, which is most of them, inconsistently.
 *
 * Both sit BELOW learned memory in the cascade — see 07_categorize. These
 * are the cold-start; your own corrected history is the real signal.
 */
var DEFAULT_RULES = [
  // ---- MCC ----
  [10, 'mcc', 'equals', '5411', '', 'Food & Drink', 'Groceries', 'expense', true],
  [11, 'mcc', 'equals', '5412', '', 'Food & Drink', 'Groceries', 'expense', true],
  [12, 'mcc', 'equals', '5499', '', 'Food & Drink', 'Groceries', 'expense', true],
  [13, 'mcc', 'equals', '5310', '', 'Food & Drink', 'Groceries', 'expense', true],
  [14, 'mcc', 'equals', '5812', '', 'Food & Drink', 'Restaurants', 'expense', true],
  [15, 'mcc', 'equals', '5814', '', 'Food & Drink', 'Restaurants', 'expense', true],
  [16, 'mcc', 'equals', '5813', '', 'Food & Drink', 'Bars & Cafes', 'expense', true],
  [17, 'mcc', 'equals', '5921', '', 'Food & Drink', 'Bars & Cafes', 'expense', true],
  [20, 'mcc', 'equals', '5541', '', 'Transport', 'Fuel', 'expense', true],
  [21, 'mcc', 'equals', '5542', '', 'Transport', 'Fuel', 'expense', true],
  [22, 'mcc', 'equals', '4111', '', 'Transport', 'Public transport', 'expense', true],
  [23, 'mcc', 'equals', '4131', '', 'Transport', 'Public transport', 'expense', true],
  [24, 'mcc', 'equals', '4121', '', 'Transport', 'Taxi', 'expense', true],
  [25, 'mcc', 'equals', '7523', '', 'Transport', 'Tolls & Parking', 'expense', true],
  [30, 'mcc', 'equals', '4511', '', 'Travel', 'Flights', 'expense', true],
  [31, 'mcc', 'equals', '7011', '', 'Travel', 'Accommodation', 'expense', true],
  [32, 'mcc', 'equals', '4722', '', 'Travel', 'Holiday', 'expense', true],
  [40, 'mcc', 'equals', '5912', '', 'Health', 'Pharmacy', 'expense', true],
  [41, 'mcc', 'equals', '8011', '', 'Health', 'Doctor', 'expense', true],
  [42, 'mcc', 'equals', '8062', '', 'Health', 'Doctor', 'expense', true],
  [43, 'mcc', 'equals', '7997', '', 'Health', 'Fitness', 'expense', true],
  [44, 'mcc', 'equals', '6300', '', 'Health', 'Insurance', 'expense', true],
  [50, 'mcc', 'equals', '5651', '', 'Shopping', 'Clothing', 'expense', true],
  [51, 'mcc', 'equals', '5691', '', 'Shopping', 'Clothing', 'expense', true],
  [52, 'mcc', 'equals', '5732', '', 'Shopping', 'Electronics', 'expense', true],
  [53, 'mcc', 'equals', '5045', '', 'Shopping', 'Electronics', 'expense', true],
  [54, 'mcc', 'equals', '5942', '', 'Shopping', 'Books', 'expense', true],
  [55, 'mcc', 'equals', '5941', '', 'Entertainment', 'Hobbies', 'expense', true],
  [56, 'mcc', 'equals', '7230', '', 'Health', 'Fitness', 'expense', true],
  [60, 'mcc', 'equals', '7832', '', 'Entertainment', 'Cinema & Events', 'expense', true],
  [61, 'mcc', 'equals', '7922', '', 'Entertainment', 'Cinema & Events', 'expense', true],
  [70, 'mcc', 'equals', '4814', '', 'Bills & Utilities', 'Phone', 'expense', true],
  [71, 'mcc', 'equals', '4899', '', 'Bills & Utilities', 'Internet', 'expense', true],
  [72, 'mcc', 'equals', '4900', '', 'Bills & Utilities', 'Electricity', 'expense', true],
  [80, 'mcc', 'equals', '8220', '', 'Education', 'Courses', 'expense', true],
  [90, 'mcc', 'equals', '6011', '', 'Transfer', 'Cash withdrawal', 'transfer', true],

  // ---- Italian bank descriptors: operation types ----
  [100, 'description', 'contains', 'PRELIEVO', '', 'Transfer', 'Cash withdrawal', 'transfer', true],
  [101, 'description', 'contains', 'PRELEVAMENTO', '', 'Transfer', 'Cash withdrawal', 'transfer', true],
  [102, 'description', 'contains', 'GIROCONTO', '', 'Transfer', 'Between accounts', 'transfer', true],
  [103, 'description', 'contains', 'STIPENDIO', '', 'Income', 'Salary', 'income', true],
  [104, 'description', 'contains', 'EMOLUMENTI', '', 'Income', 'Salary', 'income', true],
  [105, 'description', 'contains', 'COMMISSIONI', '', 'Fees & Taxes', 'Bank fees', 'expense', true],
  [106, 'description', 'contains', 'IMPOSTA DI BOLLO', '', 'Fees & Taxes', 'Taxes', 'expense', true],
  [107, 'description', 'contains', 'CANONE MENSILE', '', 'Fees & Taxes', 'Bank fees', 'expense', true],
  [108, 'description', 'contains', 'F24', '', 'Fees & Taxes', 'Taxes', 'expense', true],
  [109, 'description', 'contains', 'BOLLO AUTO', '', 'Transport', 'Car maintenance', 'expense', true],
  [110, 'description', 'contains', 'MUTUO', '', 'Housing', 'Mortgage', 'expense', true],
  [111, 'description', 'contains', 'AFFITTO', '', 'Housing', 'Rent', 'expense', true],
  [112, 'description', 'contains', 'LOCAZIONE', '', 'Housing', 'Rent', 'expense', true],
  [113, 'description', 'contains', 'INPS', '', 'Fees & Taxes', 'Taxes', 'expense', true],
  [114, 'description', 'contains', 'ASSICURAZIONE', '', 'Health', 'Insurance', 'expense', true],

  // ---- Merchants: groceries ----
  [200, 'description', 'contains', 'ESSELUNGA', '', 'Food & Drink', 'Groceries', 'expense', true],
  [201, 'description', 'contains', 'CONAD', '', 'Food & Drink', 'Groceries', 'expense', true],
  [202, 'description', 'contains', 'COOP', '', 'Food & Drink', 'Groceries', 'expense', true],
  [203, 'description', 'contains', 'CARREFOUR', '', 'Food & Drink', 'Groceries', 'expense', true],
  [204, 'description', 'contains', 'LIDL', '', 'Food & Drink', 'Groceries', 'expense', true],
  [205, 'description', 'contains', 'EUROSPIN', '', 'Food & Drink', 'Groceries', 'expense', true],
  [206, 'description', 'contains', 'PENNY MARKET', '', 'Food & Drink', 'Groceries', 'expense', true],
  [207, 'description', 'contains', 'BENNET', '', 'Food & Drink', 'Groceries', 'expense', true],
  [208, 'description', 'contains', 'TIGROS', '', 'Food & Drink', 'Groceries', 'expense', true],
  [209, 'description', 'contains', 'PAM PANORAMA', '', 'Food & Drink', 'Groceries', 'expense', true],

  // ---- Merchants: utilities & telecom ----
  [220, 'description', 'contains', 'ENEL', '', 'Bills & Utilities', 'Electricity', 'expense', true],
  [221, 'description', 'contains', 'ENI ', '', 'Bills & Utilities', 'Gas', 'expense', true],
  [222, 'description', 'contains', 'HERA', '', 'Bills & Utilities', 'Gas', 'expense', true],
  [223, 'description', 'contains', 'A2A', '', 'Bills & Utilities', 'Electricity', 'expense', true],
  [224, 'description', 'contains', 'IREN', '', 'Bills & Utilities', 'Electricity', 'expense', true],
  [225, 'description', 'contains', 'ACEA', '', 'Bills & Utilities', 'Water', 'expense', true],
  [226, 'description', 'contains', 'SORGENIA', '', 'Bills & Utilities', 'Electricity', 'expense', true],
  [230, 'description', 'contains', 'VODAFONE', '', 'Bills & Utilities', 'Phone', 'expense', true],
  [231, 'description', 'contains', 'WINDTRE', '', 'Bills & Utilities', 'Phone', 'expense', true],
  [232, 'description', 'contains', 'ILIAD', '', 'Bills & Utilities', 'Phone', 'expense', true],
  [233, 'description', 'contains', 'FASTWEB', '', 'Bills & Utilities', 'Internet', 'expense', true],
  [234, 'description', 'contains', 'TIM S.P.A', '', 'Bills & Utilities', 'Phone', 'expense', true],

  // ---- Merchants: subscriptions ----
  [240, 'description', 'contains', 'NETFLIX', '', 'Entertainment', 'Streaming', 'expense', true],
  [241, 'description', 'contains', 'SPOTIFY', '', 'Entertainment', 'Streaming', 'expense', true],
  [242, 'description', 'contains', 'DISNEY', '', 'Entertainment', 'Streaming', 'expense', true],
  [243, 'description', 'contains', 'APPLE.COM/BILL', '', 'Bills & Utilities', 'Subscriptions', 'expense', true],
  [244, 'description', 'contains', 'GOOGLE *', '', 'Bills & Utilities', 'Subscriptions', 'expense', true],
  [245, 'description', 'contains', 'AMAZON PRIME', '', 'Bills & Utilities', 'Subscriptions', 'expense', true],

  // ---- Merchants: transport & travel ----
  [250, 'description', 'contains', 'TRENITALIA', '', 'Transport', 'Public transport', 'expense', true],
  [251, 'description', 'contains', 'ITALO', '', 'Transport', 'Public transport', 'expense', true],
  [252, 'description', 'contains', 'TELEPASS', '', 'Transport', 'Tolls & Parking', 'expense', true],
  [253, 'description', 'contains', 'AUTOSTRADE', '', 'Transport', 'Tolls & Parking', 'expense', true],
  [254, 'description', 'contains', 'Q8', '', 'Transport', 'Fuel', 'expense', true],
  [255, 'description', 'contains', 'TAMOIL', '', 'Transport', 'Fuel', 'expense', true],
  [256, 'description', 'contains', 'UBER', '', 'Transport', 'Taxi', 'expense', true],
  [257, 'description', 'contains', 'FREENOW', '', 'Transport', 'Taxi', 'expense', true],
  [260, 'description', 'contains', 'RYANAIR', '', 'Travel', 'Flights', 'expense', true],
  [261, 'description', 'contains', 'EASYJET', '', 'Travel', 'Flights', 'expense', true],
  [262, 'description', 'contains', 'BOOKING.COM', '', 'Travel', 'Accommodation', 'expense', true],
  [263, 'description', 'contains', 'AIRBNB', '', 'Travel', 'Accommodation', 'expense', true],

  // ---- Merchants: food delivery & retail ----
  [270, 'description', 'contains', 'GLOVO', '', 'Food & Drink', 'Delivery', 'expense', true],
  [271, 'description', 'contains', 'DELIVEROO', '', 'Food & Drink', 'Delivery', 'expense', true],
  [272, 'description', 'contains', 'JUST EAT', '', 'Food & Drink', 'Delivery', 'expense', true],
  [273, 'description', 'contains', 'MCDONALD', '', 'Food & Drink', 'Restaurants', 'expense', true],
  [274, 'description', 'contains', 'STARBUCKS', '', 'Food & Drink', 'Bars & Cafes', 'expense', true],
  [280, 'description', 'contains', 'AMAZON', '', 'Shopping', 'Home', 'expense', true],
  [281, 'description', 'contains', 'ZALANDO', '', 'Shopping', 'Clothing', 'expense', true],
  [282, 'description', 'contains', 'DECATHLON', '', 'Entertainment', 'Hobbies', 'expense', true],
  [283, 'description', 'contains', 'IKEA', '', 'Shopping', 'Home', 'expense', true],
  [284, 'description', 'contains', 'MEDIAWORLD', '', 'Shopping', 'Electronics', 'expense', true],
  [285, 'description', 'contains', 'UNIEURO', '', 'Shopping', 'Electronics', 'expense', true],
  [286, 'description', 'contains', 'FARMACIA', '', 'Health', 'Pharmacy', 'expense', true],
  [290, 'description', 'contains', 'SATISPAY', '', 'Other', 'Uncategorised', 'expense', true]
];

/**
 * BudgetBakers CSV column preset.
 *
 * Probed against a real export rather than guessed — their support page
 * refuses automated fetches, so the previous version of this table was
 * invention. Four of its nine rows were wrong.
 *
 * The file is **semicolon-delimited**, so File → Import needs the separator
 * set by hand. See docs/IMPORT.md.
 *
 * Deliberately unmapped, and why:
 *
 *   `ref_currency_amount`  the amount in your base currency. Identical to
 *                          `amount` on a single-currency export; the column to
 *                          reach for if you ever hold a non-EUR account.
 *   `payment_type`         the instrument — `Transfer` here means bank
 *                          transfer, NOT a move between your own accounts.
 *                          Easy to confuse with the `transfer` column, which
 *                          is the one that means that.
 *   `transfer`             a boolean, not a pair id. See 13_import.gs.
 *   `labels`               free-form tags, on a small minority of rows. Would
 *                          need a third paste block into `notes` to preserve,
 *                          which is not worth the chance of misaligning one.
 */
var DEFAULT_IMPORT_MAP = [
  ['budgetbakers', 'account', 'account_name'],
  ['budgetbakers', 'date', 'booking_date'],
  ['budgetbakers', 'amount', 'amount'],
  ['budgetbakers', 'type', 'type'],
  ['budgetbakers', 'currency', 'currency'],
  ['budgetbakers', 'note', 'description'],
  ['budgetbakers', 'payee', 'counterparty'],
  ['budgetbakers', 'category', 'category_override']
];

/** The value in the `type` column that means money out. */
var IMPORT_TYPE_EXPENSE = 'Expense';

/**
 * BudgetBakers categories mapped onto ours.
 *
 * Their taxonomy is single-level and ours is two, so this is where the extra
 * level is invented — and it is a starting point, not an answer. Editing this
 * tab is the supported way to disagree with it, and worth doing *before* the
 * import rather than after: these become `category_override`, which is the
 * training signal the whole categorisation cascade learns from. A category you
 * would not have chosen teaches the wrong thing about every future
 * transaction from that merchant.
 *
 * `Missing`, `Unknown expense` and `Services` land in Other/Uncategorised on
 * purpose. They carry no information, and inventing one for them would hide
 * rows that deserve a look in the needs-review queue.
 */
var DEFAULT_CATEGORY_MAP = [
  ['budgetbakers', 'Bar, cafe', 'Food & Drink', 'Bars & Cafes'],
  ['budgetbakers', 'Books, audio, subscriptions', 'Bills & Utilities', 'Subscriptions'],
  ['budgetbakers', 'Charges, Fees', 'Fees & Taxes', 'Bank fees'],
  ['budgetbakers', 'Child Support', 'Other', 'Uncategorised'],
  ['budgetbakers', 'Cleaning', 'Housing', 'Maintenance'],
  ['budgetbakers', 'Clothes & Footwear', 'Shopping', 'Clothing'],
  ['budgetbakers', 'Culture, sport events', 'Entertainment', 'Cinema & Events'],
  ['budgetbakers', 'Drug-store, chemist', 'Health', 'Pharmacy'],
  ['budgetbakers', 'Education, development', 'Education', 'Courses'],
  ['budgetbakers', 'Electronics, accessories', 'Shopping', 'Electronics'],
  ['budgetbakers', 'Energy, utilities', 'Bills & Utilities', 'Electricity'],
  ['budgetbakers', 'Food & Drinks', 'Food & Drink', 'Groceries'],
  ['budgetbakers', 'Fuel', 'Transport', 'Fuel'],
  ['budgetbakers', 'Gifts', 'Shopping', 'Gifts'],
  ['budgetbakers', 'Gifts, joy', 'Shopping', 'Gifts'],
  ['budgetbakers', 'Groceries', 'Food & Drink', 'Groceries'],
  ['budgetbakers', 'Health and beauty', 'Health', 'Doctor'],
  ['budgetbakers', 'Holiday, trips, hotels', 'Travel', 'Holiday'],
  ['budgetbakers', 'Home, garden', 'Shopping', 'Home'],
  ['budgetbakers', 'Insurances', 'Health', 'Insurance'],
  ['budgetbakers', 'Life & Entertainment', 'Entertainment', 'Hobbies'],
  ['budgetbakers', 'Missing', 'Other', 'Uncategorised'],
  ['budgetbakers', 'Mortgage', 'Housing', 'Mortgage'],
  ['budgetbakers', 'Parking', 'Transport', 'Tolls & Parking'],
  ['budgetbakers', 'Pizza', 'Food & Drink', 'Restaurants'],
  ['budgetbakers', 'Public transport', 'Transport', 'Public transport'],
  ['budgetbakers', 'Refunds (tax, purchase)', 'Income', 'Refund'],
  ['budgetbakers', 'Restaurant, fast-food', 'Food & Drink', 'Restaurants'],
  ['budgetbakers', 'Services', 'Other', 'Uncategorised'],
  ['budgetbakers', 'Software, apps, games', 'Bills & Utilities', 'Subscriptions'],
  ['budgetbakers', 'TV, Streaming', 'Entertainment', 'Streaming'],
  ['budgetbakers', 'Telephony, mobile phone', 'Bills & Utilities', 'Phone'],
  ['budgetbakers', 'Transfer, withdraw', 'Transfer', 'Between accounts'],
  ['budgetbakers', 'Unknown expense', 'Other', 'Uncategorised'],
  ['budgetbakers', 'Vehicle', 'Transport', 'Car maintenance'],
  ['budgetbakers', 'Wellness, beauty', 'Health', 'Fitness']
];

/** Column-letter helpers. Pure, so the harness tests them directly. */
function columnLetter(index1) {
  if (!(index1 >= 1)) throw new Error('columnLetter: 1-based index required, got ' + index1);
  var s = '';
  var n = Math.floor(index1);
  while (n > 0) {
    var rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Letter for a named column in a header array, e.g. colOf(TX_COLUMNS,'amount') === 'G'. */
function colOf(headers, name) {
  var i = headers.indexOf(name);
  if (i === -1) throw new Error('colOf: no column named "' + name + '"');
  return columnLetter(i + 1);
}
