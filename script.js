/* ============================================================
   HSRP DASHBOARD
   File: /script.js

   Reads a local PostgREST API in front of the "hsrp" Postgres.

   DATA MODEL
   ----------
   The raw tables (hsrp_gj01 ... hsrp_gj38, one per RTO) hold
   ~99,600 individual applications - far too many to pull into
   a browser. The database pre-aggregates them into the view
   hsrp_dealer_summary:

       rto_code | report_year | report_month | dealer_name
                | total | fixed | pending

   That is ~6,200 rows, so this file fetches it once, caches it,
   and then does every filter, grouping, sort and page in memory.
   After first paint nothing touches the network again.

   The month and year come from the CSV file names at load time
   (see db/load-data.ps1); nothing here has to parse them.
   ============================================================ */


/* ============================================================
   1. API CONFIGURATION
   ============================================================ */

/*
 * Two deployments, one codebase:
 *
 *   localhost      -> the local PostgREST container (no key,
 *                     read-only, bound to localhost)
 *   anywhere else  -> Supabase, whose REST API *is* PostgREST,
 *                     so every query below is unchanged and only
 *                     the base URL and auth headers differ
 *
 * Both are configured in config.js, which loads first.
 */
const API = resolveApiTarget();

const API_URL = API.url;

const SUMMARY_TABLE = "hsrp_dealer_summary";


function resolveApiTarget() {

    const config = window.HSRP_CONFIG;

    /*
     * config.js missing entirely - fall back to local so a
     * checkout still runs without any setup.
     */
    if (!config) {
        return { url: "http://localhost:3004", key: null };
    }

    const host = window.location.hostname;

    const isLocal =
        (config.localHosts || []).includes(host) ||
        window.location.protocol === "file:";

    const target = isLocal ? config.local : config.hosted;

    if (!target || !target.url || target.url.startsWith("PASTE_")) {

        /*
         * Reported rather than thrown: this runs while the module
         * is still evaluating, and throwing here would stop the
         * page before it can render an error banner. initializeApi
         * raises it once the DOM is ready.
         */
        return {
            url: null,
            key: null,
            error: isLocal
                ? "config.js has no local API url."
                : "This page is deployed, but config.js still has " +
                  "placeholder Supabase settings. Fill in the " +
                  "\"hosted\" block - see README.md."
        };
    }

    return target;
}


/*
 * Supabase authenticates every REST call with the anon key, sent
 * both ways. Local PostgREST needs neither, so this is empty
 * there and the requests go out exactly as before.
 */
function authHeaders() {

    if (!API.key) {
        return {};
    }

    return {
        apikey: API.key,
        Authorization: `Bearer ${API.key}`
    };
}


/* ============================================================
   2. APPLICATION CONFIGURATION
   ============================================================ */

const CONFIG = {

    ALL: "all",

    PAGE_SIZE: 25,

    SEARCH_DELAY: 150,

    MAX_SEARCH_ROWS: 5,

    /*
     * The summary view is ~6,200 rows, so this is seven round
     * trips on a cold load and none thereafter.
     */
    FETCH_PAGE_SIZE: 1000,

    MAX_FETCH_PAGES: 100,

    /*
     * Below these fitment rates the meter turns amber, then red.
     */
    RATE_MID: 95,
    RATE_LOW: 90
};


const MONTH_NAMES = [
    "", "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
];

const MONTH_SHORT = [
    "", "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
    "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"
];


/*
 * One entry per "Summarise by" option. Each collapses the same
 * cached rows onto a different key, so the whole view model is
 * unchanged - only the label of the first column moves.
 */
const GROUPINGS = {

    dealer: {
        id: "dealer",
        entity: "Dealer",
        entityPlural: "Dealers",
        title: "Fitment by Dealer",
        searchPlaceholder: "Search dealer...",
        narrow: false,
        keyOf: row => row.dealer_name,
        labelOf: key => key
    },

    rto: {
        id: "rto",
        entity: "RTO",
        entityPlural: "RTOs",
        title: "Fitment by RTO",
        searchPlaceholder: "Search RTO...",
        narrow: true,
        keyOf: row => row.rto_code,
        labelOf: key => key
    },

    period: {
        id: "period",
        entity: "Period",
        entityPlural: "Periods",
        title: "Fitment by Period",
        searchPlaceholder: "Search period...",
        narrow: true,

        /*
         * Sortable key, readable label: 2026-04 sorts correctly
         * as text while the column shows "APR 2026".
         */
        keyOf: row => `${row.report_year}-${String(row.report_month).padStart(2, "0")}`,
        labelOf: key => {
            const [year, month] = key.split("-");
            return `${MONTH_SHORT[Number(month)] || month} ${year}`;
        }
    }
};

const DEFAULT_GROUPING = "dealer";


/*
 * The status filter does not just remove rows - it changes what
 * the table is measuring, so it also decides which value column
 * makes sense. See buildColumns().
 */
const STATUSES = {
    all:     { id: "all",     label: "All",          field: null },
    fixed:   { id: "fixed",   label: "HSRP Fixed",   field: "fixed" },
    pending: { id: "pending", label: "HSRP Pending", field: "pending" }
};


/*
 * Filters whose <select> is replaced by a searchable combobox.
 * Dealer has ~1,650 options, so it needs one; the rest are short
 * but stay consistent.
 */
const SEARCHABLE_FILTERS = [
    "rtoFilter",
    "yearFilter",
    "monthFilter",
    "statusFilter",
    "dealerFilter",
    "groupByFilter"
];


/* ============================================================
   3. REST CLIENT

   A small PostgREST client shaped as a query builder:
   client.from(t).select(cols).range(a, b)
   ============================================================ */

let restClient = null;


class RestQuery {

    constructor(baseUrl, table) {

        this.baseUrl = baseUrl;
        this.table = table;
        this.params = new URLSearchParams();
        this.headers = {};
        this.signal = null;
        this.headOnly = false;
    }

    select(columns, options = {}) {

        this.params.set("select", columns || "*");

        if (options.count) {
            this.headers.Prefer = `count=${options.count}`;
        }

        if (options.head) {
            this.headOnly = true;
        }

        return this;
    }

    /*
     * Takes a full PostgREST order expression, e.g.
     * "rto_code.asc,report_year.asc". Paging with .range() is
     * only safe over an order that is unique, otherwise rows tie
     * and Postgres is free to return them in a different order
     * on each page - silently duplicating some and dropping
     * others.
     */
    order(expression) {

        this.params.set("order", expression);

        return this;
    }

    range(from, to) {

        this.headers["Range-Unit"] = "items";
        this.headers.Range = `${from}-${to}`;

        return this;
    }

    limit(count) {

        this.params.set("limit", String(count));

        return this;
    }

    abortSignal(signal) {

        this.signal = signal;

        return this;
    }

    async run() {

        const url =
            `${this.baseUrl}/${encodeURIComponent(this.table)}` +
            `?${this.params.toString()}`;

        let response;

        try {

            response = await fetch(url, {
                method: this.headOnly ? "HEAD" : "GET",
                headers: { ...authHeaders(), ...this.headers },
                signal: this.signal
            });

        } catch (error) {

            /*
             * Network-level failure - the API is down or
             * unreachable. Shaped like a PostgREST error so
             * callers need not care which it was.
             */
            return {
                data: null,
                count: null,
                error: { message: error.message, code: "FETCH_FAILED" }
            };
        }

        const range = response.headers.get("content-range");

        const count =
            range && range.includes("/")
                ? Number(range.split("/")[1])
                : null;

        if (!response.ok) {

            let message = `${response.status} ${response.statusText}`;

            try {
                const body = await response.json();
                if (body && body.message) {
                    message = body.message;
                }
            } catch (ignored) {
                /* non-JSON error body */
            }

            return {
                data: null,
                count,
                error: { message, code: String(response.status) }
            };
        }

        if (this.headOnly) {
            return { data: null, count, error: null };
        }

        return { data: await response.json(), count, error: null };
    }

    then(resolve, reject) {

        return this.run().then(resolve, reject);
    }
}


function createRestClient(baseUrl) {

    return {
        from: table => new RestQuery(baseUrl, table)
    };
}


/* ============================================================
   4. APPLICATION STATE
   ============================================================ */

function emptyKPIs() {

    return {
        total: 0,
        fixed: 0,
        pending: 0,
        fixedPct: 0,
        pendingPct: 0,
        entities: 0
    };
}


const state = {

    initialized: false,
    wired: false,
    retryWired: false,

    loading: false,

    requestId: 0,
    activeController: null,

    /*
     * The whole summary view, fetched once. Every filter below
     * is applied to this array in memory.
     */
    source: [],
    sourceLoaded: false,

    filters: {
        rto: CONFIG.ALL,
        year: CONFIG.ALL,
        month: CONFIG.ALL,
        status: CONFIG.ALL,
        dealers: []
    },

    groupBy: DEFAULT_GROUPING,

    /* Filter option lists, derived from the cached rows. */
    rtos: [],
    years: [],
    months: [],
    dealers: [],

    periodRange: "—",

    /* Rendered column set, rebuilt when the status filter moves. */
    columns: [],

    rows: [],
    filteredRows: [],

    kpis: emptyKPIs(),

    /* Active registration lookup, "" when not searching. */
    registration: "",

    searchTerms: [],
    searchTimer: null,

    sortKey: "total",
    sortDirection: "desc",

    currentPage: 1,
    pageSize: CONFIG.PAGE_SIZE
};


