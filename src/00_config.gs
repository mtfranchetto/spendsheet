/**
 * 00_config.gs — tab names, column layouts, defaults and seed data.
 *
 * Apps Script has no module system: it concatenates source files in name
 * order, so everything here is a top-level global available to every later
 * file. That is also why the files are numbered — load order is explicit
 * rather than accidental, and this one has to be first.
 *
 * Nothing in this file touches SpreadsheetApp. It is pure data plus three
 * pure helpers, so the test harness can load it on its own.
 */

var TABS = {
  TRANSACTIONS: 'transactions',
  PENDING: 'pending',
  ACCOUNTS: 'accounts',
  RULES: 'rules',
  CATEGORIES: 'categories',
  // Visible, and named without an underscore, because it is the same kind of
  // thing as `categories`: a small taxonomy you edit, feeding a column you type
  // into. It was originally specified as `_labels`; it also gained a spend
  // report, which is not something to hide behind a tab you must unhide first.
  LABELS: 'labels',
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
  // Where rows go when something deletes them from `transactions` — which one
  // thing does, and nothing else ever should. Same schema as `transactions`, so
  // putting a row back is a paste rather than a reconstruction.
  REMOVED: '_removed',
  // Dropdowns driving one QUERY. Visible and without an underscore because it
  // is a thing you use rather than machinery you ignore.
  REPORTS: 'reports',
  // The unconfirmed backlog, small enough to fit on one screen, with the two
  // cells that are yours next to each row. The only surface in this project
  // you can act on from a phone.
  REVIEW: 'review',
  // Where runSmokeTests() writes. Nothing here runs unattended.
  //
  // `dashboard` and `recent` were two more visible tabs and are gone: the app
  // answers both questions on a phone, and between them they were fifty
  // ARRAYFORMULA anchors — the single largest source of the failures this
  // project has spent sessions on. `git log -- src/16_dashboard.gs`.
  TESTS: '_tests'
};

/**
 * The three fills every tab uses to mean the same three things.
 *
 * Lived in `16_dashboard.gs` and outlived it: `cash_entry`, `reports` and
 * `review` all colour an input cell, and none of them is a dashboard. Kept
 * under the old name because renaming it would touch three files to say the
 * same thing — the comment is cheaper than the churn.
 */
var DASH_COLOR = {
  BAD: '#fce8e6',         // act now: consent expired, sync stopped
  WARN: '#fef7e0',        // act soon: consent lapsing, a backlog forming
  INPUT: '#e8f0fe'        // this cell is yours — type here, pick here
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
  'amount_base',            // P  every report reads THIS, never `amount`
  'category_auto',          // Q  formula, from rules
  'subcategory_auto',       // R  formula
  'category_source',        // S  which cascade tier decided it
  'category_override',      // T  you type here; code never touches it
  'category',               // U  formula: override if present, else auto
  'subcategory',            // V  formula
  'type',                   // W  expense | income | transfer
  'transfer_group',         // X
  'notes',                  // Y
  'excluded',               // Z
  // Cross-cutting and independent of category: a holiday is flights *and*
  // restaurants *and* a pharmacy, each of which means something else the rest
  // of the year. Comma-separated, yours to type, and never affects a total.
  // BudgetBakers exports these, so a history arrives already labelled.
  'labels',                 // AA
  // A guess you agreed with, and a guess, are not the same fact — and a sheet
  // that renders them identically teaches you to trust the guesses.
  //
  // Synced rows arrive blank. Imported rows arrive TRUE, because you already
  // categorised them once in the tool they came from. A row carrying a
  // `category_override` counts as confirmed without the tick: typing the
  // category is a stronger statement than ticking a box next to it, and
  // requiring both would mean an onEdit trigger for no extra information.
  //
  // The load-bearing consequence is in `learnFromCorrections`: memory is mined
  // from confirmed rows only. Learn from everything and the cascade trains on
  // its own output, where one wrong guess about a frequent merchant hardens
  // into the rule that generates more of the same.
  'confirmed',              // AB
  // Whether this row counts as spending. One place decides it; every report
  // reads the answer.
  //
  // `excluded` was a documented column that nothing you look at honoured —
  // only recurring detection did. Every dashboard block filtered
  // `type <> 'transfer'` and nothing else, so a row you had deliberately
  // excluded still counted in this month's spending, in the six-month trend
  // and in every label total. Six blocks each re-deciding what spending is,
  // and one of them wrong.
  //
  // A derived column rather than one more condition per query, because
  // `excluded` is blank on nearly every row and QUERY types a mostly-blank
  // column by majority and treats blanks as null: `where Z = false` would
  // drop nearly every row and blank the dashboard. A formula emitting a real
  // boolean on *every* row — including the ones with no transaction in them —
  // removes the null case, and the majority case, entirely. See
  // `inReportsFormula()` in 04_setup.gs for why the blank rows say FALSE
  // rather than "".
  'in_reports',             // AC
  // Setting `category_override` used to blank the subcategory outright: the
  // auto value belonged to a category you had just overruled, so keeping it
  // would have been worse. That left no way to say "Food & Drink, and it was
  // Groceries" — the correction you most often want to make is a *pair*, and
  // only half of it was expressible.
  //
  // Appended after `in_reports` rather than slotted next to `category_override`
  // where it reads better. Inserting mid-schema renames every header to its
  // right without moving the data underneath them, which is the one edit this
  // tab can never survive.
  'subcategory_override'    // AD
];

var TX_COLUMNS = TX_COLUMNS_CODE.concat(TX_COLUMNS_DERIVED);

