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
   and then does every filter, grouping and page in memory.
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
 * The row hierarchy, chosen with the checkbox panel on the left.
 * Tick order is hierarchy order: Year then RTO gives Year > RTO,
 * every level expandable.
 *
 * Months run across the top of the matrix, so Month here adds a
 * month level down the side as well - the reference report has
 * the same field available on both axes.
 */
const ROW_FIELDS = [
    {
        id: "year",
        label: "Year",
        plural: "Years",
        keyOf: row => String(row.report_year),
        labelOf: key => key
    },
    {
        id: "quarter",
        label: "Quarter",
        plural: "Quarters",
        keyOf: row => "Q" + Math.ceil(row.report_month / 3),
        labelOf: key => key
    },
    {
        id: "month",
        label: "Month",
        plural: "Months",
        keyOf: row => String(row.report_month).padStart(2, "0"),
        labelOf: key => MONTH_NAMES[Number(key)] || key
    },
    {
        id: "rto",
        label: "RTO",
        plural: "RTOs",
        keyOf: row => row.rto_code,
        labelOf: key => key
    },
    {
        id: "dealer",
        label: "Dealername",
        plural: "Dealers",
        keyOf: row => row.dealer_name,
        labelOf: key => key
    }
];

const DEFAULT_ROW_FIELDS = ["year"];


/*
 * The status filter does not just remove rows - it changes what
 * the table is measuring, so it also decides which value column
 * makes sense. See buildColumnGroups().
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
    "dealerFilter"
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
        dealer: CONFIG.ALL
    },

    /* Row hierarchy, chosen in the checkbox panel. */
    rowFields: [...DEFAULT_ROW_FIELDS],

    /* Paths of expanded matrix rows. */
    expanded: new Set(),

    matrix: null,
    columnGroups: [],

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

    searchTerms: [],
    searchTimer: null,

    sortKey: "total",
    sortDirection: "desc",

    currentPage: 1,
    pageSize: CONFIG.PAGE_SIZE
};


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
    "rowFieldList",
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
        state.filters.dealer
    );

    /*
     * Status and grouping are fixed lists written in the HTML,
     * so they only need mirroring into their comboboxes.
     */
    refreshCombo(dom.statusFilter);

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
    state.filters.dealer = normalizeFilter(dom.dealerFilter?.value);

    const status = normalizeString(dom.statusFilter?.value).toLowerCase();

    state.filters.status = STATUSES[status] ? status : CONFIG.ALL;
}


/* ============================================================
   11. ROW FIELD PANEL

   The checkbox list on the left, which decides the row
   hierarchy. Ticking Year then RTO gives Year > RTO, each level
   expandable, as in the reference report.
   ============================================================ */

function renderRowFieldPanel() {

    if (!dom.rowFieldList) {
        return;
    }

    dom.rowFieldList.innerHTML = "";

    const fragment = document.createDocumentFragment();

    ROW_FIELDS.forEach(field => {

        const label = document.createElement("label");
        label.className = "field-option";

        const input = document.createElement("input");
        input.type = "checkbox";
        input.value = field.id;
        input.checked = state.rowFields.includes(field.id);

        const text = document.createElement("span");
        text.textContent = field.label;

        /*
         * The badge shows the position in the hierarchy, because
         * order matters and tick order is not visible otherwise.
         */
        const order = document.createElement("span");
        order.className = "field-option__order";

        const position = state.rowFields.indexOf(field.id);

        order.textContent = position + 1;
        order.hidden = position < 0;

        label.appendChild(input);
        label.appendChild(text);
        label.appendChild(order);

        fragment.appendChild(label);
    });

    dom.rowFieldList.appendChild(fragment);
}


function setupRowFieldPanel() {

    if (!dom.rowFieldList) {
        return;
    }

    dom.rowFieldList.addEventListener("change", event => {

        const input = event.target.closest("input[type=checkbox]");

        if (!input) {
            return;
        }

        const id = input.value;

        if (input.checked) {

            if (!state.rowFields.includes(id)) {
                state.rowFields.push(id);
            }

        } else {

            state.rowFields = state.rowFields.filter(field => field !== id);

            /*
             * Never leave the matrix with no row dimension - the
             * first field goes back on rather than showing a
             * single unlabelled row.
             */
            if (state.rowFields.length === 0) {
                state.rowFields = [ROW_FIELDS[0].id];
            }
        }

        /* The hierarchy changed, so old expansion paths are stale. */
        state.expanded = new Set();

        renderRowFieldPanel();
        applyFilters();
    });
}