function currentGrouping() {

    return GROUPINGS[state.groupBy] || GROUPINGS[DEFAULT_GROUPING];
}


function currentStatus() {

    return STATUSES[state.filters.status] || STATUSES.all;
}


/* ============================================================
   5. DOM CACHE
   ============================================================ */

const dom = {};


const DOM_IDS = [
    "globalLoading",
    "dashboardFilters",
    "rtoFilter",
    "yearFilter",
    "monthFilter",
    "statusFilter",
    "dealerFilter",
    "dealerChips",
    "registrationInput",
    "registrationButton",
    "registrationSection",
    "allDealersSection",
    "dealerDetailSection",
    "groupByFilter",
    "filterNotice",
    "clearFiltersButton",
    "errorMessage",
    "errorMessageText",
    "retryButton",
    "activeFilters",
    "datasetNote",
    "data-year-range",
    "totalApplications",
    "totalApplicationsMeta",
    "fixedCount",
    "fixedPercentage",
    "pendingCount",
    "pendingPercentage",
    "entityCount",
    "entityCountLabel",
    "entityCountMeta",
    "dealer-summary-title",
    "entitySearchList",
    "resultCount",
    "tableLoading",
    "tableEmpty",
    "tableEmptyText",
    "tableError",
    "tableErrorText",
    "tableContent",
    "dealerSummaryTable",
    "dealerSummaryTableHead",
    "dealerSummaryTableBody",
    "dealerSummaryTableFoot",
    "pageSizeSelect",
    "previousPageButton",
    "pageIndicator",
    "nextPageButton",
    "searchRowTemplate"
];


function cacheDOM() {

    DOM_IDS.forEach(id => {
        dom[id] = document.getElementById(id);
    });
}


/* ============================================================
   6. GENERAL HELPERS
   ============================================================ */

function toNumber(value) {

    if (value === null || value === undefined || value === "") {
        return 0;
    }

    if (typeof value === "number") {
        return Number.isFinite(value) ? value : 0;
    }

    const cleaned = String(value).replace(/,/g, "").trim();
    const number = Number(cleaned);

    return Number.isFinite(number) ? number : 0;
}


function formatIndianNumber(value) {

    return new Intl.NumberFormat("en-IN", {
        maximumFractionDigits: 0
    }).format(toNumber(value));
}


function formatPercentage(value) {

    if (value === null || value === undefined || value === "") {
        return "—";
    }

    return `${toNumber(value).toFixed(2)}%`;
}


/*
 * Share of the column, measured against the whole filtered set
 * rather than the visible page - the same figure the totals row
 * prints at the foot of that column.
 */
function formatShare(value, columnTotal) {

    const denominator = toNumber(columnTotal);

    if (denominator <= 0) {
        return "—";
    }

    return formatPercentage((toNumber(value) / denominator) * 100);
}


function normalizeString(value) {

    if (value === null || value === undefined) {
        return "";
    }

    return String(value).trim();
}


function normalizeKey(value) {

    return normalizeString(value).toLowerCase().replace(/\s+/g, " ");
}


function isAll(value) {

    const normalized = normalizeString(value).toLowerCase();

    return normalized === "" || normalized === "all";
}


function normalizeFilter(value) {

    return isAll(value) ? CONFIG.ALL : normalizeString(value);
}


function uniqueSorted(values) {

    return [
        ...new Set(values.map(normalizeString).filter(Boolean))
    ].sort((a, b) =>
        a.localeCompare(b, undefined, {
            numeric: true,
            sensitivity: "base"
        })
    );
}


/*
 * Fitment rate for one row: fixed as a proportion of that row's
 * own total. Distinct from share-of-column, which is what the
 * numeric cells print.
 */
function fitmentRate(fixed, total) {

    const denominator = toNumber(total);

    if (denominator <= 0) {
        return null;
    }

    return (toNumber(fixed) / denominator) * 100;
}


/* ============================================================
   7. DATA LOADING
   ============================================================ */

function initializeApi() {

    if (API.error) {
        throw new Error(API.error);
    }

    if (!restClient) {
        restClient = createRestClient(API_URL);
    }

    return restClient;
}


function apiError(table, error) {

    const detail = error?.message || "Unknown error";

    return new Error(`Could not read "${table}": ${detail}`);
}


/*
 * PostgREST caps a response at its own row limit, so the view is
 * read in pages until a short page arrives.
 */
async function fetchAllRows(table, signal) {

    const rows = [];

    for (let page = 0; page < CONFIG.MAX_FETCH_PAGES; page += 1) {

        const from = page * CONFIG.FETCH_PAGE_SIZE;
        const to = from + CONFIG.FETCH_PAGE_SIZE - 1;

        const { data, error } = await restClient
            .from(table)
            .select("*")
            /*
             * This four-column order is exactly the view's own
             * GROUP BY key, so it is unique and the pages cannot
             * shift underneath us.
             */
            .order(
                "rto_code.asc,report_year.asc," +
                "report_month.asc,dealer_name.asc"
            )
            .range(from, to)
            .abortSignal(signal)
            .run();

        if (error) {
            throw apiError(table, error);
        }

        if (!Array.isArray(data) || data.length === 0) {
            break;
        }

        rows.push(...data);

        if (data.length < CONFIG.FETCH_PAGE_SIZE) {
            break;
        }
    }

    return rows;
}


async function loadDataset(signal) {

    const raw = await fetchAllRows(SUMMARY_TABLE, signal);

    state.source = raw.map(row => ({
        rto_code: normalizeString(row.rto_code),
        report_year: toNumber(row.report_year),
        report_month: toNumber(row.report_month),
        dealer_name: normalizeString(row.dealer_name),
        total: toNumber(row.total),
        fixed: toNumber(row.fixed),
        pending: toNumber(row.pending)
    }));

    state.sourceLoaded = true;

    buildFilterOptions();
}


/* ============================================================
   8. FILTER OPTIONS

   Every option list is derived from the cached rows, so the
   dashboard can never offer a filter that matches nothing.
   ============================================================ */

function buildFilterOptions() {

    state.rtos = uniqueSorted(state.source.map(row => row.rto_code));

    state.years = uniqueSorted(
        state.source.map(row => String(row.report_year))
    );

    state.months = [
        ...new Set(state.source.map(row => row.report_month))
    ].sort((a, b) => a - b);

    state.dealers = uniqueSorted(
        state.source.map(row => row.dealer_name)
    );

    state.periodRange = buildPeriodRange();
}


function buildPeriodRange() {

    if (state.source.length === 0) {
        return "—";
    }

    const keys = state.source
        .map(row =>
            row.report_year * 100 + row.report_month
        )
        .sort((a, b) => a - b);

    const format = key => {
        const year = Math.floor(key / 100);
        const month = key % 100;
        return `${MONTH_SHORT[month] || month} ${year}`;
    };

    const first = format(keys[0]);
    const last = format(keys[keys.length - 1]);

    return first === last ? first : `${first} – ${last}`;
}


function populateSelect(select, values, allLabel, selectedValue = CONFIG.ALL) {

    if (!select) {
        return;
    }

    const previous = select.value;

    select.innerHTML = "";

    const allOption = document.createElement("option");
    allOption.value = CONFIG.ALL;
    allOption.textContent = allLabel;
    select.appendChild(allOption);

    values.forEach(entry => {

        const option = document.createElement("option");

        if (typeof entry === "object") {
            option.value = entry.value;
            option.textContent = entry.label;
        } else {
            option.value = entry;
            option.textContent = entry;
        }

        select.appendChild(option);
    });

    /*
     * Keep the current choice if it still exists, so reloading
     * options does not silently reset the user's filter.
     */
    const wanted =
        selectedValue !== CONFIG.ALL ? selectedValue : previous;

    select.value =
        wanted && [...select.options].some(option => option.value === wanted)
            ? wanted
            : CONFIG.ALL;

    refreshCombo(select);
}


function loadFilterOptions() {

    populateSelect(
        dom.rtoFilter,
        state.rtos,
        "All RTOs",
        state.filters.rto
    );

    populateSelect(
        dom.yearFilter,
        state.years,
        "All",
        state.filters.year
    );

    populateSelect(
        dom.monthFilter,
        state.months.map(month => ({
            value: String(month),
            label: MONTH_NAMES[month] || String(month)
        })),
        "All",
        state.filters.month
    );

    populateSelect(
        dom.dealerFilter,
        state.dealers,
        "All",
        CONFIG.ALL
    );

    /*
     * Status and grouping are fixed lists written in the HTML,
     * so they only need mirroring into their comboboxes.
     */
    refreshCombo(dom.statusFilter);
    refreshCombo(dom.groupByFilter);
}


/* ============================================================
   9. SEARCHABLE SELECT (COMBOBOX)

   Each filter <select> keeps its id and its value; a combobox is
   layered over it so long lists can be typed into. Committing a
   value dispatches a native change event, so every listener
   downstream behaves as if the select had been used directly.
   ============================================================ */

const COMBO_RENDER_LIMIT = 200;

const combos = new Map();


function enhanceFilterSelects() {

    SEARCHABLE_FILTERS.forEach(id => {

        const select = dom[id];

        if (!select || combos.has(select)) {
            return;
        }

        combos.set(select, createCombo(select));
    });
}