/**
 * review — the unconfirmed backlog, refilled by a run and cleared by you.
 *
 * `uid` is what makes the write-back possible and is the one column here that
 * is not for reading: a review row is a *pointer* at a transaction, so the tab
 * can be rebuilt from scratch without losing the connection to what it
 * describes.
 *
 * `confirmed`, `category_override` and `subcategory_override` are yours.
 * Everything else is a copy, and a copy going stale costs nothing because the
 * tab is rewritten rather than maintained.
 *
 * `subcategory_override` is the one you normally touch. A subcategory names
 * its parent, so picking `Groceries` sets the category to `Food & Drink` on
 * its own — correcting a row is one choice, not two. `category_override` stays
 * for the case the pair cannot express: a row that belongs to a parent and to
 * none of its children in particular.
 *
 * Inserted mid-list rather than appended, which is safe *here* and nowhere
 * else: this tab is rebuilt wholesale from `transactions` on every refresh, so
 * no row survives a schema change to be misaligned by one.
 */
var REVIEW_COLUMNS = [
  'uid',                 // A  hidden; the write-back key
  'booking_date',        // B
  'account_name',        // C
  'description',         // D
  'amount_base',         // E
  'guess',               // F  what the cascade decided
  'why',                 // G  which tier decided it
  'confirmed',              // H  yours — a checkbox
  'category_override',      // I  yours — a dropdown
  'subcategory_override',   // J  yours — a dropdown, and the one to reach for
  'status'                  // K  written by the trigger, so a phone gets feedback
];

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
  'connection_id',        // P
  // Enable Banking mints a new account uid for every consent — observed on
  // Revolut, illimity and Fineco, so it is how the API works rather than one
  // bank's quirk. Keying on it duplicated the account row at every reconnect
  // and, worse, changed every transaction's hash.
  //
  // `identity_hash` is the provider's own `identification_hash`, which covers
  // [["account","account_id","iban"],["account","currency"]] and survives a
  // new consent. It is the match key. Deliberately NOT
  // `identification_hashes[0]`, which is the IBAN alone and is identical
  // across Fineco's four currency pockets.
  //
  // `account_id` stays whatever it was the first time we saw the account and
  // is never rewritten, so stored transaction uids remain valid forever.
  'identity_hash',        // Q  stable across consents; how a returning account is recognised
  'provider_account_id'   // R  the current per-consent uid, what the API is called with
];

var RULE_COLUMNS = [
  'priority', 'field', 'match_type', 'pattern',
  'account_filter', 'category', 'subcategory', 'type', 'enabled'
];

/**
 * `parent_list` is derived, and exists to be pointed at by a dropdown.
 *
 * Column A repeats a parent once per subcategory — twelve `Housing` rows, eight
 * `Income` — so a validation rule reading A2:A offers seventy-odd entries most
 * of which are duplicates. That is not a list you pick from, it is a list you
 * give up on, and the cost was real: `Transfer` is in there, and the way you
 * mark a transfer is to choose it, and it was unfindable.
 *
 * A column rather than a `requireValueInList` built in code, so that adding a
 * category to the tab updates every dropdown at once instead of on the next
 * `setup()`.
 *
 * `child_list` is the same trick for subcategories. Sheets has no dependent
 * dropdown without code behind it, so this offers every subcategory rather
 * than only the chosen parent's — which is still the difference between
 * picking from a list and remembering whether you called it `Groceries` or
 * `Grocery`. A misspelling here is not caught by anything: it becomes a
 * subcategory with one transaction against it, sitting next to the real one.
 */
/**
 * categories — the taxonomy, plus the derived columns the dropdowns point at.
 *
 * `child_key` and `child_parent` are a reversed copy of `subcategory` and
 * `category`, and they exist for one reason: VLOOKUP cannot look left, and
 * INDEX/MATCH does not vectorise inside an ARRAYFORMULA. Picking a subcategory
 * has to name its parent, and this is the only pair of columns a single
 * vectorised lookup can cross.
 *
 * Which makes a subcategory's name load-bearing: it must identify exactly one
 * parent. `child_list` was already a SORTED UNIQUE list, so two parents sharing
 * a child name have always collapsed to one indistinguishable dropdown entry —
 * `Insurance > Home` and `Shopping > Home` were one choice, and the seed had
 * two such pairs. Both were renamed rather than disambiguated at lookup time,
 * because "which Home did you mean" is not a question a dropdown can ask.
 * `tests/categorize.test.mjs` fails on a duplicate, and so does a smoke test,
 * because the tab is yours to extend.
 */
/**
 * A–D are stored: seeded once, then yours. E–H are four ARRAYFORMULA anchors.
 *
 * Split apart for the same reason `transactions` splits at O — anything that
 * rewrites this tab wholesale must confine itself to the stored half. It didn't:
 * `removeRetiredCategories_` cleared the full width and wrote the records back
 * the same width, which erased four anchors and stored their own spill on top of
 * where they would have expanded. The tab survives a `setFormula_` afterwards
 * and still cannot spill, so the repair is a sheet edit, not a re-run.
 */
var CATEGORY_COLUMNS_STORED = [
  'category',      // A
  'subcategory',   // B
  'kind',          // C
  'icon'           // D
];

var CATEGORY_COLUMNS_DERIVED = [
  'parent_list',   // E  UNIQUE(category), seed order
  'child_list',    // F  SORTED(UNIQUE(subcategory))
  'child_key',     // G  = subcategory, so a lookup can start here
  'child_parent'   // H  = category, the answer that lookup returns
];

var CATEGORY_COLUMNS = CATEGORY_COLUMNS_STORED.concat(CATEGORY_COLUMNS_DERIVED);

/**
 * labels — the cross-cutting axis a category cannot express.
 *
 * `category` answers *what did I buy*; a label answers *what was this for*.
 * A holiday is flights and restaurants and a pharmacy, each of which means
 * something else the rest of the year, so the two are genuinely independent
 * and neither can be derived from the other.
 *
 * `transactions` and `total_eur` are formulas over `transactions.labels`, so
 * this tab is both the known set and the report on it. Nothing here ever
 * affects a category, a type or a total — the moment a label changes a number,
 * two systems own the same fact.
 */