function activeRowFields() {

    const chosen = ROW_FIELDS.filter(
        field => state.rowFields.includes(field.id)
    );

    return chosen.length > 0 ? chosen : [ROW_FIELDS[0]];
}


/* ============================================================
   12. FILTER + MATRIX MODEL

   The cached rows are one-per-(dealer, rto, period), so
   filtering is a predicate and the matrix is a single pass that
   accumulates each row into every level of the hierarchy it
   belongs to, and into one cell per column group.
   ============================================================ */

function getFilteredSourceRows() {

    const { rto, year, month, dealer } = state.filters;

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

        if (!isAll(dealer) && row.dealer_name !== dealer) {
            return false;
        }

        return true;
    });
}


/*
 * Columns are months, as in the reference. TOTAL_KEY is the
 * trailing grand-total block.
 */
const TOTAL_KEY = "__total";

/*
 * Separates the levels of a row path. A plain space would be
 * ambiguous: "A B" then "C" would collide with "A" then "B C".
 * Unit separator (31) cannot appear in the data.
 */
const PATH_SEP = String.fromCharCode(31);


function columnKeyOf(row) {

    return String(row.report_month).padStart(2, "0");
}


function buildColumnGroups(sourceRows) {

    const months = [
        ...new Set(sourceRows.map(row => row.report_month))
    ].sort((a, b) => a - b);

    const groups = months.map(month => ({
        key: String(month).padStart(2, "0"),
        label: MONTH_NAMES[month] || String(month)
    }));

    groups.push({ key: TOTAL_KEY, label: "Total" });

    return groups;
}


function makeNode(key, label, level, path) {

    return {
        key,
        label,
        level,
        path: path || "",
        children: new Map(),
        cells: new Map(),
        total: 0,
        fixed: 0,
        pending: 0
    };
}


function addMeasures(node, row, columnKey) {

    let cell = node.cells.get(columnKey);

    if (!cell) {
        cell = { total: 0, fixed: 0, pending: 0 };
        node.cells.set(columnKey, cell);
    }

    cell.total += row.total;
    cell.fixed += row.fixed;
    cell.pending += row.pending;

    node.total += row.total;
    node.fixed += row.fixed;
    node.pending += row.pending;
}


function buildMatrix(sourceRows) {

    const fields = activeRowFields();
    const root = makeNode("", "", -1, "");

    sourceRows.forEach(row => {

        const columnKey = columnKeyOf(row);

        addMeasures(root, row, columnKey);

        let node = root;

        fields.forEach((field, depth) => {

            const key = normalizeString(field.keyOf(row));

            if (!key) {
                return;
            }

            /*
             * Unit separator, so a path cannot be ambiguous:
             * with a plain space, "A B" then "C" would collide
             * with "A" then "B C".
             */
            const path = node.path
                ? node.path + PATH_SEP + key
                : key;

            let child = node.children.get(key);

            if (!child) {
                child = makeNode(key, field.labelOf(key), depth, path);
                node.children.set(key, child);
            }

            addMeasures(child, row, columnKey);

            node = child;
        });
    });

    return root;
}


function sortNodes(nodes) {

    return [...nodes].sort((a, b) =>
        String(a.label).localeCompare(String(b.label), undefined, {
            numeric: true,
            sensitivity: "base"
        })
    );
}


/*
 * Top-level rows are what search and paging act on; a page
 * carries its expanded descendants with it, so a parent is
 * never separated from its children.
 */
function flattenWithDescendants(node, out) {

    out.push(node);

    if (!state.expanded.has(node.path) || node.children.size === 0) {
        return out;
    }

    sortNodes(node.children.values()).forEach(
        child => flattenWithDescendants(child, out)
    );

    return out;
}


/* ============================================================
   13. KPIs
   ============================================================ */

function calculateKPIs(sourceRows, topLevelCount) {

    const status = currentStatus();

    let fixed = 0;
    let pending = 0;
    let total = 0;

    sourceRows.forEach(row => {
        fixed += row.fixed;
        pending += row.pending;
        total += row.total;
    });

    if (status.id === "fixed") {
        total = fixed;
        pending = 0;
    } else if (status.id === "pending") {
        total = pending;
        fixed = 0;
    }

    return {
        total,
        fixed,
        pending,
        fixedPct: total ? (fixed / total) * 100 : 0,
        pendingPct: total ? (pending / total) * 100 : 0,
        entities: topLevelCount
    };
}