function createCombo(select) {

    const wrapper = document.createElement("div");
    wrapper.className = "combo";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "combo__input";
    input.id = `${select.id}Combo`;
    input.autocomplete = "off";
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-controls", `${select.id}List`);

    const list = document.createElement("ul");
    list.className = "combo__list";
    list.id = `${select.id}List`;
    list.setAttribute("role", "listbox");
    list.hidden = true;

    /*
     * The select stays put and keeps its id; it is simply taken
     * out of the tab order and hidden from assistive tech, with
     * the combobox standing in for it.
     */
    select.classList.add("combo__native");
    select.setAttribute("tabindex", "-1");
    select.setAttribute("aria-hidden", "true");

    const parent = select.parentNode;

    if (parent) {
        parent.insertBefore(wrapper, select);
        wrapper.appendChild(select);
    }

    wrapper.appendChild(input);
    wrapper.appendChild(list);

    /*
     * Point the existing label at the combobox so clicking it
     * still focuses the control the user actually types into.
     */
    const label = parent?.querySelector(`label[for="${select.id}"]`);

    if (label) {
        label.setAttribute("for", input.id);
    }

    const combo = {
        select,
        wrapper,
        input,
        list,
        options: [],
        matches: [],
        activeIndex: -1,
        open: false
    };

    wireCombo(combo);
    refreshCombo(select);

    return combo;
}


function comboLabelForValue(combo, value) {

    const match = combo.options.find(option => option.value === value);

    return match ? match.label : "";
}


/*
 * Mirrors the <select> into the combobox: option list, current
 * label and disabled state.
 */
function refreshCombo(select) {

    const combo = combos.get(select);

    if (!combo) {
        return;
    }

    combo.options = [...select.options].map(option => ({
        value: option.value,
        label: option.textContent.trim()
    }));

    combo.input.value = comboLabelForValue(combo, select.value);
    combo.input.placeholder =
        comboLabelForValue(combo, CONFIG.ALL) || "Search...";

    combo.input.disabled = select.disabled;
    combo.wrapper.classList.toggle("combo--disabled", select.disabled);

    if (select.disabled) {
        closeCombo(combo);
    }
}


function refreshAllCombos() {

    combos.forEach(combo => refreshCombo(combo.select));
}


function filterComboOptions(combo, query) {

    const term = normalizeKey(query);

    if (!term) {
        return combo.options;
    }

    const prefix = [];
    const contains = [];

    combo.options.forEach(option => {

        const label = normalizeKey(option.label);
        const index = label.indexOf(term);

        if (index === 0) {
            prefix.push(option);
        } else if (index > 0) {
            contains.push(option);
        }
    });

    /*
     * Prefix matches first, each group keeping the original
     * (alphabetical) order.
     */
    return [...prefix, ...contains];
}


function renderComboList(combo, query) {

    combo.matches = filterComboOptions(combo, query);
    combo.list.innerHTML = "";

    if (combo.matches.length === 0) {

        const empty = document.createElement("li");
        empty.className = "combo__empty";
        empty.textContent = "No matches";
        combo.list.appendChild(empty);

        combo.activeIndex = -1;
        combo.input.removeAttribute("aria-activedescendant");

        return;
    }

    const visible = combo.matches.slice(0, COMBO_RENDER_LIMIT);

    const fragment = document.createDocumentFragment();

    visible.forEach((option, index) => {

        const item = document.createElement("li");

        item.className = "combo__option";
        item.id = `${combo.select.id}Option${index}`;
        item.setAttribute("role", "option");
        item.setAttribute("data-value", option.value);
        item.textContent = option.label;

        if (option.value === combo.select.value) {
            item.classList.add("combo__option--selected");
            item.setAttribute("aria-selected", "true");
        } else {
            item.setAttribute("aria-selected", "false");
        }

        if (index === combo.activeIndex) {
            item.classList.add("combo__option--active");
        }

        fragment.appendChild(item);
    });

    combo.list.appendChild(fragment);

    if (combo.matches.length > visible.length) {

        const more = document.createElement("li");
        more.className = "combo__more";

        more.textContent =
            `Showing ${formatIndianNumber(visible.length)} of ` +
            `${formatIndianNumber(combo.matches.length)} — keep typing`;

        combo.list.appendChild(more);
    }
}


function openCombo(combo) {

    if (combo.select.disabled || combo.open) {
        return;
    }

    combo.open = true;
    combo.list.hidden = false;
    combo.input.setAttribute("aria-expanded", "true");

    /*
     * Start from the current selection so arrow keys continue
     * from where the user already is.
     */
    combo.activeIndex = combo.matches.findIndex(
        option => option.value === combo.select.value
    );

    renderComboList(combo, "");
}


function closeCombo(combo) {

    if (!combo.open) {
        return;
    }

    combo.open = false;
    combo.list.hidden = true;
    combo.activeIndex = -1;

    combo.input.setAttribute("aria-expanded", "false");
    combo.input.removeAttribute("aria-activedescendant");

    /*
     * Restore the label - a half-typed query should not look
     * like a selection.
     */
    combo.input.value = comboLabelForValue(combo, combo.select.value);
}


function setActiveComboOption(combo, index) {

    const rendered = [
        ...combo.list.querySelectorAll(".combo__option")
    ];

    if (rendered.length === 0) {
        return;
    }

    const clamped = Math.max(0, Math.min(index, rendered.length - 1));

    combo.activeIndex = clamped;

    rendered.forEach((item, position) => {
        item.classList.toggle("combo__option--active", position === clamped);
    });

    const active = rendered[clamped];

    combo.input.setAttribute("aria-activedescendant", active.id);

    if (typeof active.scrollIntoView === "function") {
        active.scrollIntoView({ block: "nearest" });
    }
}


function commitComboValue(combo, value) {

    if (combo.select.value === value) {
        closeCombo(combo);
        return;
    }

    combo.select.value = value;

    closeCombo(combo);

    combo.input.value = comboLabelForValue(combo, value);

    /*
     * Drives the existing change listeners, so the dashboard
     * reloads exactly as it does for a native select.
     */
    combo.select.dispatchEvent(new Event("change", { bubbles: true }));
}


function wireCombo(combo) {

    const { input, list } = combo;

    input.addEventListener("focus", () => {
        openCombo(combo);
        input.select();
    });

    input.addEventListener("click", () => {
        openCombo(combo);
    });

    input.addEventListener("input", () => {

        if (!combo.open) {
            combo.open = true;
            combo.list.hidden = false;
            combo.input.setAttribute("aria-expanded", "true");
        }

        combo.activeIndex = 0;
        renderComboList(combo, input.value);
        setActiveComboOption(combo, 0);
    });

    input.addEventListener("keydown", event => {

        if (event.key === "ArrowDown") {
            event.preventDefault();
            if (!combo.open) {
                openCombo(combo);
            }
            setActiveComboOption(combo, combo.activeIndex + 1);
            return;
        }

        if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveComboOption(combo, combo.activeIndex - 1);
            return;
        }

        if (event.key === "Home" && combo.open) {
            event.preventDefault();
            setActiveComboOption(combo, 0);
            return;
        }

        if (event.key === "End" && combo.open) {
            event.preventDefault();
            setActiveComboOption(combo, combo.matches.length - 1);
            return;
        }

        if (event.key === "Enter") {

            if (!combo.open) {
                return;
            }

            event.preventDefault();

            const active =
                combo.list.querySelector(".combo__option--active") ||
                combo.list.querySelector(".combo__option");

            if (active) {
                commitComboValue(combo, active.getAttribute("data-value"));
            }

            return;
        }

        if (event.key === "Escape") {
            event.preventDefault();
            closeCombo(combo);
            return;
        }

        if (event.key === "Tab") {
            closeCombo(combo);
        }
    });

    list.addEventListener("mousedown", event => {

        /*
         * mousedown, not click - otherwise the input blurs and
         * closes the list before the click lands.
         */
        const option = event.target.closest(".combo__option");

        if (!option) {
            return;
        }

        event.preventDefault();

        commitComboValue(combo, option.getAttribute("data-value"));
    });

    input.addEventListener("blur", () => {
        window.setTimeout(() => closeCombo(combo), 0);
    });
}


function setupComboDismiss() {

    document.addEventListener("mousedown", event => {

        combos.forEach(combo => {

            if (combo.open && !combo.wrapper.contains(event.target)) {
                closeCombo(combo);
            }
        });
    });
}


/* ============================================================
   10. READ FILTERS
   ============================================================ */

function readFiltersFromUI() {

    state.filters.rto = normalizeFilter(dom.rtoFilter?.value);
    state.filters.year = normalizeFilter(dom.yearFilter?.value);
    state.filters.month = normalizeFilter(dom.monthFilter?.value);

    const status = normalizeString(dom.statusFilter?.value).toLowerCase();

    state.filters.status = STATUSES[status] ? status : CONFIG.ALL;

    const grouping = normalizeString(dom.groupByFilter?.value).toLowerCase();

    state.groupBy = GROUPINGS[grouping] ? grouping : DEFAULT_GROUPING;
}


/* ============================================================
   11. FILTER + AGGREGATE

   The cached rows are already one-per-(dealer, rto, period), so
   filtering is a predicate and grouping is a single pass.
   ============================================================ */