var LABEL_COLUMNS = ['label', 'description', 'transactions', 'total_eur'];

/**
 * cash_entry — the one tab whose column *order* is not a contract.
 *
 * Everything else in this book is append-only or rewritten wholesale from a
 * fixed schema, so moving a column would rename a header without moving the
 * data under it. This tab holds one row you are in the middle of typing, and
 * clears it seconds later, so the order is free to be the order you fill it in.
 * `processed` sits last and hidden because it is machinery.
 */
var CASH_ENTRY_COLUMNS = [
  'date', 'account', 'amount', 'category', 'subcategory', 'note', 'labels', 'processed'
];

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
  NON_BASE: 'non_base',                  // no rate yet, so amount_base is blank not wrong
  MISSING_BALANCE: 'missing_balance',
  UNKNOWN_BALANCE_TYPE: 'unknown_balance_type',
  NO_ACCOUNTS: 'no_accounts',          // a session we cannot read accounts out of
  UNPARSEABLE_AMOUNT: 'unparseable_amount',
  TRUNCATED: 'truncated',              // paging cap hit: we did NOT fetch everything
  FETCH_FAILED: 'fetch_failed',
  RATE_LIMITED: 'rate_limited',
  CONSENT_DIED: 'consent_died',        // 401 before valid_until — needs you, not a retry
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

/**
 * The closed vocabularies, named once so a dropdown and the code that reads it
 * cannot be two different lists.
 *
 * A validation list written out at the point it is applied is a second copy,
 * and the way a second copy drifts is that the sheet cheerfully offers a value
 * nothing understands — which then fails as "the rule just doesn't match",
 * with no error anywhere. `tests/categorize.test.mjs` asserts that every entry
 * here is one the cascade actually honours, which is the only way a list and
 * its reader stay in step without a person remembering.
 *
 * `TX_TYPES` is the same three values `TX_TYPE` holds. Both exist because one
 * is how code refers to a single value and the other is what a dropdown needs,
 * and deriving the array from the object at every call site reads worse than
 * this does.
 */
var TX_TYPES = [TX_TYPE.EXPENSE, TX_TYPE.INCOME, TX_TYPE.TRANSFER];
var ACCOUNT_KINDS = [ACCOUNT_KIND.BANK, ACCOUNT_KIND.CASH, ACCOUNT_KIND.ASSET];

/** What a rule can look at. Anything else, and `ruleField_` returns null. */
var RULE_FIELDS = ['description', 'counterparty', 'mcc', 'bank_transaction_code'];

/** How it looks. `contains` is the fallback, so it is listed first. */
var RULE_MATCH_TYPES = ['contains', 'equals', 'starts_with', 'regex'];

/** Non-secret settings, seeded into _config. Secrets live in Script Properties. */
var DEFAULT_CONFIG = [
  ['base_currency', 'EUR', 'Reporting currency. Sets which rows get an amount_base, and every symbol shown.'],
  ['timezone', 'Europe/Rome', 'Used for date stamping.'],
  ['sync_window_days', 90, 'Days of history requested on a routine sync.'],
  ['stale_threshold_days', 2, 'selfCheck alerts if the last success is older than this.'],
  ['empty_run_threshold_days', 3, 'Alert after this many consecutive days of 0 rows.'],
  ['consent_warning_days', 7, 'Warn when a bank consent has fewer days left than this.'],
  ['stale_balance_days', 3, 'Colour an account on the dashboard when its balance is older than this.'],
  ['alert_email', '', 'Leave blank to use the account owner address.'],
  ['fetch_pending', 'yes', 'Set to no per-account to save one API call/day.'],
  ['max_calls_per_account_per_day', 4, 'Most ASPSPs cap unattended fetching here.'],
  ['snapshot_folder', 'spendsheet-backups', 'Drive folder for weekly CSV snapshots.'],
  ['runs_to_keep', 500, '_runs is trimmed to this many rows.'],
  ['sync_hour', 4, 'Hour(s) 0-23 the sync runs. Comma-separate for more than one, e.g. 4,16.'],
  ['selfcheck_hour', 9, 'Hour (0-23) the self-check runs. After the sync, so it has something to check.'],
  ['snapshot_hour', 5, 'Hour (0-23) the weekly Drive snapshot runs, on Sundays.'],
  ['import_preset', 'budgetbakers', 'Which _import_map and _category_map rows to use.'],
  ['import_batch', 'import1', 'Goes in the uid of imported rows. Change it before importing a second file.'],
  ['transfer_window_days', 4, 'How far apart the two legs of one transfer may be booked.'],
  ['duplicate_window_days', 3, 'How far apart an imported row and a synced one may be booked and still be the same transaction.'],
  ['categorize_on_sync', 'yes', 'Categorise freshly synced rows as they land. Set to no to only run it by hand.'],
  // Where learned memory is offered in the one ordered list `rules` and
  // `_memory` share. 5 is below the seed's lowest rule, so your own history
  // decides before any pattern; a value above the highest priority on the tab
  // makes every rule win instead. Deliberately not 0: `Number('')` is 0, so a
  // zero default and a cleared cell would be the same reading and no test could
  // tell the guard in `configNumber_` from its absence.
  ['memory_priority', 5, 'Where learned memory sits among the rules. Lower matches first; seed rules start at 10.'],
  // `cashflow_horizon_days`, `trend_days` and `confirm_rule_matches` went from
  // here with the code that read them — the cashflow projection in
  // `15_recurring.gs`, the net worth chart on the old `dashboard` tab, and the
  // rules-tab auto-confirm in `14_categorize.gs`. A dead constant is invisible;
  // a dead *config row* is not, because it sits on a tab the owner reads with a
  // description promising an effect it has not had since that code went.
  //
  // Books set up before this keep those rows, and that is the right outcome
  // rather than an oversight: `setup()` cannot tell a row you deleted from one
  // you never had, and `reportSeedDivergence_` walks the seed rather than the
  // sheet, so a row the seed no longer names is simply not looked at. They are
  // inert, they are three, and removing them by hand is a sheet edit — not
  // worth a migration, unlike the category renames `RETIRED_CATEGORIES` exists
  // for.
  ['review_queue_size', 50, 'Most rows the review tab holds at once. Oldest first.'],
  // Blank here and filled by setup() from the account running it, because this
  // file touches no services. It is the lock on the mobile web app: one
  // deployment of this project is anonymous by necessity (the bank's redirect
  // carries no Google session) and both deployments run the same doGet, so the
  // app branch checks the caller against this. Blank means refuse everyone —
  // see webAppAccessDecision_ in 20_webapp.gs for why it fails closed.
  ['owner_email', '', 'Who may open the mobile web app. Comma-separate to share it — see docs/SHARING.md. Filled by Setup sheet. Blank refuses everyone.'],
  // Stored rather than detected. `ScriptApp.getService().getUrl()` answers for
  // the context it is called from, so from the menu it returns the HEAD
  // deployment — neither of the two real doors. Paste the Viewer's /exec URL
  // here once and "Open the app" knows where to send you.
  ['viewer_url', '', 'The mobile app deployment URL (Deploy → Manage deployments → Viewer).'],
  // This project's own icon, served by GitHub off this repo — which is why it
  // is a default rather than the question it started as. Google fetches this
  // URL server-side and anonymously, so **it only works once the repo is
  // public**: a private repo answers a raw URL with 404, and a favicon that
  // fails to load reports nothing anywhere. That is the whole failure mode, and
  // it looks identical to the setting having no effect.
  //
  // Point it at your own fork, or anywhere else, by editing the cell. `main` is
  // in the path deliberately — a tag would freeze the icon, and this is
  // decoration, so following the branch is the cheaper mistake.
  ['favicon_url',
    'https://raw.githubusercontent.com/mtfranchetto/spendsheet/main/docs/assets/spendsheet-icon.png',
    'Public HTTPS image for the app’s browser tab. Must be reachable without signing in.']
];