function updateKPICards() {

    const kpis = state.kpis;
    const status = currentStatus();
    const field = activeRowFields()[0];

    if (dom.totalApplications) {
        dom.totalApplications.textContent = formatIndianNumber(kpis.total);
    }

    if (dom.totalApplicationsMeta) {
        dom.totalApplicationsMeta.textContent =
            status.field ? status.label + " only" : "All selected applications";
    }

    if (dom.fixedCount) {
        dom.fixedCount.textContent = formatIndianNumber(kpis.fixed);
    }

    if (dom.fixedPercentage) {
        dom.fixedPercentage.textContent =
            kpis.total > 0
                ? formatPercentage(kpis.fixedPct) + " of selection"
                : "—";
    }

    if (dom.pendingCount) {
        dom.pendingCount.textContent = formatIndianNumber(kpis.pending);
    }

    if (dom.pendingPercentage) {
        dom.pendingPercentage.textContent =
            kpis.total > 0
                ? formatPercentage(kpis.pendingPct) + " of selection"
                : "—";
    }

    if (dom.entityCount) {
        dom.entityCount.textContent = formatIndianNumber(kpis.entities);
    }

    if (dom.entityCountLabel) {
        dom.entityCountLabel.textContent = "Total " + field.plural;
    }

    if (dom.entityCountMeta) {
        dom.entityCountMeta.textContent = field.plural + " with applications";
    }
}


/* ============================================================
   14. SEARCH / PAGINATION
   ============================================================ */

function getActiveSearchTerms() {

    return state.searchTerms.map(normalizeKey).filter(Boolean);
}


function getSearchFilteredNodes(nodes) {

    const terms = getActiveSearchTerms();

    if (terms.length === 0) {
        return nodes;
    }

    return nodes.filter(node => {

        const label = normalizeKey(node.label);

        return terms.some(term => label.includes(term));
    });
}