function getFilteredSourceRows() {

    const { rto, year, month, dealers } = state.filters;

    return state.source.filter(row => {

        if (!isAll(rto) && row.rto_code !== rto) {
            return false;
        }

        if (!isAll(year) && String(row.report_year) !== year) {
            return false;
        }

        if (!isAll(month) && String(row.report_month) !== month) {
            return false;
        }

        if (dealers.length > 0 && !dealers.includes(row.dealer_name)) {
            return false;
        }

        return true;
    });
}


function aggregateRows(sourceRows) {

    const grouping = currentGrouping();
    const status = currentStatus();

    const buckets = new Map();

    sourceRows.forEach(row => {

        const key = grouping.keyOf(row);

        if (!key) {
            return;
        }

        let bucket = buckets.get(key);

        if (!bucket) {

            bucket = {
                key,
                entity: grouping.labelOf(key),
                fixed: 0,
                pending: 0,
                total: 0
            };

            buckets.set(key, bucket);
        }

        bucket.fixed += row.fixed;
        bucket.pending += row.pending;
        bucket.total += row.total;
    });

    let rows = [...buckets.values()];

    /*
     * A status filter narrows what the table measures: the
     * total becomes that status alone, and rows with none of it
     * drop out entirely - filtering to Pending should list the
     * dealers who actually have pending work, not every dealer
     * with a zero against their name.
     */
    if (status.field) {

        rows = rows
            .map(row => ({
                ...row,
                total: row[status.field]
            }))
            .filter(row => row.total > 0);
    }

    return rows;
}


/* ============================================================
   12. COLUMNS

   Column keys double as sort keys, so they match the field
   names on an aggregated row.
   ============================================================ */

function buildColumns() {

    const grouping = currentGrouping();
    const status = currentStatus();

    const columns = [
        { key: "index", label: "#", type: "index" },
        { key: "entity", label: grouping.entity, type: "entity" }
    ];

    if (status.field) {

        /*
         * One status selected: fixed vs pending is no longer a
         * split worth showing, and the fitment rate would be a
         * constant 100% or 0%. The total column carries the
         * status name instead.
         */
        columns.push({
            key: "total",
            label: status.label,
            type: "total"
        });

        return columns;
    }

    columns.push({ key: "fixed", label: "HSRP Fixed", type: "value" });
    columns.push({ key: "pending", label: "HSRP Pending", type: "value" });
    columns.push({ key: "rate", label: "Fitment %", type: "rate" });
    columns.push({ key: "total", label: "Total", type: "total" });

    return columns;
}


function isValidSortKey(key) {

    return state.columns.some(column => column.key === key);
}


/* ============================================================
   13. KPIs
   ============================================================ */

function calculateKPIs(rows) {

    const status = currentStatus();

    let fixed = 0;
    let pending = 0;
    let total = 0;

    rows.forEach(row => {
        fixed += row.fixed;
        pending += row.pending;
        total += row.total;
    });

    /*
     * Under a status filter the aggregate rows carry only that
     * status, so the other side of the split is zero by
     * definition rather than by measurement.
     */
    if (status.id === "fixed") {
        pending = 0;
    } else if (status.id === "pending") {
        fixed = 0;
    }

    const denominator = total > 0 ? total : 0;

    return {
        total,
        fixed,
        pending,
        fixedPct: denominator ? (fixed / denominator) * 100 : 0,
        pendingPct: denominator ? (pending / denominator) * 100 : 0,
        entities: rows.length
    };
}


function updateKPICards() {

    const kpis = state.kpis;
    const grouping = currentGrouping();
    const status = currentStatus();

    if (dom.totalApplications) {
        dom.totalApplications.textContent = formatIndianNumber(kpis.total);
    }

    if (dom.totalApplicationsMeta) {

        dom.totalApplicationsMeta.textContent =
            status.field
                ? `${status.label} only`
                : "All selected applications";
    }

    if (dom.fixedCount) {
        dom.fixedCount.textContent = formatIndianNumber(kpis.fixed);
    }

    if (dom.fixedPercentage) {

        dom.fixedPercentage.textContent =
            kpis.total > 0
                ? `${formatPercentage(kpis.fixedPct)} of selection`
                : "—";
    }

    if (dom.pendingCount) {
        dom.pendingCount.textContent = formatIndianNumber(kpis.pending);
    }

    if (dom.pendingPercentage) {

        dom.pendingPercentage.textContent =
            kpis.total > 0
                ? `${formatPercentage(kpis.pendingPct)} of selection`
                : "—";
    }

    if (dom.entityCount) {
        dom.entityCount.textContent = formatIndianNumber(kpis.entities);
    }

    if (dom.entityCountLabel) {
        dom.entityCountLabel.textContent = `Total ${grouping.entityPlural}`;
    }

    if (dom.entityCountMeta) {

        dom.entityCountMeta.textContent =
            `${grouping.entityPlural} with applications`;
    }
}


/* ============================================================
   14. SEARCH / SORT / PAGINATION
   ============================================================ */

function getActiveSearchTerms() {

    return state.searchTerms.map(normalizeKey).filter(Boolean);
}


function getSearchFilteredRows(rows) {

    const terms = getActiveSearchTerms();

    if (terms.length === 0) {
        return rows;
    }

    /*
     * Multiple boxes are OR-ed, so several dealers can be
     * compared side by side in one table.
     */
    return rows.filter(row => {

        const entity = normalizeKey(row.entity);

        return terms.some(term => entity.includes(term));
    });
}


function sortRows(rows) {

    const sorted = [...rows];
    const key = state.sortKey;

    sorted.sort((a, b) => {

        let result = 0;

        if (key === "entity") {

            result = String(a.entity).localeCompare(
                String(b.entity),
                undefined,
                { sensitivity: "base", numeric: true }
            );

        } else if (key === "rate") {

            /*
             * A row with no applications has no rate; park those
             * at the bottom rather than treating them as 0%.
             */
            const rateA = fitmentRate(a.fixed, a.total);
            const rateB = fitmentRate(b.fixed, b.total);

            result =
                (rateA === null ? -1 : rateA) -
                (rateB === null ? -1 : rateB);

        } else {

            result = toNumber(a[key]) - toNumber(b[key]);
        }

        /*
         * Ties fall back to the entity name so paging is stable.
         */
        if (result === 0) {
            result = String(a.entity).localeCompare(String(b.entity));
        }

        return state.sortDirection === "asc" ? result : -result;
    });

    return sorted;
}


function getPaginatedRows(rows) {

    const start = (state.currentPage - 1) * state.pageSize;

    return rows.slice(start, start + state.pageSize);
}


function sortIconFor(key) {

    if (key !== state.sortKey) {
        return "↕";
    }

    return state.sortDirection === "asc" ? "↑" : "↓";
}


/* ============================================================
   15. TABLE STATES
   ============================================================ */

function setTableState(mode, message) {

    if (dom.tableContent) {
        dom.tableContent.hidden = mode !== "data";
    }

    if (dom.tableLoading) {
        dom.tableLoading.hidden = mode !== "loading";
    }

    if (dom.tableEmpty) {
        dom.tableEmpty.hidden = mode !== "empty";
    }

    if (dom.tableError) {
        dom.tableError.hidden = mode !== "error";
    }

    if (mode === "empty" && dom.tableEmptyText && message) {
        dom.tableEmptyText.textContent = message;
    }

    if (mode === "error" && dom.tableErrorText && message) {
        dom.tableErrorText.textContent = message;
    }
}


/* ============================================================
   16. RENDER
   ============================================================ */

/*
 * Sticky classes are applied per cell. The first two columns pin
 * to the left and Total pins to the right, so the row label and
 * its total stay on screen while the middle scrolls.
 */
function cellClassFor(column) {

    if (column.type === "index") {
        return "col-index sticky-left sticky-left--index";
    }

    if (column.type === "entity") {
        return "col-entity sticky-left sticky-left--entity";
    }

    if (column.type === "total") {
        return "col-total sticky-right numeric-column";
    }

    if (column.type === "rate") {
        return "col-rate numeric-column";
    }

    return "col-value numeric-column";
}


/*
 * A numeric cell carries two figures: the count on the left and
 * its share of the column on the right. They go in a flex span
 * rather than on the cell itself, so the td stays a table-cell
 * and keeps its sticky positioning and column width.
 */
function fillNumericCell(cell, value, columnTotal, options = {}) {

    const split = document.createElement("span");
    split.className = "cell-split";

    const amount = document.createElement("span");
    amount.className = "cell-amount";
    amount.textContent = formatIndianNumber(value);

    if (options.alertWhenNonZero) {

        amount.classList.add(
            toNumber(value) === 0 ? "cell-amount--zero" : "cell-amount--alert"
        );
    }

    const share = document.createElement("span");
    share.className = "cell-share";
    share.textContent = formatShare(value, columnTotal);

    split.appendChild(amount);
    split.appendChild(share);

    cell.appendChild(split);
}


/*
 * The rate cell is not a share of anything else, so it shows a
 * single figure with a meter underneath - the column can then be
 * scanned for weak dealers without reading every number.
 */
function fillRateCell(cell, fixed, total) {

    const rate = fitmentRate(fixed, total);

    const box = document.createElement("span");
    box.className = "cell-rate";

    const value = document.createElement("span");
    value.className = "cell-rate__value";
    value.textContent = rate === null ? "—" : formatPercentage(rate);

    box.appendChild(value);

    if (rate !== null) {

        const meter = document.createElement("span");
        meter.className = "cell-rate__meter";

        const fill = document.createElement("span");
        fill.className = "cell-rate__fill";

        if (rate < CONFIG.RATE_LOW) {
            fill.classList.add("cell-rate__fill--low");
        } else if (rate < CONFIG.RATE_MID) {
            fill.classList.add("cell-rate__fill--mid");
        }

        fill.style.width = `${Math.max(0, Math.min(100, rate))}%`;

        meter.appendChild(fill);
        box.appendChild(meter);
    }

    cell.appendChild(box);
}