/**
 * Example labels, seeded once so the tab shows the shape rather than an empty
 * grid — replace them with your own.
 *
 * Deliberately absent from UPGRADABLE_SEEDS: a label you deleted is a label you
 * decided against, and re-adding it on every upgrade is the behaviour `rules`
 * is excluded for. A missing category is a gap; a resurrected label is an
 * argument.
 */
var DEFAULT_LABELS = [
  ['kids', 'Spending on the children — cuts across shopping, health and education.'],
  ['travel', 'One trip, all of its categories.'],
  ['home-renovation', 'A project with an end date, spanning furniture, maintenance and tools.']
];

/**
 * Categories that used to exist, and what each became.
 *
 * `setup()` adds seed rows and never removes them, which is the right default —
 * it cannot tell a row you deleted from one you never had. The cost is that a
 * taxonomy change leaves the old parents sitting in `categories` forever,
 * offered by every dropdown, quietly inviting their own reintroduction.
 *
 * So the retirements are recorded rather than inferred. Keyed on the full
 * category/subcategory pair because that is what makes each one unambiguous:
 * `Family` alone cannot be resolved — its children went to two different
 * parents — while `Family / Kids` maps exactly. `tidyCategories()` in
 * 04_setup.gs is what applies this, and it repoints references before removing
 * anything.
 *
 * **Renaming a seed subcategory belongs here too**, and that is less obvious
 * than retiring a parent. `setup()` appends the new name and keeps the old one,
 * so a rename leaves the tab holding *both* — which for the two renamed to
 * break a duplicate child name is the exact collision the rename was for. It
 * shipped that way: the seed changed, the live book gained `Home insurance`
 * beside `Home`, and the smoke test went on failing with nothing in the code to
 * fix. A rename is a migration, and this list is where a migration is written.
 */
