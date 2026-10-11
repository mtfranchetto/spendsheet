/**
 * schema.ts — the book's shape, as `00_config.gs` states it.
 *
 * A copy, and the one kind of copy this project tolerates: `schema.test.ts`
 * loads the `.gs` and fails on any difference, so the two cannot drift without
 * a red test. A column renamed on one side and not the other would otherwise
 * read as a column of blanks — every value `undefined`, padded to `''`, and a
 * dashboard of zeros that looks like a quiet month.
 *
 * Only what the viewer reads is here. Columns are the schema constants, never
 * the sheet's own header row, for the reason `records.ts` gives.
 */

export const TABS = {
  TRANSACTIONS: 'transactions',
  PENDING: 'pending',
  ACCOUNTS: 'accounts',
  CATEGORIES: 'categories',
  LABELS: 'labels',
  STATUS: '_status',
  RUNS: '_runs',
  CONFIG: '_config',
  MEMORY: '_memory',
  REMOVED: '_removed',
  MONITOR: '_monitor'
} as const;

export const TX_COLUMNS_CODE = [
  'uid', 'account_id', 'account_name', 'booking_date', 'value_date',
  'transaction_date', 'amount', 'currency', 'description', 'counterparty',
  'entry_reference', 'bank_transaction_code', 'mcc', 'source', 'imported_at'
] as const;

export const TX_COLUMNS_DERIVED = [
  'amount_base', 'category_auto', 'subcategory_auto', 'category_source',
  'category_override', 'category', 'subcategory', 'type', 'transfer_group',
  'notes', 'excluded', 'labels', 'confirmed', 'in_reports', 'subcategory_override'
] as const;

export const TX_COLUMNS = [...TX_COLUMNS_CODE, ...TX_COLUMNS_DERIVED] as const;

export const PENDING_COLUMNS = TX_COLUMNS_CODE;

export const ACCOUNT_COLUMNS = [
  'account_id', 'name', 'kind', 'provider', 'iban_masked', 'currency',
  'opening_balance', 'balance_api', 'balance_manual', 'balance', 'balance_type',
  'balance_updated_at', 'balances_raw', 'include_in_net_worth', 'active',
  'connection_id', 'identity_hash', 'provider_account_id'
] as const;

export const CATEGORY_COLUMNS = [
  'category', 'subcategory', 'kind', 'icon',
  'parent_list', 'child_list', 'child_key', 'child_parent'
] as const;

export const LABEL_COLUMNS = ['label', 'description', 'transactions', 'total_eur'] as const;

export const STATUS_COLUMNS = [
  'connection_id', 'provider', 'session_id', 'state', 'valid_until',
  'days_left', 'last_success', 'last_error', 'accounts_covered'
] as const;

export const RUN_COLUMNS = [
  'run_id', 'started_at', 'duration_ms', 'trigger',
  'accounts_attempted', 'accounts_ok', 'rows_fetched', 'rows_inserted',
  'rows_duplicate', 'result', 'message'
] as const;

export const CONFIG_COLUMNS = ['key', 'value', 'description'] as const;
export const MEMORY_COLUMNS = ['merchant_key', 'category', 'subcategory', 'hits', 'last_seen'] as const;
export const MONITOR_COLUMNS = ['transactions_rows', 'removed_rows'] as const;

/**
 * The defaults for the `_config` keys the viewer reads — a subset, each held
 * to `DEFAULT_CONFIG` by the schema test. A key missing from the tab falls
 * back to these, as `readConfig_` does.
 */
export const DEFAULT_CONFIG: Readonly<{ [key: string]: string | number }> = {
  base_currency: 'EUR',
  timezone: 'Europe/Rome',
  stale_threshold_days: 2,
  empty_run_threshold_days: 3,
  consent_warning_days: 7,
  stale_balance_days: 3,
  transfer_window_days: 4,
  review_queue_size: 50
};

export const TX_SOURCE_API = 'enablebanking';
export const TX_SOURCE_CASH = 'manual';

export const CATEGORY_SOURCE = {
  OVERRIDE: 'override',
  TRANSFER: 'transfer',
  MEMORY: 'memory',
  MCC: 'mcc',
  RULE: 'rule',
  UNCLASSIFIED: 'unclassified'
} as const;

export const TX_TYPE = { EXPENSE: 'expense', INCOME: 'income', TRANSFER: 'transfer' } as const;

/**
 * Where a change in an asset's value is filed: `Transfer › Valuation change`,
 * a seed row of `categories`. The form that writes one and the long view that
 * adds them up both name it from here.
 */
export const TRANSFER_CATEGORY = 'Transfer';
export const VALUATION_SUBCATEGORY = 'Valuation change';
export const ACCOUNT_KIND = { BANK: 'bank', CASH: 'cash', ASSET: 'asset' } as const;
export const ACCOUNT_KINDS = [ACCOUNT_KIND.BANK, ACCOUNT_KIND.CASH, ACCOUNT_KIND.ASSET] as const;
export const RUN_RESULT = { OK: 'OK', PARTIAL: 'PARTIAL', FAIL: 'FAIL' } as const;

export const ALERT_KIND = {
  CONSENT: 'consent',
  EMPTY_RUNS: 'empty_runs',
  NEVER_RAN: 'never_ran',
  ROWS_LOST: 'rows_lost',
  ACCOUNT_FAILING: 'account_failing'
} as const;

export const MERCHANT_NOISE_WORDS: readonly string[] = [
  'pagamento', 'pagamenti', 'pos', 'carta', 'cartasi', 'operazione', 'acquisto',
  'addebito', 'accredito', 'bonifico', 'disposizione', 'tramite', 'contactless',
  'ecommerce', 'commercio', 'elettronico', 'del', 'della', 'dello', 'di', 'da',
  'per', 'presso', 'favore', 'ordinante', 'beneficiario', 'causale', 'rif',
  'riferimento', 'aut', 'autorizzazione', 'ref', 'trn', 'importo', 'valuta',
  'data', 'ore', 'ora', 'sepa', 'sdd', 'bancomat', 'pagobancomat', 'istantaneo',
  'eur', 'usd', 'gbp', 'chf', 'nr', 'num', 'numero', 'conto', 'nostro', 'vostro',
  'il', 'lo', 'la', 'le', 'gli', 'un', 'una', 'and', 'the', 'srl', 'spa', 'sas',
  'snc', 'sa', 'bv', 'nv', 'gmbh', 'ltd', 'inc', 'llc', 'plc',
  'kartenzahlung', 'lastschrift', 'girocard', 'kaartbetaling', 'betaalautomaat',
  'paiement', 'achat', 'compra', 'tarjeta'
];

export const MERCHANT_LETTER_FOLDS: Readonly<{ [letter: string]: string }> = {
  'ø': 'o', 'æ': 'ae', 'œ': 'oe', 'ß': 'ss', 'ł': 'l', 'đ': 'd', 'ð': 'd',
  'þ': 'th', 'ı': 'i'
};

export const MERCHANT_KEY_MAX_TOKENS = 6;

/** Rows a Records page hands back at a time. */
export const QUERY_PAGE_SIZE = 100;
/** Rows in a grouped block. */
export const QUERY_GROUP_LIMIT = 30;
/** Above this many days, the cashflow series is monthly rather than daily. */
export const QUERY_DAILY_MAX_DAYS = 62;
/** How many days of net worth the dashboard draws under the total. */
export const DASHBOARD_TREND_DAYS = 30;