function calculateColumnTotals(rows) {

    const totals = { fixed: 0, pending: 0, total: 0 };

    rows.forEach(row => {
        totals.fixed += toNumber(row.fixed);
        totals.pending += toNumber(row.pending);
        totals.total += toNumber(row.total);
    });

    return totals;
}


function renderTableHead() {

    if (!dom.dealerSummaryTableHead) {
        return;
    }

    dom.dealerSummaryTableHead.innerHTML = "";

    const tr = document.createElement("tr");

    state.columns.forEach(column => {

        const th = document.createElement("th");

        th.scope = "col";
        th.className = cellClassFor(column);

        /*
         * The row number is a display counter, not data - there
         * is nothing meaningful to sort it by, so it gets a
         * plain header rather than a sort button.
         */
        if (column.type === "index") {

            th.textContent = column.label;
            tr.appendChild(th);

            return;
        }

        th.setAttribute("data-sort-key", column.key);

        th.setAttribute(
            "aria-sort",
            column.key === state.sortKey
                ? state.sortDirection === "asc"
                    ? "ascending"
                    : "descending"
                : "none"
        );

        const button = document.createElement("button");
        button.type = "button";
        button.className = "table-sort-button";
        button.setAttribute("data-sort", column.key);
        button.setAttribute("aria-label", `Sort by ${column.label}`);

        const label = document.createElement("span");
        label.textContent = column.label;

        const icon = document.createElement("span");
        icon.className = "sort-icon";
        icon.setAttribute("aria-hidden", "true");
        icon.textContent = sortIconFor(column.key);

        button.appendChild(label);
        button.appendChild(icon);
        th.appendChild(button);

        tr.appendChild(th);
    });

    dom.dealerSummaryTableHead.appendChild(tr);
}


function renderTableFoot(rows, shareTotals) {

    if (!dom.dealerSummaryTableFoot) {
        return;
    }

    dom.dealerSummaryTableFoot.innerHTML = "";

    const totals = calculateColumnTotals(rows);

    const tr = document.createElement("tr");

    state.columns.forEach(column => {

        const cell = document.createElement(
            column.type === "entity" ? "th" : "td"
        );

        cell.className = cellClassFor(column);

        if (column.type === "index") {

            cell.textContent = "";

        } else if (column.type === "entity") {

            cell.scope = "row";
            cell.textContent = `Total (${formatIndianNumber(rows.length)})`;

        } else if (column.type === "rate") {

            fillRateCell(cell, totals.fixed, totals.total);

        } else {

            /*
             * Against the unsearched denominator this reads 100%
             * on the full list, and on a search it reads how much
             * of the selection the matches account for.
             */
            fillNumericCell(
                cell,
                totals[column.key],
                shareTotals[column.key]
            );
        }

        tr.appendChild(cell);
    });

    dom.dealerSummaryTableFoot.appendChild(tr);
}


function renderTable() {

    if (!dom.dealerSummaryTableBody) {
        return;
    }

    const grouping = currentGrouping();

    if (dom.dealerSummaryTable) {

        dom.dealerSummaryTable.classList.toggle(
            "data-table--narrow-entity",
            grouping.narrow
        );
    }

    const searched = getSearchFilteredRows(state.rows);
    const rows = sortRows(searched);

    state.filteredRows = rows;

    const totalPages = Math.max(1, Math.ceil(rows.length / state.pageSize));

    if (state.currentPage > totalPages) {
        state.currentPage = totalPages;
    }

    const pageRows = getPaginatedRows(rows);

    /*
     * Two sets of totals, because they answer different
     * questions. The foot sums what is on screen, so it follows
     * the search. Share must not - searching for one dealer would
     * otherwise show it holding 100% of the work - so its
     * denominator stays the unsearched set, leaving a dealer's
     * share identical whether or not it was searched for.
     * Filters still apply to both: they define the selection
     * being measured.
     */
    const shareTotals =
        state.searchTerms.length === 0
            ? calculateColumnTotals(rows)
            : calculateColumnTotals(state.rows);

    dom.dealerSummaryTableBody.innerHTML = "";

    renderTableHead();
    renderTableFoot(rows, shareTotals);

    updateResultCount(rows.length, state.rows.length);
    updatePagination(totalPages);

    if (rows.length === 0) {

        const terms = state.searchTerms.map(normalizeString).filter(Boolean);
        const entity = grouping.entity.toLowerCase();

        let message = "No data found for the selected filters.";

        if (terms.length === 1) {
            message = `No ${entity} matches "${terms[0]}".`;
        } else if (terms.length > 1) {
            message =
                `No ${entity} matches ` +
                terms.map(term => `"${term}"`).join(" or ") + ".";
        }

        setTableState("empty", message);

        return;
    }

    setTableState("data");

    const startIndex = (state.currentPage - 1) * state.pageSize;

    const fragment = document.createDocumentFragment();

    pageRows.forEach((row, offset) => {

        const tr = document.createElement("tr");

        state.columns.forEach(column => {

            const td = document.createElement("td");

            td.className = cellClassFor(column);

            if (column.type === "index") {

                td.textContent =
                    formatIndianNumber(startIndex + offset + 1);

            } else if (column.type === "entity") {

                td.textContent = row.entity;
                td.title = row.entity;

            } else if (column.type === "rate") {

                fillRateCell(td, row.fixed, row.total);

            } else {

                fillNumericCell(
                    td,
                    row[column.key],
                    shareTotals[column.key],
                    { alertWhenNonZero: column.key === "pending" }
                );
            }

            tr.appendChild(td);
        });

        fragment.appendChild(tr);
    });

    dom.dealerSummaryTableBody.appendChild(fragment);
}


function updateResultCount(shown, total) {

    if (!dom.resultCount) {
        return;
    }

    const plural = currentGrouping().entityPlural.toLowerCase();

    dom.resultCount.textContent =
        shown === total
            ? `${formatIndianNumber(total)} ${plural}`
            : `${formatIndianNumber(shown)} of ` +
              `${formatIndianNumber(total)} ${plural}`;
}


function updatePagination(totalPages) {

    if (dom.pageIndicator) {
        dom.pageIndicator.textContent =
            `Page ${state.currentPage} of ${totalPages}`;
    }

    if (dom.previousPageButton) {
        dom.previousPageButton.disabled = state.currentPage <= 1;
    }

    if (dom.nextPageButton) {
        dom.nextPageButton.disabled = state.currentPage >= totalPages;
    }
}


function updateViewLabels() {

    const grouping = currentGrouping();

    if (dom["dealer-summary-title"]) {
        dom["dealer-summary-title"].textContent = grouping.title;
    }

    getSearchInputs().forEach(input => {

        if (input) {
            input.placeholder = grouping.searchPlaceholder;
        }
    });
}


function updateActiveFilters() {

    if (!dom.activeFilters) {
        return;
    }

    dom.activeFilters.innerHTML = "";

    const fragment = document.createDocumentFragment();

    const label = document.createElement("span");
    label.className = "active-filters__label";
    label.textContent = "Active Filters:";
    fragment.appendChild(label);

    let count = 0;

    function addFilter(name, value) {

        if (isAll(value) || value === "") {
            return;
        }

        count += 1;

        const element = document.createElement("span");
        element.className = "active-filter";

        const strong = document.createElement("strong");
        strong.textContent = `${name}:`;

        element.appendChild(strong);
        element.appendChild(document.createTextNode(` ${value}`));

        fragment.appendChild(element);
    }

    addFilter("RTO", state.filters.rto);
    addFilter("Year", state.filters.year);

    if (!isAll(state.filters.month)) {
        addFilter(
            "Month",
            MONTH_NAMES[toNumber(state.filters.month)] || state.filters.month
        );
    }

    if (currentStatus().field) {
        addFilter("Status", currentStatus().label);
    }

    if (registrationIsActive()) {
        addFilter("Registration", state.registration);
    }

    if (state.filters.dealers.length > 0) {
        addFilter("Dealer", state.filters.dealers.join(", "));
    }

    /*
     * Grouping always has a value, so it is listed separately and
     * does not count towards "no filters".
     */
    addFilter("Summarised by", currentGrouping().entity);

    if (count <= 1) {

        const empty = document.createElement("span");
        empty.className = "active-filter active-filter--empty";
        empty.textContent = "No other filters";

        fragment.appendChild(empty);
    }

    dom.activeFilters.appendChild(fragment);
}


function updatePeriodHeader() {

    const element = dom["data-year-range"];

    if (!element) {
        return;
    }

    element.textContent = state.periodRange || "—";
}


function updateDatasetNote() {

    if (!dom.datasetNote) {
        return;
    }

    const grouping = currentGrouping();
    const status = currentStatus();

    const scope = isAll(state.filters.rto)
        ? "All RTOs"
        : state.filters.rto;

    const parts = [
        `Source: ${SUMMARY_TABLE}`,
        scope,
        status.field ? status.label : "all statuses",
        `${formatIndianNumber(state.kpis.total)} applications across ` +
        `${formatIndianNumber(state.rows.length)} ` +
        `${grouping.entityPlural.toLowerCase()}`
    ];

    dom.datasetNote.hidden = false;
    dom.datasetNote.textContent = `${parts.join(" · ")}.`;
}