var RETIRED_CATEGORIES = [
  { category: 'Bills & Utilities', subcategory: 'Electricity', to: ['Housing', 'Electricity'] },
  { category: 'Bills & Utilities', subcategory: 'Gas', to: ['Housing', 'Gas'] },
  { category: 'Bills & Utilities', subcategory: 'Water', to: ['Housing', 'Water'] },
  { category: 'Bills & Utilities', subcategory: 'Internet', to: ['Housing', 'Internet'] },
  { category: 'Bills & Utilities', subcategory: 'Phone', to: ['Housing', 'Phone'] },
  { category: 'Bills & Utilities', subcategory: 'Subscriptions', to: ['Housing', 'Subscriptions'] },
  { category: 'Bills & Utilities', subcategory: 'Other bills', to: ['Housing', 'Other bills'] },
  { category: 'Family', subcategory: 'Kids', to: ['Shopping', 'Kids'] },
  { category: 'Family', subcategory: 'Life events', to: ['Life & Entertainment', 'Life events'] },
  { category: 'Travel', subcategory: 'Flights', to: ['Life & Entertainment', 'Flights'] },
  { category: 'Travel', subcategory: 'Accommodation', to: ['Life & Entertainment', 'Accommodation'] },
  { category: 'Travel', subcategory: 'Holiday', to: ['Life & Entertainment', 'Holiday'] },
  // Renames, not moves: the parent is staying exactly where it is. Both existed
  // only to stop a child name naming two parents.
  { category: 'Insurance', subcategory: 'Home', to: ['Insurance', 'Home insurance'] },
  { category: 'Education', subcategory: 'Books', to: ['Education', 'Textbooks'] },
  // Renaming a *parent* is written out one child at a time, because the list is
  // keyed on the pair and there is nowhere else to say it. Every child keeps its
  // own name, so `childRenames_` correctly finds nothing new here — the only
  // thing that moved is the parent, and `retiredParents_` picks it up because
  // `Entertainment` has left DEFAULT_CATEGORIES. All seven agree, so a bare
  // `category_override` saying `Entertainment` is rewritten without asking.
  //
  // The `Travel` and `Family / Life events` rows above point at the new name
  // rather than at `Entertainment`, and have to: the tidy resolves a pair once
  // and does not chase the answer through a second retirement, so a book that
  // never tidied would otherwise land on a parent this list has just retired.
  { category: 'Entertainment', subcategory: 'Cinema & Events', to: ['Life & Entertainment', 'Cinema & Events'] },
  { category: 'Entertainment', subcategory: 'Hobbies', to: ['Life & Entertainment', 'Hobbies'] },
  { category: 'Entertainment', subcategory: 'Streaming', to: ['Life & Entertainment', 'Streaming'] },
  { category: 'Entertainment', subcategory: 'Life events', to: ['Life & Entertainment', 'Life events'] },
  { category: 'Entertainment', subcategory: 'Flights', to: ['Life & Entertainment', 'Flights'] },
  { category: 'Entertainment', subcategory: 'Accommodation', to: ['Life & Entertainment', 'Accommodation'] },
  { category: 'Entertainment', subcategory: 'Holiday', to: ['Life & Entertainment', 'Holiday'] }
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
  ['Income', 'Rent received', 'income', '🏘️'],
  ['Income', 'Child support', 'income', '👶'],
  ['Income', 'Gifts received', 'income', '🎁'],
  ['Income', 'Other income', 'income', '💰'],
  // Bills live here rather than under their own parent. Utilities, rent and
  // maintenance are all "what the home costs", and splitting them meant the
  // one number worth watching had to be added up from two places.
  ['Housing', 'Rent', 'expense', '🏠'],
  ['Housing', 'Mortgage', 'expense', '🏠'],
  ['Housing', 'Maintenance', 'expense', '🔧'],
  ['Housing', 'Furniture', 'expense', '🛋️'],
  ['Housing', 'Electricity', 'expense', '⚡'],
  ['Housing', 'Gas', 'expense', '🔥'],
  ['Housing', 'Water', 'expense', '💧'],
  ['Housing', 'Internet', 'expense', '🌐'],
  ['Housing', 'Phone', 'expense', '📱'],
  ['Housing', 'Subscriptions', 'expense', '🔁'],
  ['Housing', 'Other bills', 'expense', '🧾'],
  ['Housing', 'Other housing', 'expense', '🏠'],
  ['Food & Drink', 'Groceries', 'expense', '🛒'],
  ['Food & Drink', 'Restaurants', 'expense', '🍽️'],
  ['Food & Drink', 'Bars & Cafes', 'expense', '☕'],
  ['Food & Drink', 'Delivery', 'expense', '🛵'],
  ['Food & Drink', 'Alcohol & Tobacco', 'expense', '🍷'],
  ['Food & Drink', 'Other food & drink', 'expense', '🍴'],
  ['Transport', 'Fuel', 'expense', '⛽'],
  ['Transport', 'Public transport', 'expense', '🚆'],
  ['Transport', 'Taxi', 'expense', '🚕'],
  ['Transport', 'Tolls & Parking', 'expense', '🅿️'],
  ['Transport', 'Car maintenance', 'expense', '🔧'],
  ['Transport', 'Other transport', 'expense', '🚗'],
  ['Shopping', 'Clothing', 'expense', '👕'],
  ['Shopping', 'Electronics', 'expense', '💻'],
  ['Shopping', 'Home', 'expense', '🏡'],
  ['Shopping', 'Books', 'expense', '📚'],
  ['Shopping', 'Gifts', 'expense', '🎁'],
  ['Shopping', 'Kids', 'expense', '🧸'],
  ['Shopping', 'Other shopping', 'expense', '🛍️'],
  ['Health', 'Pharmacy', 'expense', '💊'],
  ['Health', 'Doctor', 'expense', '🩺'],
  ['Health', 'Fitness', 'expense', '🏋️'],
  ['Health', 'Personal care', 'expense', '💅'],
  // Travel folded in, and `Family` retired. Both were parents whose children
  // were better described by where the money actually went: a holiday is
  // leisure, a life event is leisure, and children's spending is shopping.
  // The `labels` column is what recovers a cross-cutting view of a trip —
  // that is the axis a category cannot express, which is why it exists.
  ['Life & Entertainment', 'Cinema & Events', 'expense', '🎬'],
  ['Life & Entertainment', 'Hobbies', 'expense', '🎨'],
  ['Life & Entertainment', 'Streaming', 'expense', '📺'],
  ['Life & Entertainment', 'Life events', 'expense', '🎉'],
  ['Life & Entertainment', 'Flights', 'expense', '✈️'],
  ['Life & Entertainment', 'Accommodation', 'expense', '🏨'],
  ['Life & Entertainment', 'Holiday', 'expense', '🏖️'],
  ['Education', 'Courses', 'expense', '🎓'],
  ['Education', 'Textbooks', 'expense', '📖'],
  // Insurance is its own parent rather than a child of Health. Home and
  // vehicle cover are the bulk of it for most people, and filing those under
  // Health inflates a category you read as "am I spending more on being ill".
  ['Insurance', 'Home insurance', 'expense', '🛡️'],
  ['Insurance', 'Vehicle', 'expense', '🛡️'],
  ['Insurance', 'Health', 'expense', '🛡️'],
  ['Insurance', 'Other insurance', 'expense', '🛡️'],
  ['Fees & Taxes', 'Bank fees', 'expense', '🏦'],
  ['Fees & Taxes', 'Taxes', 'expense', '🧾'],
  ['Fees & Taxes', 'Professional fees', 'expense', '📄'],
  ['Fees & Taxes', 'Fines', 'expense', '🚨'],
  ['Fees & Taxes', 'Interest paid', 'expense', '💸'],
  ['Transfer', 'Between accounts', 'transfer', '🔄'],
  ['Transfer', 'Cash withdrawal', 'transfer', '🏧'],
  // What an `asset` account's value moving is recorded as. Setting a new
  // balance on an investment account writes the *difference* as a transaction,
  // which is what makes the balance formula and the net-worth curve able to see
  // it at all — see `accountBalanceFormula`. `kind: transfer` is the load-
  // bearing part: a €1,500 market gain moves your net worth and is emphatically
  // not income this month, and `in_reports` excludes transfers from every total.
  ['Transfer', 'Valuation change', 'transfer', '📈'],
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
  [30, 'mcc', 'equals', '4511', '', 'Life & Entertainment', 'Flights', 'expense', true],
  [31, 'mcc', 'equals', '7011', '', 'Life & Entertainment', 'Accommodation', 'expense', true],
  [32, 'mcc', 'equals', '4722', '', 'Life & Entertainment', 'Holiday', 'expense', true],
  [40, 'mcc', 'equals', '5912', '', 'Health', 'Pharmacy', 'expense', true],
  [41, 'mcc', 'equals', '8011', '', 'Health', 'Doctor', 'expense', true],
  [42, 'mcc', 'equals', '8062', '', 'Health', 'Doctor', 'expense', true],
  [43, 'mcc', 'equals', '7997', '', 'Health', 'Fitness', 'expense', true],
  [44, 'mcc', 'equals', '6300', '', 'Insurance', 'Other insurance', 'expense', true],
  [50, 'mcc', 'equals', '5651', '', 'Shopping', 'Clothing', 'expense', true],
  [51, 'mcc', 'equals', '5691', '', 'Shopping', 'Clothing', 'expense', true],
  [52, 'mcc', 'equals', '5732', '', 'Shopping', 'Electronics', 'expense', true],
  [53, 'mcc', 'equals', '5045', '', 'Shopping', 'Electronics', 'expense', true],
  [54, 'mcc', 'equals', '5942', '', 'Shopping', 'Books', 'expense', true],
  [55, 'mcc', 'equals', '5941', '', 'Life & Entertainment', 'Hobbies', 'expense', true],
  [56, 'mcc', 'equals', '7230', '', 'Health', 'Fitness', 'expense', true],
  [60, 'mcc', 'equals', '7832', '', 'Life & Entertainment', 'Cinema & Events', 'expense', true],
  [61, 'mcc', 'equals', '7922', '', 'Life & Entertainment', 'Cinema & Events', 'expense', true],
  [70, 'mcc', 'equals', '4814', '', 'Housing', 'Phone', 'expense', true],
  [71, 'mcc', 'equals', '4899', '', 'Housing', 'Internet', 'expense', true],
  [72, 'mcc', 'equals', '4900', '', 'Housing', 'Electricity', 'expense', true],
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
  [114, 'description', 'contains', 'ASSICURAZIONE', '', 'Insurance', 'Other insurance', 'expense', true],

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
  [220, 'description', 'contains', 'ENEL', '', 'Housing', 'Electricity', 'expense', true],
  [221, 'description', 'contains', 'ENI ', '', 'Housing', 'Gas', 'expense', true],
  [222, 'description', 'contains', 'HERA', '', 'Housing', 'Gas', 'expense', true],
  [223, 'description', 'contains', 'A2A', '', 'Housing', 'Electricity', 'expense', true],
  [224, 'description', 'contains', 'IREN', '', 'Housing', 'Electricity', 'expense', true],
  [225, 'description', 'contains', 'ACEA', '', 'Housing', 'Water', 'expense', true],
  [226, 'description', 'contains', 'SORGENIA', '', 'Housing', 'Electricity', 'expense', true],
  [230, 'description', 'contains', 'VODAFONE', '', 'Housing', 'Phone', 'expense', true],
  [231, 'description', 'contains', 'WINDTRE', '', 'Housing', 'Phone', 'expense', true],
  [232, 'description', 'contains', 'ILIAD', '', 'Housing', 'Phone', 'expense', true],
  [233, 'description', 'contains', 'FASTWEB', '', 'Housing', 'Internet', 'expense', true],
  [234, 'description', 'contains', 'TIM S.P.A', '', 'Housing', 'Phone', 'expense', true],

  // ---- Merchants: subscriptions ----
  [240, 'description', 'contains', 'NETFLIX', '', 'Life & Entertainment', 'Streaming', 'expense', true],
  [241, 'description', 'contains', 'SPOTIFY', '', 'Life & Entertainment', 'Streaming', 'expense', true],
  [242, 'description', 'contains', 'DISNEY', '', 'Life & Entertainment', 'Streaming', 'expense', true],
  [243, 'description', 'contains', 'APPLE.COM/BILL', '', 'Housing', 'Subscriptions', 'expense', true],
  [244, 'description', 'contains', 'GOOGLE *', '', 'Housing', 'Subscriptions', 'expense', true],
  [245, 'description', 'contains', 'AMAZON PRIME', '', 'Housing', 'Subscriptions', 'expense', true],

  // ---- Merchants: transport & travel ----
  [250, 'description', 'contains', 'TRENITALIA', '', 'Transport', 'Public transport', 'expense', true],
  [251, 'description', 'contains', 'ITALO', '', 'Transport', 'Public transport', 'expense', true],
  [252, 'description', 'contains', 'TELEPASS', '', 'Transport', 'Tolls & Parking', 'expense', true],
  [253, 'description', 'contains', 'AUTOSTRADE', '', 'Transport', 'Tolls & Parking', 'expense', true],
  [254, 'description', 'contains', 'Q8', '', 'Transport', 'Fuel', 'expense', true],
  [255, 'description', 'contains', 'TAMOIL', '', 'Transport', 'Fuel', 'expense', true],
  [256, 'description', 'contains', 'UBER', '', 'Transport', 'Taxi', 'expense', true],
  [257, 'description', 'contains', 'FREENOW', '', 'Transport', 'Taxi', 'expense', true],
  [260, 'description', 'contains', 'RYANAIR', '', 'Life & Entertainment', 'Flights', 'expense', true],
  [261, 'description', 'contains', 'EASYJET', '', 'Life & Entertainment', 'Flights', 'expense', true],
  [262, 'description', 'contains', 'BOOKING.COM', '', 'Life & Entertainment', 'Accommodation', 'expense', true],
  [263, 'description', 'contains', 'AIRBNB', '', 'Life & Entertainment', 'Accommodation', 'expense', true],

  // ---- Merchants: food delivery & retail ----
  [270, 'description', 'contains', 'GLOVO', '', 'Food & Drink', 'Delivery', 'expense', true],
  [271, 'description', 'contains', 'DELIVEROO', '', 'Food & Drink', 'Delivery', 'expense', true],
  [272, 'description', 'contains', 'JUST EAT', '', 'Food & Drink', 'Delivery', 'expense', true],
  [273, 'description', 'contains', 'MCDONALD', '', 'Food & Drink', 'Restaurants', 'expense', true],
  [274, 'description', 'contains', 'STARBUCKS', '', 'Food & Drink', 'Bars & Cafes', 'expense', true],
  [280, 'description', 'contains', 'AMAZON', '', 'Shopping', 'Home', 'expense', true],
  [281, 'description', 'contains', 'ZALANDO', '', 'Shopping', 'Clothing', 'expense', true],
  [282, 'description', 'contains', 'DECATHLON', '', 'Life & Entertainment', 'Hobbies', 'expense', true],
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
 *
 * `labels` *is* mapped, into the column of the same name. It is on a small
 * minority of rows and carries the one axis a category cannot: a trip, a
 * project, a child. Losing it would mean retyping years of annotation that
 * already exists.
 */
var DEFAULT_IMPORT_MAP = [
  ['budgetbakers', 'account', 'account_name'],
  ['budgetbakers', 'date', 'booking_date'],
  ['budgetbakers', 'amount', 'amount'],
  ['budgetbakers', 'type', 'type'],
  ['budgetbakers', 'currency', 'currency'],
  ['budgetbakers', 'note', 'description'],
  ['budgetbakers', 'payee', 'counterparty'],
  ['budgetbakers', 'category', 'category_override'],
  ['budgetbakers', 'labels', 'labels']
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
 * `Missing`, `Unknown expense`, `Services` and `Others` land in
 * Other/Uncategorised on purpose. They carry no information, and inventing one
 * for them would hide rows that deserve a look in the needs-review queue.
 *
 * Built from **five years** of a real export — 4,364 rows, Oct 2022 to Jul
 * 2026, 67 distinct categories. It took three passes to get there and the
 * lesson each time was the same: a sample is not a smaller version of the
 * history, it is the history minus everything that happens rarely. Twenty rows
 * gave 36 categories. One year gave 57, and the 21 it added included
 * `Wage, invoices`, which is where a salary lives. Four more years added ten
 * more, of which `Fines` appears exactly once.
 *
 * `Long distance` is worth singling out because the obvious reading is wrong.
 * It sits under Transportation in their taxonomy, so it looks like intercity
 * rail; every row of it in four years is a budget airline. It maps to
 * Travel/Flights, and the only reason that is known is that the rows were
 * looked at rather than the name.
 *
 * Two shapes of mistake the full year exposed, both of which had survived the
 * sample because the sample happened not to contain them:
 *
 *   **`Gifts` is income; `Gifts, joy` is the expense.** Both used to land in
 *   Shopping/Gifts, which files money *received* as money *spent*. Over the
 *   year that was €9,400 on the wrong side.
 *
 *   **A parent-level category is not its most common child.** `Food & Drinks`
 *   is BudgetBakers' parent of Groceries/Bar/Restaurant, and mapping it to
 *   Groceries inflated the weekly shop with what were plainly coffees — €8.60
 *   average against Groceries' €41. Parent-level sources now map to an
 *   `Other <parent>` child, which keeps the row out of a total it would
 *   distort while still saying more than "uncategorised".
 *
 * `Cleaning`, `Insurances`, `Pizza` and `Unknown expense` were kept on the
 * argument that they are real BudgetBakers categories other people's exports
 * would contain, having appeared in none of the year the map was rebuilt
 * against. All four turn up in the other four years. Keeping a row costs
 * nothing; a missing one costs an import.
 */
var DEFAULT_CATEGORY_MAP = [
  ['budgetbakers', 'Active sport, fitness', 'Health', 'Fitness'],
  ['budgetbakers', 'Advisory', 'Fees & Taxes', 'Professional fees'],
  ['budgetbakers', 'Alcohol, tobacco', 'Food & Drink', 'Alcohol & Tobacco'],
  ['budgetbakers', 'Bar, cafe', 'Food & Drink', 'Bars & Cafes'],
  ['budgetbakers', 'Books, audio, subscriptions', 'Housing', 'Subscriptions'],
  ['budgetbakers', 'Charges, Fees', 'Fees & Taxes', 'Bank fees'],
  ['budgetbakers', 'Charity, gifts', 'Shopping', 'Gifts'],
  ['budgetbakers', 'Child Support', 'Income', 'Child support'],
  ['budgetbakers', 'Cleaning', 'Housing', 'Maintenance'],
  ['budgetbakers', 'Clothes & Footwear', 'Shopping', 'Clothing'],
  ['budgetbakers', 'Communication, PC', 'Housing', 'Other bills'],
  ['budgetbakers', 'Culture, sport events', 'Life & Entertainment', 'Cinema & Events'],
  ['budgetbakers', 'Drug-store, chemist', 'Health', 'Pharmacy'],
  ['budgetbakers', 'Education, development', 'Education', 'Courses'],
  ['budgetbakers', 'Electronics, accessories', 'Shopping', 'Electronics'],
  ['budgetbakers', 'Energy, utilities', 'Housing', 'Electricity'],
  ['budgetbakers', 'Financial expenses', 'Fees & Taxes', 'Bank fees'],
  ['budgetbakers', 'Fines', 'Fees & Taxes', 'Fines'],
  ['budgetbakers', 'Food & Drinks', 'Food & Drink', 'Other food & drink'],
  ['budgetbakers', 'Fuel', 'Transport', 'Fuel'],
  ['budgetbakers', 'Gifts', 'Income', 'Gifts received'],
  ['budgetbakers', 'Gifts, joy', 'Shopping', 'Gifts'],
  ['budgetbakers', 'Groceries', 'Food & Drink', 'Groceries'],
  ['budgetbakers', 'Health and beauty', 'Health', 'Personal care'],
  ['budgetbakers', 'Health care, doctor', 'Health', 'Doctor'],
  ['budgetbakers', 'Hobbies', 'Life & Entertainment', 'Hobbies'],
  ['budgetbakers', 'Holiday, trips, hotels', 'Life & Entertainment', 'Holiday'],
  ['budgetbakers', 'Home, garden', 'Shopping', 'Home'],
  ['budgetbakers', 'Housing', 'Housing', 'Other housing'],
  ['budgetbakers', 'Income', 'Income', 'Other income'],
  ['budgetbakers', 'Insurances', 'Insurance', 'Other insurance'],
  ['budgetbakers', 'Interests, dividends', 'Income', 'Interest'],
  ['budgetbakers', 'Internet', 'Housing', 'Internet'],
  ['budgetbakers', 'Jewels, accessories', 'Shopping', 'Clothing'],
  ['budgetbakers', 'Kids', 'Shopping', 'Kids'],
  ['budgetbakers', 'Leisure time', 'Life & Entertainment', 'Hobbies'],
  // The two middle strings are the same and mean different things: column 2 is
  // BudgetBakers' own parent-level label, column 3 is the category here. They
  // agree by coincidence of naming, not by construction, and this row maps a
  // parent-level source the same way every other one does.
  ['budgetbakers', 'Life & Entertainment', 'Life & Entertainment', 'Hobbies'],
  ['budgetbakers', 'Life events', 'Life & Entertainment', 'Life events'],
  ['budgetbakers', 'Long distance', 'Life & Entertainment', 'Flights'],
  ['budgetbakers', 'Lottery, gambling', 'Life & Entertainment', 'Hobbies'],
  ['budgetbakers', 'Maintenance, repairs', 'Housing', 'Maintenance'],
  ['budgetbakers', 'Missing', 'Other', 'Uncategorised'],
  ['budgetbakers', 'Mortgage', 'Housing', 'Mortgage'],
  ['budgetbakers', 'Others', 'Other', 'Uncategorised'],
  ['budgetbakers', 'Parking', 'Transport', 'Tolls & Parking'],
  ['budgetbakers', 'Pizza', 'Food & Drink', 'Restaurants'],
  ['budgetbakers', 'Property insurance', 'Insurance', 'Home insurance'],
  ['budgetbakers', 'Public transport', 'Transport', 'Public transport'],
  ['budgetbakers', 'Refunds (tax, purchase)', 'Income', 'Refund'],
  ['budgetbakers', 'Rental income', 'Income', 'Rent received'],
  ['budgetbakers', 'Restaurant, fast-food', 'Food & Drink', 'Restaurants'],
  ['budgetbakers', 'Sale', 'Income', 'Other income'],
  ['budgetbakers', 'Services', 'Other', 'Uncategorised'],
  ['budgetbakers', 'Shopping', 'Shopping', 'Other shopping'],
  ['budgetbakers', 'Software, apps, games', 'Housing', 'Subscriptions'],
  ['budgetbakers', 'Stationery, tools', 'Shopping', 'Home'],
  ['budgetbakers', 'TV, Streaming', 'Life & Entertainment', 'Streaming'],
  ['budgetbakers', 'Taxes', 'Fees & Taxes', 'Taxes'],
  ['budgetbakers', 'Telephony, mobile phone', 'Housing', 'Phone'],
  ['budgetbakers', 'Transfer, withdraw', 'Transfer', 'Between accounts'],
  ['budgetbakers', 'Transportation', 'Transport', 'Other transport'],
  ['budgetbakers', 'Unknown expense', 'Other', 'Uncategorised'],
  ['budgetbakers', 'Vehicle', 'Transport', 'Car maintenance'],
  ['budgetbakers', 'Vehicle insurance', 'Insurance', 'Vehicle'],
  ['budgetbakers', 'Vehicle maintenance', 'Transport', 'Car maintenance'],
  ['budgetbakers', 'Wage, invoices', 'Income', 'Salary'],
  ['budgetbakers', 'Wellness, beauty', 'Health', 'Personal care']
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

/**
 * A value as text rather than as markup.
 *
 * This project builds three HTML pages by string concatenation — the callback
 * page in 05_auth.gs and the two dialogs — and one of them, `doGet`, is
 * reachable by anyone on the internet. It has to be: the bank's redirect
 * arrives with no Google session attached, so the web app is deployed
 * `ANYONE_ANONYMOUS`. Interpolating a query parameter into that page raw let
 * `?error=<script>…` render as markup on a Google origin, from where a script
 * can reach `google.script.run` and call this project's functions as the
 * deploying user — the account holding the bank credentials.
 *
 * Lives here rather than next to the pages that need it because it is used
 * from 02 and 05, and nothing lower may depend on anything higher.
 *
 * `&` is replaced first. Any other order re-escapes the ampersands the later
 * replacements just introduced, turning `<` into `&amp;lt;` — visible, but the
 * wrong kind of visible, and the sort of bug that gets "fixed" by removing the
 * escaping.
 */
function escapeHtml_(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