function getPaginatedNodes(nodes) {

    const start = (state.currentPage - 1) * state.pageSize;

    return nodes.slice(start, start + state.pageSize);
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
   16. MATRIX RENDER

   Two header rows: month across the top, then TOT / FIX / MS
   under each. TOT is all applications, FIX is those fitted, and
   MS is FIX divided by TOT - the same relationship the
   reference MS has to its VOL and IND.
   ============================================================ */

const MEASURES = [
    { key: "total", label: "TOT" },
    { key: "fixed", label: "FIX" },
    { key: "ms",    label: "MS"  }
];


/*
 * Integers print bare, as the reference does - no thousands
 * separators inside the grid.
 */
function matrixNumber(value) {

    return String(Math.round(toNumber(value)));
}


function matrixShare(fixed, total) {

    const denominator = toNumber(total);

    if (denominator <= 0) {
        return "";
    }

    return ((toNumber(fixed) / denominator) * 100).toFixed(1) + " %";
}


function cellValuesFor(node, group) {

    if (group.key === TOTAL_KEY) {
        return { total: node.total, fixed: node.fixed };
    }

    const cell = node.cells.get(group.key);

    return cell ? { total: cell.total, fixed: cell.fixed } : null;
}


function appendMeasureCells(row, node, groups, tag) {

    groups.forEach(group => {

        const values = cellValuesFor(node, group);

        MEASURES.forEach((measure, index) => {

            const cell = document.createElement(tag);

            if (index === 0) {
                cell.className = "group-start";
            }

            if (!values) {

                cell.classList.add("matrix-cell--empty");
                cell.textContent = "";

            } else if (measure.key === "ms") {

                cell.textContent = matrixShare(values.fixed, values.total);

            } else {

                cell.textContent = matrixNumber(values[measure.key]);
            }

            row.appendChild(cell);
        });
    });
}


function renderMatrixHead(groups) {

    if (!dom.dealerSummaryTableHead) {
        return;
    }

    dom.dealerSummaryTableHead.innerHTML = "";

    /* Row 1: the column field name, then one block per month. */
    const top = document.createElement("tr");

    const topCorner = document.createElement("th");
    topCorner.className = "row-head";
    topCorner.textContent = "Month";
    top.appendChild(topCorner);

    groups.forEach(group => {

        const th = document.createElement("th");
        th.className = "group-start";
        th.colSpan = MEASURES.length;
        th.textContent = group.label;

        top.appendChild(th);
    });

    /* Row 2: the row field names, then the measures. */
    const bottom = document.createElement("tr");

    const bottomCorner = document.createElement("th");
    bottomCorner.className = "row-head";
    bottomCorner.textContent =
        activeRowFields().map(field => field.label).join(" / ");
    bottom.appendChild(bottomCorner);

    groups.forEach(() => {

        MEASURES.forEach((measure, index) => {

            const th = document.createElement("th");

            if (index === 0) {
                th.className = "group-start";
            }

            th.textContent = measure.label;

            bottom.appendChild(th);
        });
    });

    dom.dealerSummaryTableHead.appendChild(top);
    dom.dealerSummaryTableHead.appendChild(bottom);
}


function renderMatrixFoot(nodes, groups) {

    if (!dom.dealerSummaryTableFoot) {
        return;
    }

    dom.dealerSummaryTableFoot.innerHTML = "";

    /*
     * The total row sums what is on screen, so it follows both
     * the filters and the search.
     */
    const totals = makeNode("", "Total", -1, "");

    nodes.forEach(node => {

        totals.total += node.total;
        totals.fixed += node.fixed;
        totals.pending += node.pending;

        node.cells.forEach((cell, key) => {

            let target = totals.cells.get(key);

            if (!target) {
                target = { total: 0, fixed: 0, pending: 0 };
                totals.cells.set(key, target);
            }

            target.total += cell.total;
            target.fixed += cell.fixed;
            target.pending += cell.pending;
        });
    });

    const row = document.createElement("tr");

    const head = document.createElement("th");
    head.className = "row-head";
    head.scope = "row";
    head.textContent = "Total";
    row.appendChild(head);

    appendMeasureCells(row, totals, groups, "td");

    dom.dealerSummaryTableFoot.appendChild(row);
}


function renderMatrixBody(nodes, groups) {

    dom.dealerSummaryTableBody.innerHTML = "";

    const fragment = document.createDocumentFragment();

    nodes.forEach(node => {

        const tr = document.createElement("tr");
        tr.setAttribute("data-level", String(node.level));

        const head = document.createElement("th");
        head.className = "row-head";
        head.scope = "row";
        head.title = node.label;

        const wrap = document.createElement("span");
        wrap.className = "row-label";
        wrap.style.paddingLeft = (node.level * 15) + "px";

        const expander = document.createElement("button");
        expander.type = "button";

        const hasChildren = node.children.size > 0;

        expander.className =
            hasChildren ? "row-expander" : "row-expander row-expander--leaf";

        if (hasChildren) {

            const open = state.expanded.has(node.path);

            expander.textContent = open ? "−" : "+";
            expander.setAttribute("data-expand", node.path);
            expander.setAttribute("aria-expanded", open ? "true" : "false");
            expander.setAttribute(
                "aria-label",
                (open ? "Collapse " : "Expand ") + node.label
            );

        } else {
            expander.tabIndex = -1;
            expander.setAttribute("aria-hidden", "true");
        }

        const text = document.createElement("span");
        text.textContent = node.label;

        wrap.appendChild(expander);
        wrap.appendChild(text);
        head.appendChild(wrap);
        tr.appendChild(head);

        appendMeasureCells(tr, node, groups, "td");

        fragment.appendChild(tr);
    });

    dom.dealerSummaryTableBody.appendChild(fragment);
}


function renderTable() {

    if (!dom.dealerSummaryTableBody) {
        return;
    }

    const groups = state.columnGroups;

    const topLevel = sortNodes(state.matrix.children.values());
    const searched = getSearchFilteredNodes(topLevel);

    state.filteredRows = searched;

    const totalPages = Math.max(1, Math.ceil(searched.length / state.pageSize));

    if (state.currentPage > totalPages) {
        state.currentPage = totalPages;
    }

    updateResultCount(searched.length, topLevel.length);
    updatePagination(totalPages);

    if (searched.length === 0 || groups.length <= 1) {

        const terms = state.searchTerms.map(normalizeString).filter(Boolean);
        const entity = activeRowFields()[0].label.toLowerCase();

        let message = "No data found for the selected filters.";

        if (terms.length === 1) {
            message = "No " + entity + " matches \"" + terms[0] + "\".";
        } else if (terms.length > 1) {
            message =
                "No " + entity + " matches " +
                terms.map(term => "\"" + term + "\"").join(" or ") + ".";
        }

        setTableState("empty", message);

        return;
    }

    setTableState("data");

    const visible = [];

    getPaginatedNodes(searched).forEach(
        node => flattenWithDescendants(node, visible)
    );

    renderMatrixHead(groups);
    renderMatrixBody(visible, groups);
    renderMatrixFoot(searched, groups);
}


function setupMatrixExpanders() {

    if (!dom.dealerSummaryTableBody) {
        return;
    }

    dom.dealerSummaryTableBody.addEventListener("click", event => {

        const button = event.target.closest("[data-expand]");

        if (!button) {
            return;
        }

        const path = button.getAttribute("data-expand");

        if (state.expanded.has(path)) {
            state.expanded.delete(path);
        } else {
            state.expanded.add(path);
        }

        renderTable();
    });
}


function updateResultCount(shown, total) {

    if (!dom.resultCount) {
        return;
    }

    const plural = activeRowFields()[0].plural.toLowerCase();

    dom.resultCount.textContent =
        shown === total
            ? formatIndianNumber(total) + " " + plural
            : formatIndianNumber(shown) + " of " +
              formatIndianNumber(total) + " " + plural;
}


function updatePagination(totalPages) {

    if (dom.pageIndicator) {
        dom.pageIndicator.textContent =
            "Page " + state.currentPage + " of " + totalPages;
    }

    if (dom.previousPageButton) {
        dom.previousPageButton.disabled = state.currentPage <= 1;
    }

    if (dom.nextPageButton) {
        dom.nextPageButton.disabled = state.currentPage >= totalPages;
    }
}


function updateViewLabels() {

    const fields = activeRowFields();

    if (dom["dealer-summary-title"]) {
        dom["dealer-summary-title"].textContent =
            fields.map(field => field.label).join(" › ") + " × Month";
    }

    getSearchInputs().forEach(input => {

        if (input) {
            input.placeholder =
                "Search " + fields[0].label.toLowerCase() + "...";
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
        strong.textContent = name + ":";

        element.appendChild(strong);
        element.appendChild(document.createTextNode(" " + value));

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

    addFilter("Dealer", state.filters.dealer);

    addFilter(
        "Rows",
        activeRowFields().map(field => field.label).join(" › ")
    );

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

    const status = currentStatus();

    const scope = isAll(state.filters.rto) ? "All RTOs" : state.filters.rto;

    const parts = [
        "Source: " + SUMMARY_TABLE,
        scope,
        status.field ? status.label : "all statuses",
        formatIndianNumber(state.kpis.total) + " applications across " +
        formatIndianNumber(state.matrix.children.size) + " " +
        activeRowFields()[0].plural.toLowerCase()
    ];

    dom.datasetNote.hidden = false;
    dom.datasetNote.textContent = parts.join(" · ") + ".";
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

        const sourceRows = getFilteredSourceRows();

        state.columnGroups = buildColumnGroups(sourceRows);
        state.matrix = buildMatrix(sourceRows);
        state.kpis = calculateKPIs(sourceRows, state.matrix.children.size);


        state.currentPage = 1;

        updateViewLabels();
        updateKPICards();
        updateActiveFilters();
        updateDatasetNote();

        renderTable();

    } catch (error) {

        state.matrix = makeNode("", "", -1, "");
        state.columnGroups = [];
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

    state.rowFields = [...DEFAULT_ROW_FIELDS];
    state.expanded = new Set();
    renderRowFieldPanel();

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
    const field = activeRowFields()[0];

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

            input.placeholder = "Search " + field.label.toLowerCase() + "...";

            input.setAttribute(
                "aria-label",
                rows.length > 1
                    ? "Search " + field.plural.toLowerCase() +
                      ", box " + (index + 1) + " of " + rows.length
                    : "Search " + field.plural.toLowerCase()
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
        dom.dealerFilter
    ];

    selects.forEach(select => {

        if (!select) {
            return;
        }

        select.addEventListener("change", () => {

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
        renderRowFieldPanel();

        if (!state.wired) {
            setupSearch();
            setupRowFieldPanel();
            setupMatrixExpanders();
            setupPagination();
            setupFilterListeners();
            setupComboDismiss();
            state.wired = true;
        }

        updatePeriodHeader();

        applyFilters();

    } catch (error) {

        state.matrix = makeNode("", "", -1, "");
        state.columnGroups = [];
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