/* ============================================================
   17. LOADING / ERROR
   ============================================================ */

function showLoading({ global = false } = {}) {

    state.loading = true;

    if (global && dom.globalLoading) {
        dom.globalLoading.hidden = false;
    }

    setTableState("loading");
}


function hideLoading() {

    state.loading = false;

    if (dom.globalLoading) {
        dom.globalLoading.hidden = true;
    }
}


function displayError(error, fallback) {

    const message = error?.message || fallback;

    console.error(error);

    if (dom.errorMessage && dom.errorMessageText) {
        dom.errorMessageText.textContent = message;
        dom.errorMessage.hidden = false;
    }

    setTableState("error", message);
}


function clearError() {

    if (dom.errorMessage) {
        dom.errorMessage.hidden = true;
    }
}


function setupRetry() {

    if (state.retryWired || !dom.retryButton) {
        return;
    }

    dom.retryButton.addEventListener("click", async () => {

        clearError();

        state.sourceLoaded = false;

        await initializeDashboard({ force: true });
    });

    state.retryWired = true;
}


/* ============================================================
   18. APPLY FILTERS

   No network call: everything below runs against the cached
   rows, so a filter change is a synchronous re-render.
   ============================================================ */

function applyFilters() {

    try {

        clearError();

        readFiltersFromUI();

        state.columns = buildColumns();

        /*
         * The visible column set changes with the status filter,
         * so a sort key can go out of scope underneath the user.
         */
        if (!isValidSortKey(state.sortKey)) {
            state.sortKey = "total";
            state.sortDirection = "desc";
        }

        const sourceRows = getFilteredSourceRows();

        state.rows = aggregateRows(sourceRows);
        state.kpis = calculateKPIs(state.rows);

        state.currentPage = 1;

        updateViewLabels();
        updateKPICards();
        updateActiveFilters();
        updateDatasetNote();

        /*
         * Two views, never both: the full dealer list, or one
         * Year x Month table per selected dealer.
         */
        const showDealers = state.filters.dealers.length > 0;

        setViewMode(showDealers ? "dealers" : "all");

        if (showDealers) {
            renderDealerDetail(sourceRows);
        } else {
            renderTable();
        }

    } catch (error) {

        state.rows = [];
        state.filteredRows = [];
        state.kpis = emptyKPIs();

        updateKPICards();

        displayError(error, "Could not apply filters.");
    }
}


/* ============================================================
   19. RESET
   ============================================================ */

function resetFilters() {

    if (dom.rtoFilter) {
        dom.rtoFilter.value = CONFIG.ALL;
    }

    if (dom.yearFilter) {
        dom.yearFilter.value = CONFIG.ALL;
    }

    if (dom.monthFilter) {
        dom.monthFilter.value = CONFIG.ALL;
    }

    if (dom.statusFilter) {
        dom.statusFilter.value = CONFIG.ALL;
    }

    if (dom.dealerFilter) {
        dom.dealerFilter.value = CONFIG.ALL;
    }

    state.filters.dealers = [];
    renderDealerChips();

    clearRegistrationSearch({ apply: false });

    if (dom.groupByFilter) {
        dom.groupByFilter.value = DEFAULT_GROUPING;
    }

    refreshAllCombos();

    clearTableSearch({ render: false });

    state.sortKey = "total";
    state.sortDirection = "desc";
    state.currentPage = 1;

    applyFilters();
}


/* ============================================================
   20. SEARCH ROWS
   ============================================================ */

function getSearchRows() {

    if (!dom.entitySearchList) {
        return [];
    }

    return [...dom.entitySearchList.querySelectorAll("[data-search-row]")];
}


function getSearchInputs() {

    return getSearchRows().map(row =>
        row.querySelector("[data-entity-search]")
    );
}


function syncSearchRows() {

    const rows = getSearchRows();
    const grouping = currentGrouping();

    state.searchTerms = rows.map(row => {

        const input = row.querySelector("[data-entity-search]");

        return input ? normalizeString(input.value) : "";
    });

    rows.forEach((row, index) => {

        const input = row.querySelector("[data-entity-search]");
        const addButton = row.querySelector("[data-add-search]");
        const removeButton = row.querySelector("[data-remove-search]");
        const clearButton = row.querySelector("[data-clear-search]");

        const isFirst = index === 0;

        if (input) {

            input.placeholder = grouping.searchPlaceholder;

            input.setAttribute(
                "aria-label",
                rows.length > 1
                    ? `Search ${grouping.entityPlural.toLowerCase()}, ` +
                      `box ${index + 1} of ${rows.length}`
                    : `Search ${grouping.entityPlural.toLowerCase()}`
            );
        }

        if (addButton) {

            addButton.hidden = !isFirst;
            addButton.disabled = rows.length >= CONFIG.MAX_SEARCH_ROWS;

            addButton.title =
                rows.length >= CONFIG.MAX_SEARCH_ROWS
                    ? `Maximum of ${CONFIG.MAX_SEARCH_ROWS} searches`
                    : "Add another search";
        }

        if (removeButton) {
            removeButton.hidden = isFirst;
        }

        if (clearButton) {
            clearButton.hidden = !(input && input.value);
        }
    });
}


function addSearchRow({ focus = true } = {}) {

    if (
        !dom.entitySearchList ||
        !dom.searchRowTemplate ||
        getSearchRows().length >= CONFIG.MAX_SEARCH_ROWS
    ) {
        return null;
    }

    const fragment = dom.searchRowTemplate.content.cloneNode(true);
    const row = fragment.querySelector("[data-search-row]");

    dom.entitySearchList.appendChild(fragment);

    syncSearchRows();

    if (focus) {

        const input = row?.querySelector("[data-entity-search]");

        if (input) {
            input.focus();
        }
    }

    return row;
}


function removeSearchRow(row) {

    if (!row || getSearchRows().length <= 1) {
        return;
    }

    row.remove();

    syncSearchRows();

    state.currentPage = 1;

    renderTable();
}


function applySearchChange() {

    syncSearchRows();

    state.currentPage = 1;

    renderTable();
}


function setupSearch() {

    if (!dom.entitySearchList) {
        return;
    }

    if (getSearchRows().length === 0) {
        addSearchRow({ focus: false });
    }

    dom.entitySearchList.addEventListener("input", event => {

        if (!event.target.closest("[data-entity-search]")) {
            return;
        }

        clearTimeout(state.searchTimer);

        state.searchTimer = setTimeout(
            applySearchChange,
            CONFIG.SEARCH_DELAY
        );
    });

    dom.entitySearchList.addEventListener("click", event => {

        if (event.target.closest("[data-add-search]")) {
            addSearchRow();
            return;
        }

        const removeButton = event.target.closest("[data-remove-search]");

        if (removeButton) {
            removeSearchRow(removeButton.closest("[data-search-row]"));
            return;
        }

        const clearButton = event.target.closest("[data-clear-search]");

        if (clearButton) {

            const row = clearButton.closest("[data-search-row]");
            const input = row?.querySelector("[data-entity-search]");

            if (input) {
                input.value = "";
                input.focus();
            }

            applySearchChange();
        }
    });
}


function clearTableSearch({ render = true } = {}) {

    clearTimeout(state.searchTimer);

    getSearchRows().forEach((row, index) => {

        if (index === 0) {

            const input = row.querySelector("[data-entity-search]");

            if (input) {
                input.value = "";
            }

        } else {
            row.remove();
        }
    });

    syncSearchRows();

    state.currentPage = 1;

    if (render) {
        renderTable();
    }
}


/* ============================================================
   21. EVENT WIRING
   ============================================================ */

function setupSorting() {

    document.addEventListener("click", event => {

        const button = event.target.closest("[data-sort]");

        if (!button) {
            return;
        }

        const key = button.dataset.sort;

        if (!isValidSortKey(key)) {
            return;
        }

        if (state.sortKey === key) {

            state.sortDirection =
                state.sortDirection === "asc" ? "desc" : "asc";

        } else {

            state.sortKey = key;

            /*
             * Text reads best A-Z, numbers biggest-first.
             */
            state.sortDirection = key === "entity" ? "asc" : "desc";
        }

        state.currentPage = 1;

        renderTable();
    });
}


function setupPagination() {

    if (dom.previousPageButton) {

        dom.previousPageButton.addEventListener("click", () => {

            if (state.currentPage > 1) {
                state.currentPage -= 1;
                renderTable();
            }
        });
    }

    if (dom.nextPageButton) {

        dom.nextPageButton.addEventListener("click", () => {

            const totalPages = Math.max(
                1,
                Math.ceil(state.filteredRows.length / state.pageSize)
            );

            if (state.currentPage < totalPages) {
                state.currentPage += 1;
                renderTable();
            }
        });
    }

    if (dom.pageSizeSelect) {

        dom.pageSizeSelect.value = String(state.pageSize);

        dom.pageSizeSelect.addEventListener("change", () => {

            state.pageSize =
                toNumber(dom.pageSizeSelect.value) || CONFIG.PAGE_SIZE;

            state.currentPage = 1;

            renderTable();
        });
    }
}


