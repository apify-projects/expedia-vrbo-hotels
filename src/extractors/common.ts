/**
 * Shared by the extractors: the Python-semantics helpers the port depends on,
 * safe traversal of the GraphQL responses, and the section reader every text
 * extractor starts from.
 */

/** Mirror of Python truthiness for the values the formatter gates on. */
export function pyTruthy(v: any): boolean {
    if (v === null || v === undefined) return false;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
    if (typeof v === 'string') return v.length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'object') return Object.keys(v).length > 0;
    return Boolean(v);
}

/** Python `isinstance(x, dict)` - a plain (non-array, non-null) object. */
export function isDict(x: any): x is Record<string, any> {
    return x !== null && typeof x === 'object' && !Array.isArray(x);
}

/**
 * Array-safe coercion matching Python's `for x in (y or [])` semantics.
 *
 * In Python, iterating a dict (object) where a list was expected harmlessly
 * walks the dict KEYS, which then fail the `isinstance(x, dict)` check and are
 * skipped - so a non-list contributes nothing and does NOT error. JS `for...of`
 * over a non-array object THROWS, so we collapse "non-array → empty" here to
 * preserve the Python behavior. For an actual array, returns it unchanged.
 */
export const asArray = (x: any): any[] => (Array.isArray(x) ? x : []);

/**
 * Python `round(x, 1)` - round-half-to-even on the decimal value.
 * Required for faithful rating normalization (JS Math.round is half-up).
 */
export function pyRound1(x: number): number {
    const scaled = x * 10;
    const floor = Math.floor(scaled);
    const diff = scaled - floor;
    const EPS = 1e-9;
    let r: number;
    if (Math.abs(diff - 0.5) < EPS) {
        r = floor % 2 === 0 ? floor : floor + 1;
    } else {
        r = Math.round(scaled);
    }
    return r / 10;
}

/**
 * Python `float(str)` - returns null when not parseable, mirroring the
 * try/except (ValueError) guards in the Python. Accepts leading/trailing
 * whitespace and standard float syntax. Rejects empty / NaN-like junk.
 */
export function pyFloat(s: any): number | null {
    if (typeof s === 'number') return Number.isNaN(s) ? null : s;
    if (typeof s !== 'string') return null;
    const t = s.trim();
    if (t === '') return null;
    // Python float() accepts inf/nan but those never appear here; restrict to
    // ordinary numeric literals so we match float()'s ValueError behavior.
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return null;
    const v = Number(t);
    return Number.isNaN(v) ? null : v;
}

/**
 * Python `int(str)` for a base-10 integer literal - returns null when not a
 * pure integer (matches `int("9.0")` raising ValueError). Used for review
 * counts parsed from strings.
 */
export function pyIntStrict(s: any): number | null {
    if (typeof s !== 'string') return null;
    const t = s.trim();
    if (!/^[+-]?\d+$/.test(t)) return null;
    const v = Number.parseInt(t, 10);
    return Number.isNaN(v) ? null : v;
}

/**
 * Python `str.capitalize()` - first char upper, the rest lower.
 */
export function pyCapitalize(s: string): string {
    if (s.length === 0) return s;
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/** A blank string from a partial API response means unknown, not "". */
export function nullIfBlank(value: any): string | null {
    if (typeof value === 'string' && value.trim() === '') return null;
    return value ?? null;
}

/** Current timestamp as an ISO-8601 UTC string (mirrors datetime.now(utc).isoformat()). */
export function nowIso(): string {
    return new Date().toISOString();
}

/**
 * Faithful port of `safe_get`: navigate nested dict/list, returning `default`
 * on a type mismatch or a None encountered along the way.
 */
export function safeGet(data: any, keys: (string | number)[], defaultValue: any = null): any {
    let result: any = data;
    for (const key of keys) {
        if (isDict(result)) {
            result = result[key as string];
            // dict.get(missing) -> undefined in JS; Python yields None.
            if (result === undefined) result = null;
        } else if (Array.isArray(result) && typeof key === 'number' && result.length > key) {
            result = result[key];
        } else {
            return defaultValue;
        }
        if (result === null || result === undefined) {
            return defaultValue;
        }
    }
    return result;
}

/** Extract text values from a PropertyContent items array. */
export function extractTextItems(items: any): string[] {
    const texts: string[] = [];
    for (const item of asArray(items)) {
        const typename = (item && item.__typename) ?? '';

        if (typename === 'PropertyContentItemMarkup') {
            const text = safeGet(item, ['content', 'text']);
            if (pyTruthy(text)) {
                // Strip HTML tags
                let cleanText = String(text)
                    .replace(/<[^>]+>/g, ' ')
                    .trim();
                cleanText = cleanText.replace(/\s+/g, ' ');
                texts.push(cleanText);
            }
        } else if (typename === 'PropertyContentItemText') {
            const value = safeGet(item, ['content', 'primary', 'value']);
            if (pyTruthy(value)) {
                texts.push(value);
            }
        } else if (typename === 'PropertyContentItemTexts') {
            for (const content of asArray(item.contents)) {
                const value = safeGet(content, ['primary', 'value']);
                if (pyTruthy(value)) {
                    texts.push(value);
                }
            }
        }
    }
    return texts;
}