function setupFilterListeners() {

    const selects = [
        dom.rtoFilter,
        dom.yearFilter,
        dom.monthFilter,
        dom.statusFilter,
        dom.dealerFilter,
        dom.groupByFilter
    ];

    selects.forEach(select => {

        if (!select) {
            return;
        }

        select.addEventListener("change", () => {

            /*
             * Dealer is additive: choosing one adds a chip and
             * the control returns to All, so several can be
             * picked in turn.
             */
            if (select === dom.dealerFilter) {
                addDealer(normalizeFilter(select.value));
                select.value = CONFIG.ALL;
                refreshCombo(select);
                renderDealerChips();
            }

            /*
             * Grouping changes what a search term is matched
             * against, so a stale dealer search would silently
             * empty the table after switching to RTO.
             */
            if (select === dom.groupByFilter) {
                clearTableSearch({ render: false });
            }

            applyFilters();
        });
    });

    if (dom.dashboardFilters) {

        dom.dashboardFilters.addEventListener("submit", event => {
            event.preventDefault();
            applyFilters();
        });
    }

    if (dom.clearFiltersButton) {
        dom.clearFiltersButton.addEventListener("click", resetFilters);
    }
}


/* ============================================================
   22. INITIALIZATION
   ============================================================ */

async function initializeDashboard({ force = false } = {}) {

    if (state.initialized && !force) {
        return;
    }

    cacheDOM();
    setupRetry();

    showLoading({ global: true });

    try {

        initializeApi();

        /*
         * Built before the options load, so populateSelect can
         * mirror straight into them.
         */
        enhanceFilterSelects();

        await loadDataset();

        loadFilterOptions();

        if (!state.wired) {
            setupSearch();
            setupSorting();
            setupPagination();
            setupFilterListeners();
            setupComboDismiss();
            setupDealerChips();
            setupRegistrationSearch();
            state.wired = true;
        }

        updatePeriodHeader();

        applyFilters();

    } catch (error) {

        state.rows = [];
        state.filteredRows = [];
        state.kpis = emptyKPIs();

        updateKPICards();

        if (dom.datasetNote) {
            dom.datasetNote.hidden = true;
        }

        displayError(
            error,
            "Dashboard initialization failed. Is the API running on " +
            `${API_URL}?`
        );

    } finally {

        state.initialized = true;

        hideLoading();
    }
}


/* ============================================================
   DEALER SELECTION + PER-DEALER TABLES

   With no dealer selected the dashboard shows the usual list of
   every dealer. Selecting one or more switches the view: each
   selected dealer gets its own Year x Month table, stacked, with
   the dealer name as the heading.

   Cells carry the count and the fitment percentage, using the
   same split cell as the main table.
   ============================================================ */

function renderDealerChips() {

    if (!dom.dealerChips) {
        return;
    }

    dom.dealerChips.innerHTML = "";

    const fragment = document.createDocumentFragment();

    state.filters.dealers.forEach(name => {

        const chip = document.createElement("span");
        chip.className = "dealer-chip";

        const label = document.createElement("span");
        label.className = "dealer-chip__name";
        label.textContent = name;
        label.title = name;

        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "dealer-chip__remove";
        remove.setAttribute("data-remove-dealer", name);
        remove.setAttribute("aria-label", "Remove " + name);
        remove.textContent = "×";

        chip.appendChild(label);
        chip.appendChild(remove);

        fragment.appendChild(chip);
    });

    dom.dealerChips.appendChild(fragment);
}


function addDealer(name) {

    const value = normalizeString(name);

    if (!value || isAll(value)) {
        return;
    }

    if (!state.filters.dealers.includes(value)) {
        state.filters.dealers.push(value);
    }
}


function removeDealer(name) {

    state.filters.dealers = state.filters.dealers.filter(
        dealer => dealer !== name
    );
}


function setupDealerChips() {

    if (!dom.dealerChips) {
        return;
    }

    dom.dealerChips.addEventListener("click", event => {

        const button = event.target.closest("[data-remove-dealer]");

        if (!button) {
            return;
        }

        removeDealer(button.getAttribute("data-remove-dealer"));

        renderDealerChips();
        applyFilters();
    });
}


/*
 * Collapses one dealer's rows into a year x month grid.
 */
function buildDealerGrid(rows) {

    const months = [
        ...new Set(rows.map(row => row.report_month))
    ].sort((a, b) => a - b);

    const years = [
        ...new Set(rows.map(row => row.report_year))
    ].sort((a, b) => a - b);

    const cells = new Map();
    const yearTotals = new Map();
    const monthTotals = new Map();

    const grand = { total: 0, fixed: 0, pending: 0 };

    function bump(map, key, row) {

        let entry = map.get(key);

        if (!entry) {
            entry = { total: 0, fixed: 0, pending: 0 };
            map.set(key, entry);
        }

        entry.total += row.total;
        entry.fixed += row.fixed;
        entry.pending += row.pending;
    }

    rows.forEach(row => {

        bump(cells, row.report_year + "-" + row.report_month, row);
        bump(yearTotals, String(row.report_year), row);
        bump(monthTotals, String(row.report_month), row);

        grand.total += row.total;
        grand.fixed += row.fixed;
        grand.pending += row.pending;
    });

    return { months, years, cells, yearTotals, monthTotals, grand };
}


/*
 * Count on the left, share of the column on the right - the same
 * split cell, and the same meaning of "%", as the main table.
 * Fitment rate is not useful per cell: most dealers have nothing
 * pending, so it would read 100% almost everywhere. It is shown
 * once per dealer in the card heading instead.
 */
function fillDealerCell(cell, values, denominator) {

    if (!values || values.total === 0) {
        cell.textContent = "";
        return;
    }

    const split = document.createElement("span");
    split.className = "cell-split";

    const amount = document.createElement("span");
    amount.className = "cell-amount";
    amount.textContent = formatIndianNumber(values.total);

    const share = document.createElement("span");
    share.className = "cell-share";
    share.textContent = formatShare(values.total, denominator);

    split.appendChild(amount);
    split.appendChild(share);

    cell.appendChild(split);
}


function buildDealerTable(grid) {

    const table = document.createElement("table");
    table.className = "data-table";

    /* Head: Year, then one column per month, then Total. */
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");

    const corner = document.createElement("th");
    corner.scope = "col";
    corner.className = "col-entity col-year sticky-left sticky-left--entity";
    corner.textContent = "Year";
    headRow.appendChild(corner);

    grid.months.forEach(month => {

        const th = document.createElement("th");
        th.scope = "col";
        th.className = "col-value col-month numeric-column month-group";
        th.textContent = MONTH_NAMES[month] || String(month);

        headRow.appendChild(th);
    });

    const totalHead = document.createElement("th");
    totalHead.scope = "col";
    totalHead.className = "col-total sticky-right numeric-column";
    totalHead.textContent = "Total";
    headRow.appendChild(totalHead);

    thead.appendChild(headRow);
    table.appendChild(thead);

    /* Body: one row per year. */
    const tbody = document.createElement("tbody");

    grid.years.forEach(year => {

        const tr = document.createElement("tr");

        const head = document.createElement("th");
        head.scope = "row";
        head.className = "col-entity col-year sticky-left sticky-left--entity";
        head.textContent = String(year);
        tr.appendChild(head);

        grid.months.forEach(month => {

            const td = document.createElement("td");
            td.className = "col-value col-month numeric-column";

            fillDealerCell(
                td,
                grid.cells.get(year + "-" + month),
                grid.monthTotals.get(String(month))?.total
            );

            tr.appendChild(td);
        });

        const totalCell = document.createElement("td");
        totalCell.className = "col-total sticky-right numeric-column";

        fillDealerCell(
            totalCell,
            grid.yearTotals.get(String(year)),
            grid.grand.total
        );

        tr.appendChild(totalCell);
        tbody.appendChild(tr);
    });

    table.appendChild(tbody);

    /* Foot: column totals. */
    const tfoot = document.createElement("tfoot");
    const footRow = document.createElement("tr");

    const footHead = document.createElement("th");
    footHead.scope = "row";
    footHead.className = "col-entity col-year sticky-left sticky-left--entity";
    footHead.textContent = "Total";
    footRow.appendChild(footHead);

    grid.months.forEach(month => {

        const td = document.createElement("td");
        td.className = "col-value col-month numeric-column";

        fillDealerCell(
            td,
            grid.monthTotals.get(String(month)),
            grid.grand.total
        );

        footRow.appendChild(td);
    });

    const grandCell = document.createElement("td");
    grandCell.className = "col-total sticky-right numeric-column";

    fillDealerCell(grandCell, grid.grand, grid.grand.total);

    footRow.appendChild(grandCell);
    tfoot.appendChild(footRow);
    table.appendChild(tfoot);

    return table;
}


function buildDealerCard(name, rows) {

    const section = document.createElement("div");
    section.className = "table-card dealer-card";

    const heading = document.createElement("div");
    heading.className = "section-heading section-heading--table";

    const headingInner = document.createElement("div");

    const eyebrow = document.createElement("span");
    eyebrow.className = "section-eyebrow";
    eyebrow.textContent = "DEALER";

    const title = document.createElement("h2");
    title.textContent = name;

    headingInner.appendChild(eyebrow);
    headingInner.appendChild(title);

    if (rows.length > 0) {

        const grid = buildDealerGrid(rows);

        const meta = document.createElement("div");
        meta.className = "dealer-card__meta";

        [
            ["Total", formatIndianNumber(grid.grand.total)],
            ["Fixed", formatIndianNumber(grid.grand.fixed)],
            ["Pending", formatIndianNumber(grid.grand.pending)],
            ["Fitment", formatShare(grid.grand.fixed, grid.grand.total)]
        ].forEach(([label, value]) => {

            const stat = document.createElement("span");
            stat.className = "dealer-card__stat";

            const strong = document.createElement("strong");
            strong.textContent = value;

            stat.appendChild(strong);
            stat.appendChild(document.createTextNode(" " + label));

            meta.appendChild(stat);
        });

        headingInner.appendChild(meta);
        heading.appendChild(headingInner);
        section.appendChild(heading);

        const wrapper = document.createElement("div");
        wrapper.className = "table-wrapper";
        wrapper.appendChild(buildDealerTable(grid));

        section.appendChild(wrapper);

        return section;
    }

    heading.appendChild(headingInner);
    section.appendChild(heading);

    const empty = document.createElement("div");
    empty.className = "table-state table-state--empty";

    const text = document.createElement("p");
    text.textContent =
        "No applications for this dealer under the current filters.";

    empty.appendChild(text);
    section.appendChild(empty);

    return section;
}


function renderDealerDetail(sourceRows) {

    if (!dom.dealerDetailSection) {
        return;
    }

    dom.dealerDetailSection.innerHTML = "";

    const fragment = document.createDocumentFragment();

    state.filters.dealers.forEach(name => {

        const rows = sourceRows.filter(row => row.dealer_name === name);

        fragment.appendChild(buildDealerCard(name, rows));
    });

    dom.dealerDetailSection.appendChild(fragment);
}





/* ============================================================
   REGISTRATION LOOKUP

   Searching a registration number shows the record exactly as it
   is stored - every column of the RTO table, unchanged - with one
   exception: report_month is a number in the table and a month
   name on screen.

   The raw tables are not readable through the API, because they
   carry owner names. This goes through hsrp_lookup_registration,
   a function that answers only exact, complete registration
   numbers and returns at most 10 rows, so it cannot be used to
   list or enumerate the records behind it.
   ============================================================ */

const REGISTRATION_MIN_LENGTH = 7;


/*
 * Case and spacing are ignored by the lookup, so the input is
 * normalised the same way here for display and comparison.
 */
function normalizeRegistration(value) {

    return normalizeString(value).replace(/\s+/g, "").toUpperCase();
}


async function lookupRegistration(value) {

    const query = normalizeRegistration(value);

    const url =
        `${API_URL}/rpc/hsrp_lookup_registration` +
        `?p_reg=${encodeURIComponent(query)}`;

    const response = await fetch(url, { headers: authHeaders() });

    if (!response.ok) {

        let message = `${response.status} ${response.statusText}`;

        try {
            const body = await response.json();
            if (body && body.message) {
                message = body.message;
            }
        } catch (ignored) {
            /* non-JSON error body */
        }

        throw new Error(`Registration lookup failed: ${message}`);
    }

    return response.json();
}


function monthNameOf(value) {

    return MONTH_NAMES[toNumber(value)] || normalizeString(value);
}


/*
 * One row per column, because a single record reads better down
 * the page than across it - the address alone would blow out a
 * horizontal layout.
 */
function buildRecordTable(record) {

    const table = document.createElement("table");
    table.className = "record-table";

    const body = document.createElement("tbody");

    const rows = [
        ["RTO", record.rto_code],
        ["S.No.", formatIndianNumber(record.sr_no)],
        ["Month", monthNameOf(record.report_month)],
        ["Year", normalizeString(record.report_year)],
        ["Application No", record.application_no],
        ["Vehicle Registration No", record.vehicle_registration_no],
        ["Owner Name", record.owner_name],
        ["Dealer Name", record.dealer_name],
        ["Dealer Address", record.dealer_address],
        ["Status", record.status]
    ];

    rows.forEach(([label, value]) => {

        const tr = document.createElement("tr");

        const th = document.createElement("th");
        th.scope = "row";
        th.textContent = label;

        const td = document.createElement("td");

        const text = normalizeString(value);

        if (label === "Status" && text) {

            const badge = document.createElement("span");

            badge.className =
                "record-status " +
                (text === "HSRP Fixed"
                    ? "record-status--fixed"
                    : "record-status--pending");

            badge.textContent = text;
            td.appendChild(badge);

        } else {
            td.textContent = text || "—";
        }

        tr.appendChild(th);
        tr.appendChild(td);
        body.appendChild(tr);
    });

    table.appendChild(body);

    return table;
}


function buildRecordCard(record, index, count) {

    const card = document.createElement("div");
    card.className = "table-card dealer-card";

    const heading = document.createElement("div");
    heading.className = "section-heading section-heading--table";

    const inner = document.createElement("div");

    const eyebrow = document.createElement("span");
    eyebrow.className = "section-eyebrow";
    eyebrow.textContent =
        count > 1 ? `RECORD ${index + 1} OF ${count}` : "RECORD";

    const title = document.createElement("h2");
    title.textContent = normalizeString(record.vehicle_registration_no);

    inner.appendChild(eyebrow);
    inner.appendChild(title);

    const meta = document.createElement("div");
    meta.className = "dealer-card__meta";

    const period = document.createElement("span");
    period.className = "dealer-card__stat";
    period.textContent =
        `${monthNameOf(record.report_month)} ${record.report_year} · ` +
        `${normalizeString(record.rto_code)}`;

    meta.appendChild(period);
    inner.appendChild(meta);

    heading.appendChild(inner);
    card.appendChild(heading);

    const wrapper = document.createElement("div");
    wrapper.className = "table-wrapper";
    wrapper.appendChild(buildRecordTable(record));

    card.appendChild(wrapper);

    return card;
}


function renderRegistrationMessage(text, query) {

    const card = document.createElement("div");
    card.className = "table-card";

    const message = document.createElement("p");
    message.className = "record-empty";

    if (query) {

        const strong = document.createElement("strong");
        strong.textContent = query;

        message.appendChild(document.createTextNode(text + " "));
        message.appendChild(strong);

    } else {
        message.textContent = text;
    }

    card.appendChild(message);

    return card;
}


function renderRegistrationResult(records, query) {

    if (!dom.registrationSection) {
        return;
    }

    dom.registrationSection.innerHTML = "";

    if (!Array.isArray(records) || records.length === 0) {

        dom.registrationSection.appendChild(
            renderRegistrationMessage("No record found for", query)
        );

        return;
    }

    const fragment = document.createDocumentFragment();

    records.forEach((record, index) =>
        fragment.appendChild(buildRecordCard(record, index, records.length))
    );

    dom.registrationSection.appendChild(fragment);
}


/*
 * The lookup takes over the page while it is active, the same way
 * selecting dealers does.
 */
function registrationIsActive() {

    return normalizeRegistration(state.registration).length > 0;
}


async function applyRegistrationSearch() {

    const query = normalizeRegistration(dom.registrationInput?.value);

    state.registration = query;

    if (!query) {

        /* Cleared - hand the page back to the normal views. */
        applyFilters();
        return;
    }

    setViewMode("registration");

    if (query.length < REGISTRATION_MIN_LENGTH) {

        renderRegistrationResult(
            [],
            `${query} — enter the complete number`
        );

        updateActiveFilters();

        return;
    }

    try {

        clearError();

        const records = await lookupRegistration(query);

        renderRegistrationResult(records, query);

    } catch (error) {

        renderRegistrationResult([], query);

        displayError(error, "Registration lookup failed.");
    }

    updateActiveFilters();
}


function clearRegistrationSearch({ apply = true } = {}) {

    if (dom.registrationInput) {
        dom.registrationInput.value = "";
    }

    state.registration = "";

    if (dom.registrationSection) {
        dom.registrationSection.innerHTML = "";
    }

    if (apply) {
        applyFilters();
    }
}


function setupRegistrationSearch() {

    if (dom.registrationButton) {
        dom.registrationButton.addEventListener(
            "click",
            applyRegistrationSearch
        );
    }

    if (!dom.registrationInput) {
        return;
    }

    dom.registrationInput.addEventListener("keydown", event => {

        if (event.key === "Enter") {
            event.preventDefault();
            applyRegistrationSearch();
        }
    });

    /*
     * The native clear "x" fires input with an empty value; that
     * should restore the dashboard rather than search for nothing.
     */
    dom.registrationInput.addEventListener("input", () => {

        if (!normalizeRegistration(dom.registrationInput.value)) {
            clearRegistrationSearch();
        }
    });
}


/*
 * Exactly one of the three views is visible at a time.
 */
function setViewMode(mode) {

    if (dom.allDealersSection) {
        dom.allDealersSection.hidden = mode !== "all";
    }

    if (dom.dealerDetailSection) {
        dom.dealerDetailSection.hidden = mode !== "dealers";
    }

    if (dom.registrationSection) {
        dom.registrationSection.hidden = mode !== "registration";
    }
}


/* ============================================================
   23. GLOBAL API
   ============================================================ */

window.hsrpDashboard = {
    initializeDashboard,
    applyFilters,
    resetFilters,
    clearTableSearch,
    loadDataset,
    state
};


/* ============================================================
   24. DOM READY
   ============================================================ */

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
        initializeDashboard();
    });
} else {
    initializeDashboard();
}
