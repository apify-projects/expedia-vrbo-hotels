/**
 * Output formatter for VRBO / Expedia / Hotels.com property details.
 *
 * FAITHFUL, behavior-preserving port of `src/formatters/vrbo_formatter.py`.
 * Transforms raw PropertyContent / PropertySummary / ProductGallery /
 * PropertyOffers / TemplatePageLayout API responses into the target output
 * schema. Field names, fallback ordering, null-vs-absent semantics, and
 * number/string formatting mirror the Python exactly.
 *
 * All functions are pure (no network, no I/O).
 */

import type {
    AmenityCategory,
    BedType,
    ErrorRow,
    Feature,
    HighlightedAmenity,
    HostData,
    HouseRules,
    PolicySection,
    PolicySubSection,
    PriceLine,
    Pricing,
    PropertyImage,
    PropertyResult,
    PropertyUnit,
    UnitImage,
    UnitPrice,
} from './types.js';
import { type Platform, PLATFORM_LABEL_MAP } from './url-parser.js';

// ---------------------------------------------------------------------------
// Python-semantics helpers
// ---------------------------------------------------------------------------

/** Mirror of Python truthiness for the values the formatter gates on. */
function pyTruthy(v: any): boolean {
    if (v === null || v === undefined) return false;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
    if (typeof v === 'string') return v.length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'object') return Object.keys(v).length > 0;
    return Boolean(v);
}

/** Python `isinstance(x, dict)` — a plain (non-array, non-null) object. */
function isDict(x: any): x is Record<string, any> {
    return x !== null && typeof x === 'object' && !Array.isArray(x);
}

/**
 * Array-safe coercion matching Python's `for x in (y or [])` semantics.
 *
 * In Python, iterating a dict (object) where a list was expected harmlessly
 * walks the dict KEYS, which then fail the `isinstance(x, dict)` check and are
 * skipped — so a non-list contributes nothing and does NOT error. JS `for...of`
 * over a non-array object THROWS, so we collapse "non-array → empty" here to
 * preserve the Python behavior. For an actual array, returns it unchanged.
 */
const asArray = (x: any): any[] => (Array.isArray(x) ? x : []);

/**
 * Python `round(x, 1)` — round-half-to-even on the decimal value.
 * Required for faithful rating normalization (JS Math.round is half-up).
 */
function pyRound1(x: number): number {
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
 * Python `float(str)` — returns null when not parseable, mirroring the
 * try/except (ValueError) guards in the Python. Accepts leading/trailing
 * whitespace and standard float syntax. Rejects empty / NaN-like junk.
 */
function pyFloat(s: any): number | null {
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
 * Python `int(str)` for a base-10 integer literal — returns null when not a
 * pure integer (matches `int("9.0")` raising ValueError). Used for review
 * counts parsed from strings.
 */
function pyIntStrict(s: any): number | null {
    if (typeof s !== 'string') return null;
    const t = s.trim();
    if (!/^[+-]?\d+$/.test(t)) return null;
    const v = Number.parseInt(t, 10);
    return Number.isNaN(v) ? null : v;
}

/**
 * Python `str.capitalize()` — first char upper, the rest lower.
 */
function pyCapitalize(s: string): string {
    if (s.length === 0) return s;
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/** Current timestamp as an ISO-8601 UTC string (mirrors datetime.now(utc).isoformat()). */
function nowIso(): string {
    return new Date().toISOString();
}

/**
 * Faithful port of `safe_get`: navigate nested dict/list, returning `default`
 * on a type mismatch or a None encountered along the way.
 */
function safeGet(data: any, keys: Array<string | number>, defaultValue: any = null): any {
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

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

/** Extract text values from a PropertyContent items array. */
function extractTextItems(items: any): string[] {
    const texts: string[] = [];
    for (const item of asArray(items)) {
        const typename = (item && item.__typename) ?? '';

        if (typename === 'PropertyContentItemMarkup') {
            const text = safeGet(item, ['content', 'text']);
            if (pyTruthy(text)) {
                // Strip HTML tags
                let cleanText = String(text).replace(/<[^>]+>/g, ' ').trim();
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

// ---------------------------------------------------------------------------
// Rating / review extraction
// ---------------------------------------------------------------------------

/**
 * Extract rating and review count from TemplatePageLayout config.
 *
 * Primary source: seoStructuredData -> aggregateRating.
 * Fallback for review count: "See all X reviews" pattern in the raw config str.
 *
 * Returns [ratingValue, reviewCount].
 */
function extractRatingFromPageLayout(
    pageLayoutData: any,
): [number | null, number | null] {
    if (!pyTruthy(pageLayoutData)) {
        return [null, null];
    }

    const configStr = safeGet(pageLayoutData, ['data', 'pageLayout', 'config']);
    if (!pyTruthy(configStr) || typeof configStr !== 'string') {
        return [null, null];
    }

    let ratingValue: number | null = null;
    let reviewCount: number | null = null;

    let config: any;
    try {
        config = JSON.parse(configStr);
    } catch {
        config = null;
    }

    // Search recursively for seoStructuredData containing aggregateRating.
    function findAggregateRating(obj: any): any {
        if (isDict(obj)) {
            if ('seoStructuredData' in obj) {
                const seoStr = obj.seoStructuredData;
                if (typeof seoStr === 'string') {
                    try {
                        const seoData = JSON.parse(seoStr);
                        if (isDict(seoData) && 'aggregateRating' in seoData) {
                            return seoData.aggregateRating;
                        }
                    } catch {
                        // pass
                    }
                }
            }
            for (const v of Object.values(obj)) {
                const result = findAggregateRating(v);
                if (pyTruthy(result)) {
                    return result;
                }
            }
        } else if (Array.isArray(obj)) {
            for (const item of obj) {
                const result = findAggregateRating(item);
                if (pyTruthy(result)) {
                    return result;
                }
            }
        }
        return null;
    }

    const aggregateRating = config ? findAggregateRating(config) : null;

    if (pyTruthy(aggregateRating)) {
        // Extract from aggregateRating (primary source).
        const ratingStr = aggregateRating.ratingValue;
        if (pyTruthy(ratingStr) && ratingStr !== 'null') {
            const v = pyFloat(ratingStr);
            if (v !== null) ratingValue = v;
        }

        const countStr = aggregateRating.reviewCount;
        if (pyTruthy(countStr) && countStr !== 'null') {
            const v = pyIntStrict(countStr);
            if (v !== null) reviewCount = v;
        }
    }

    // Fallback: extract review count from "See all X reviews" pattern.
    if (reviewCount === null && pyTruthy(configStr)) {
        const match = /[Ss]ee all (\d+) reviews?/.exec(configStr);
        if (match) {
            const v = pyIntStrict(match[1]);
            if (v !== null) reviewCount = v;
        }
    }

    return [ratingValue, reviewCount];
}

/** Extract the numeric rating from review summary responses, on a 10-point scale. */
function extractRating(reviewSummary: any): number | null {
    const ratingWithMaxPattern = /(\d+(?:\.\d+)?)\s*(?:out of|\/)\s*(\d+)/;
    const numberPattern = /(\d+(?:\.\d+)?)/;

    const candidates: any[] = [
        safeGet(reviewSummary, ['overallScoreWithDescriptionA11y', 'value']),
        safeGet(reviewSummary, ['overallScoreWithDescriptionA11y', 'accessibilityLabel']),
        safeGet(reviewSummary, ['overallScoreWithDescriptionA11y', 'score']),
        safeGet(reviewSummary, ['overallScore', 'value']),
        safeGet(reviewSummary, ['overallScore', 'formatted']),
        safeGet(reviewSummary, ['overallScore', 'score']),
    ];

    let ratingValue: number | null = null;

    // Try explicit candidates first.
    for (const val of candidates) {
        if (typeof val === 'number' && val >= 0 && val <= 10) {
            ratingValue = val;
            break;
        }
        if (typeof val === 'string') {
            // Try "X out of Y" or "X/Y" pattern - normalize to 10-point scale.
            const match = ratingWithMaxPattern.exec(val);
            if (match) {
                const parsed = Number.parseFloat(match[1]);
                const maxVal = Number.parseFloat(match[2]);
                if (maxVal === 10 && parsed > 10) {
                    // Expedia doubled rating: 18.0/10 means 9.0.
                    ratingValue = pyRound1(parsed / 2);
                } else if (maxVal === 5) {
                    // Convert 5-point scale to 10-point.
                    ratingValue = pyRound1(parsed * 2);
                } else if (maxVal === 10) {
                    ratingValue = parsed;
                } else {
                    // Normalize any other scale to 10-point.
                    ratingValue = pyRound1((parsed / maxVal) * 10);
                }
                break;
            }
            // Then try simple number, but only if it's a valid rating (0-10).
            const numMatch = numberPattern.exec(val);
            if (numMatch) {
                const parsed = Number.parseFloat(numMatch[1]);
                if (parsed >= 0 && parsed <= 10) {
                    ratingValue = parsed;
                    break;
                }
            }
        }
    }

    return ratingValue;
}

// ---------------------------------------------------------------------------
// Description / amenities
// ---------------------------------------------------------------------------

/** Extract description from PropertyContent aboutThisProperty section. */
function extractDescription(contentData: any): string {
    const about = safeGet(
        contentData,
        ['data', 'propertyInfo', 'propertyContentSectionGroups', 'aboutThisProperty'],
        {},
    );
    const sections = about.sections || [];

    const descriptionParts: string[] = [];
    let title: string | null = null;

    for (const section of asArray(sections)) {
        const bodySubs = section.bodySubSections || [];
        for (const sub of asArray(bodySubs)) {
            const elementsV2 = sub.elementsV2 || [];
            for (const elemGroup of asArray(elementsV2)) {
                for (const element of asArray(elemGroup.elements)) {
                    // Get title from header.
                    const header = element.header || {};
                    if (pyTruthy(header)) {
                        const headerText = header.text;
                        if (pyTruthy(headerText) && !pyTruthy(title)) {
                            title = headerText;
                        }
                    }

                    // Get description from items.
                    const items = element.items || [];
                    const texts = extractTextItems(items);
                    descriptionParts.push(...texts);
                }
            }
        }
    }

    return descriptionParts.join(' ').trim();
}

/** Extract highlighted amenities from amenitiesSummary. */
function extractAmenitiesSummary(contentData: any): HighlightedAmenity[] {
    const amenitiesList: HighlightedAmenity[] = [];

    const amenities = safeGet(
        contentData,
        ['data', 'propertyInfo', 'amenitiesSummary', 'amenities'],
        {},
    );
    const sections = amenities.sections || [];

    for (const section of asArray(sections)) {
        const bodySubs = section.bodySubSections || [];
        for (const sub of asArray(bodySubs)) {
            const elementsV2 = sub.elementsV2 || [];
            for (const elemGroup of asArray(elementsV2)) {
                for (const element of asArray(elemGroup.elements)) {
                    const items = element.items || [];
                    for (const item of asArray(items)) {
                        if (item.__typename === 'PropertyContentItemText') {
                            const value = safeGet(item, ['content', 'primary', 'value']);
                            const iconId = safeGet(item, ['content', 'primary', 'icon', 'id']);
                            if (pyTruthy(value)) {
                                amenitiesList.push({
                                    iconId,
                                    text: value,
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    return amenitiesList;
}

/**
 * Extract categorized amenities from amenitiesSummary, optionally filtered by
 * section name.
 */
function extractCategorizedAmenitiesFromSummary(
    contentData: any,
    sectionFilter: string | null = null,
): AmenityCategory[] {
    const categories: AmenityCategory[] = [];

    const summary = safeGet(
        contentData,
        ['data', 'propertyInfo', 'amenitiesSummary', 'amenities'],
        {},
    );
    const sections = summary.sections || [];

    for (const section of asArray(sections)) {
        if (sectionFilter) {
            const sectionName = (section.sectionName || '').toLowerCase();
            if (!sectionName.includes(sectionFilter.toLowerCase())) {
                continue;
            }
        }

        const bodySubs = section.bodySubSections || [];
        for (const sub of asArray(bodySubs)) {
            const elementsV2 = sub.elementsV2 || [];
            for (const elemGroup of asArray(elementsV2)) {
                for (const element of asArray(elemGroup.elements)) {
                    const categoryName = safeGet(element, ['header', 'text']);
                    if (!pyTruthy(categoryName)) {
                        continue;
                    }

                    const items = extractTextItems(element.items || []);
                    if (pyTruthy(items)) {
                        categories.push({
                            title: categoryName,
                            items,
                        });
                    }
                }
            }
        }
    }

    return categories;
}

/** Extract detailed amenities organized by category. */
function extractDetailedAmenities(contentData: any): AmenityCategory[] {
    let categories: AmenityCategory[] = [];

    // Try detailedAmenitiesContent first (VRBO structure).
    const detailed = safeGet(
        contentData,
        ['data', 'propertyInfo', 'detailedAmenitiesContent', 'amenities'],
        {},
    );
    const sections = detailed.sections || [];

    if (pyTruthy(sections)) {
        // VRBO structure: categories are in bodySubSections headers.
        for (const section of asArray(sections)) {
            const bodySubs = section.bodySubSections || [];
            for (const sub of asArray(bodySubs)) {
                const categoryName = safeGet(sub, ['header', 'text']);
                if (!pyTruthy(categoryName)) {
                    continue;
                }

                const items: string[] = [];
                const elementsV2 = sub.elementsV2 || [];
                for (const elemGroup of asArray(elementsV2)) {
                    for (const element of asArray(elemGroup.elements)) {
                        const texts = extractTextItems(element.items || []);
                        items.push(...texts);
                    }
                }

                if (pyTruthy(items)) {
                    categories.push({
                        title: categoryName,
                        items,
                    });
                }
            }
        }
    } else {
        // Fallback to amenitiesSummary (Expedia/Hotels.com structure).
        categories = extractCategorizedAmenitiesFromSummary(contentData);
    }

    return categories;
}

// Category names that are room-level (not property-level) amenities.
const ROOM_AMENITY_CATEGORIES = new Set<string>([
    'bedroom',
    'bedrooms',
    'bathroom',
    'kitchen',
    'entertainment',
    'food and drink',
    'dining',
    'comfort',
    'laundry',
    'living spaces',
    'work spaces',
    'internet',
    'more',
]);

/** Extract room-level amenities when no 'Room amenities' section exists. */
function extractRoomAmenitiesFallback(contentData: any): AmenityCategory[] {
    // Try detailedAmenitiesContent first.
    const detailed = safeGet(
        contentData,
        ['data', 'propertyInfo', 'detailedAmenitiesContent', 'amenities'],
        {},
    );
    const sections = detailed.sections || [];

    const categories: AmenityCategory[] = [];
    for (const section of asArray(sections)) {
        const bodySubs = section.bodySubSections || [];
        for (const sub of asArray(bodySubs)) {
            const categoryName = safeGet(sub, ['header', 'text']);
            if (!pyTruthy(categoryName)) {
                continue;
            }

            if (!ROOM_AMENITY_CATEGORIES.has(String(categoryName).toLowerCase())) {
                continue;
            }

            const items: string[] = [];
            for (const elemGroup of asArray(sub.elementsV2)) {
                for (const element of asArray(elemGroup.elements)) {
                    const texts = extractTextItems(element.items || []);
                    items.push(...texts);
                }
            }

            if (pyTruthy(items)) {
                categories.push({ title: categoryName, items });
            }
        }
    }

    if (pyTruthy(categories)) {
        return categories;
    }

    // Fallback: filter room-level categories from "Property amenities" in amenitiesSummary.
    const summary = safeGet(
        contentData,
        ['data', 'propertyInfo', 'amenitiesSummary', 'amenities'],
        {},
    );
    for (const section of asArray(summary.sections)) {
        const bodySubs = section.bodySubSections || [];
        for (const sub of asArray(bodySubs)) {
            const elementsV2 = sub.elementsV2 || [];
            for (const elemGroup of asArray(elementsV2)) {
                for (const element of asArray(elemGroup.elements)) {
                    const categoryName = safeGet(element, ['header', 'text']);
                    if (!pyTruthy(categoryName)) {
                        continue;
                    }
                    if (!ROOM_AMENITY_CATEGORIES.has(String(categoryName).toLowerCase())) {
                        continue;
                    }
                    const items = extractTextItems(element.items || []);
                    if (pyTruthy(items)) {
                        categories.push({ title: categoryName, items });
                    }
                }
            }
        }
    }

    return categories;
}

// ---------------------------------------------------------------------------
// Policies / important info / host
// ---------------------------------------------------------------------------

/** Extract policies from PropertyContent. */
function extractPolicies(contentData: any): PolicySection[] {
    const policiesList: PolicySection[] = [];

    const policies = safeGet(
        contentData,
        ['data', 'propertyInfo', 'propertyContentSectionGroups', 'policies'],
        {},
    );
    const sections = policies.sections || [];

    for (const section of asArray(sections)) {
        const sectionHeader = section.header || {};
        const sectionTitle = sectionHeader.text ?? null;

        const items: Array<string | PolicySubSection> = [];
        const bodySubs = section.bodySubSections || [];

        for (const sub of asArray(bodySubs)) {
            const elementsV2 = sub.elementsV2 || [];
            for (const elemGroup of asArray(elementsV2)) {
                for (const element of asArray(elemGroup.elements)) {
                    // Get subsection header.
                    const header = element.header || {};
                    const subTitle = pyTruthy(header) ? header.text ?? null : null;
                    const iconId = pyTruthy(header) ? safeGet(header, ['icon', 'id']) : null;

                    // Get items.
                    const texts = extractTextItems(element.items || []);

                    if (pyTruthy(subTitle) && pyTruthy(texts)) {
                        items.push({
                            iconId,
                            title: subTitle,
                            items: texts,
                        });
                    } else if (pyTruthy(texts)) {
                        items.push(...texts);
                    }
                }
            }
        }

        if (pyTruthy(items)) {
            policiesList.push({
                title: sectionTitle,
                items,
            });
        }
    }

    return policiesList;
}

/** Extract important information items. */
function extractImportantInfo(contentData: any): string[] {
    const infoItems: string[] = [];

    const important = safeGet(
        contentData,
        ['data', 'propertyInfo', 'propertyContentSectionGroups', 'importantInfo'],
        {},
    );
    const sections = important.sections || [];

    for (const section of asArray(sections)) {
        const bodySubs = section.bodySubSections || [];
        for (const sub of asArray(bodySubs)) {
            const elementsV2 = sub.elementsV2 || [];
            for (const elemGroup of asArray(elementsV2)) {
                for (const element of asArray(elemGroup.elements)) {
                    const texts = extractTextItems(element.items || []);
                    infoItems.push(...texts);
                }
            }
        }
    }

    return infoItems;
}

/** Extract host information from aboutThisHost section. */
function extractHostData(contentData: any): HostData {
    const result: HostData = {
        id: null,
        name: null,
        profileImage: null,
        about: null,
    };

    const aboutHost = safeGet(
        contentData,
        ['data', 'propertyInfo', 'propertyContentSectionGroups', 'aboutThisHost'],
        {},
    );
    const sections = aboutHost.sections || [];

    for (const section of asArray(sections)) {
        // Check section header for host name.
        const sectionHeader = section.header || {};
        if (pyTruthy(sectionHeader)) {
            const headerText = sectionHeader.text;
            if (pyTruthy(headerText) && !pyTruthy(result.name)) {
                // Header text often contains "Hosted by {name}" or just the name.
                const match = /(?:[Hh]osted by\s+)?(.+)/.exec(headerText);
                if (match) {
                    result.name = match[1].trim();
                }
            }
        }

        const bodySubs = section.bodySubSections || [];
        for (const sub of asArray(bodySubs)) {
            const elementsV2 = sub.elementsV2 || [];
            for (const elemGroup of asArray(elementsV2)) {
                for (const element of asArray(elemGroup.elements)) {
                    // Check for profile image in leadingGraphic.
                    const leadingGraphic = element.leadingGraphic || {};
                    if (pyTruthy(leadingGraphic) && isDict(leadingGraphic)) {
                        const image = leadingGraphic.image || {};
                        if (pyTruthy(image) && isDict(image)) {
                            const imgUrl = image.url;
                            if (pyTruthy(imgUrl) && !pyTruthy(result.profileImage)) {
                                result.profileImage = imgUrl;
                            }
                        }
                    }

                    // Check header for host name.
                    const header = element.header || {};
                    if (pyTruthy(header)) {
                        const headerText = header.text;
                        if (pyTruthy(headerText) && !pyTruthy(result.name)) {
                            result.name = headerText;
                        }
                    }

                    // Extract about text from items.
                    const items = element.items || [];
                    const texts = extractTextItems(items);
                    if (pyTruthy(texts) && !pyTruthy(result.about)) {
                        result.about = texts.join(' ');
                    }
                }
            }
        }
    }

    return result;
}

// ---------------------------------------------------------------------------
// Bed types / review count / room setup / house rules
// ---------------------------------------------------------------------------

const BED_TYPE_PATTERN =
    /(\d+)\s+(king|queen|double|twin|single|sofa|bunk|full|trundle|futon)(?:\s+size)?\s*(?:sofa\s+)?beds?/gi;

/** Extract structured bed type information from feature text. */
function extractBedTypes(features: any): BedType[] {
    const bedTypes: BedType[] = [];
    const seen = new Set<string>();

    for (const feature of asArray(features)) {
        const text = isDict(feature) ? feature.text ?? '' : String(feature);
        // Fresh regex per text to reset lastIndex (global flag).
        const pattern = new RegExp(BED_TYPE_PATTERN.source, 'gi');
        let match: RegExpExecArray | null;
         
        while ((match = pattern.exec(String(text))) !== null) {
            const count = Number.parseInt(match[1], 10);
            let bedType = pyCapitalize(match[2]);
            // "Sofa Bed" special case.
            const matchedText = String(text)
                .slice(match.index, match.index + match[0].length)
                .toLowerCase();
            if (matchedText.includes('sofa') && bedType !== 'Sofa') {
                bedType = `${bedType} Sofa`;
            } else if (bedType === 'Sofa') {
                bedType = 'Sofa';
            }

            const key = `${bedType} ${count}`;
            if (!seen.has(key)) {
                seen.add(key);
                bedTypes.push({ type: bedType, count });
            }
        }
    }

    return bedTypes;
}

/** Extract total review count from PropertySummary. */
function extractReviewCount(summaryData: any): number | null {
    const countPattern = /(\d+)\s*(?:review|rating)/i;

    // Try PropertySummary reviewSummary (the only reliable source).
    const reviewSummary = safeGet(
        summaryData,
        ['data', 'propertyInfo', 'propertyDetails', 'reviewSummary'],
        {},
    );
    if (pyTruthy(reviewSummary)) {
        // Check totalCount (nested structure with raw/formatted).
        const {totalCount} = reviewSummary;
        if (isDict(totalCount)) {
            const {raw} = totalCount;
            if (typeof raw === 'number' && raw > 0) {
                return Math.trunc(raw);
            }
            const {formatted} = totalCount;
            if (typeof formatted === 'string') {
                const v = pyIntStrict(formatted.replace(/,/g, ''));
                if (v !== null && v > 0) {
                    return v;
                }
            }
            const val = totalCount.value;
            if (typeof val === 'number' && Number.isInteger(val) && val > 0) {
                return val;
            }
        }

        // Also check direct fields.
        for (const key of ['totalCount', 'count', 'reviewCount']) {
            const val = reviewSummary[key];
            if (typeof val === 'number' && Number.isInteger(val) && val > 0) {
                return val;
            }
        }

        // Check accessibilityLabel for review count like "4.8 out of 5, 28 reviews".
        const scoreObj = reviewSummary.overallScoreWithDescriptionA11y || {};
        const accessibilityLabel = isDict(scoreObj) ? scoreObj.accessibilityLabel : null;
        if (pyTruthy(accessibilityLabel)) {
            const match = countPattern.exec(accessibilityLabel);
            if (match) {
                return Number.parseInt(match[1], 10);
            }
        }
    }

    return null;
}

/** Parse room setup numbers from feature text. */
function extractRoomSetup(features: any): {
    guestCount: number | null;
    bedroomCount: number | null;
    bathroomCount: number | null;
} {
    const result: {
        guestCount: number | null;
        bedroomCount: number | null;
        bathroomCount: number | null;
    } = {
        guestCount: null,
        bedroomCount: null,
        bathroomCount: null,
    };

    const sleepsPattern = /[Ss]leeps?\s*(\d+)/;
    const bedroomPattern = /(\d+)\s*bedroom/i;
    const bathroomPattern = /(\d+)\+?\s*bathroom/i;

    for (const feature of asArray(features)) {
        const text = isDict(feature) ? feature.text ?? '' : String(feature);

        if (result.guestCount === null) {
            const match = sleepsPattern.exec(text);
            if (match) {
                result.guestCount = Number.parseInt(match[1], 10);
            }
        }

        if (result.bedroomCount === null) {
            const match = bedroomPattern.exec(text);
            if (match) {
                result.bedroomCount = Number.parseInt(match[1], 10);
            }
        }

        if (result.bathroomCount === null) {
            const match = bathroomPattern.exec(text);
            if (match) {
                result.bathroomCount = Number.parseInt(match[1], 10);
            }
        }
    }

    return result;
}

/** Extract structured house rules from policies. */
function extractHouseRules(policies: any): HouseRules {
    const result: HouseRules = {
        checkInTime: null,
        checkOutTime: null,
        smokingAllowed: null,
        petsAllowed: null,
        eventsAllowed: null,
    };

    const checkinPattern =
        /[Cc]heck[- ]?in[:\s]+(?:after\s+)?(\d{1,2}(?::\d{2})?\s*(?:[AaPp][Mm])?)/i;
    const checkoutPattern =
        /[Cc]heck[- ]?out[:\s]+(?:before\s+)?(\d{1,2}(?::\d{2})?\s*(?:[AaPp][Mm])?)/i;

    const smokingNoPattern =
        /no\s+smoking|smoking\s+(?:is\s+)?not\s+(?:allowed|permitted)|non[- ]?smoking/i;
    const smokingYesPattern = /smoking\s+(?:is\s+)?(?:allowed|permitted)/i;

    const petsNoPattern = /no\s+pets|pets?\s+(?:are\s+)?not\s+allowed|pet[- ]?free/i;
    const petsYesPattern = /pets?\s+(?:are\s+)?allowed|pets?\s+welcome|pet[- ]?friendly/i;

    const eventsNoPattern =
        /no\s+(?:events?|parties)|(?:events?|parties)\s+(?:are\s+)?not\s+allowed/i;
    const eventsYesPattern = /(?:events?|parties)\s+(?:are\s+)?allowed|suitable\s+for\s+events/i;

    function searchPolicies(obj: any): string[] {
        const texts: string[] = [];
        if (isDict(obj)) {
            for (const [key, val] of Object.entries(obj)) {
                if ((key === 'text' || key === 'title' || key === 'value') && typeof val === 'string') {
                    texts.push(val);
                } else {
                    texts.push(...searchPolicies(val));
                }
            }
        } else if (Array.isArray(obj)) {
            for (const item of obj) {
                texts.push(...searchPolicies(item));
            }
        } else if (typeof obj === 'string') {
            texts.push(obj);
        }
        return texts;
    }

    const allText = searchPolicies(policies).join(' ');

    // Extract check-in time.
    let match = checkinPattern.exec(allText);
    if (match) {
        result.checkInTime = match[1].trim();
    }

    // Extract check-out time.
    match = checkoutPattern.exec(allText);
    if (match) {
        result.checkOutTime = match[1].trim();
    }

    // Extract smoking policy.
    if (smokingNoPattern.test(allText)) {
        result.smokingAllowed = false;
    } else if (smokingYesPattern.test(allText)) {
        result.smokingAllowed = true;
    }

    // Extract pets policy.
    if (petsNoPattern.test(allText)) {
        result.petsAllowed = false;
    } else if (petsYesPattern.test(allText)) {
        result.petsAllowed = true;
    }

    // Extract events policy.
    if (eventsNoPattern.test(allText)) {
        result.eventsAllowed = false;
    } else if (eventsYesPattern.test(allText)) {
        result.eventsAllowed = true;
    }

    return result;
}

// ---------------------------------------------------------------------------
// Images / features
// ---------------------------------------------------------------------------

/** Extract images from ProductGallery response. */
function extractImages(galleryData: any): PropertyImage[] {
    const images: PropertyImage[] = [];

    const gallery = safeGet(galleryData, ['data', 'productGallery'], {});

    // Featured images first.
    const featured = gallery.featured || [];
    for (const imgInfo of asArray(featured)) {
        if (!isDict(imgInfo)) {
            continue;
        }
        const image = safeGet(imgInfo, ['image'], {});
        const url = isDict(image) ? image.url ?? null : null;
        const description = (isDict(image) ? image.description : null) ?? imgInfo.description ?? null;
        if (pyTruthy(url)) {
            images.push({
                url,
                description: description ?? null,
            });
        }
    }

    // Categorized images.
    const categorized = gallery.categorizedImages || [];
    for (const category of asArray(categorized)) {
        if (!isDict(category)) {
            continue;
        }
        const categoryImages = category.images || [];
        for (const imgInfo of asArray(categoryImages)) {
            if (!isDict(imgInfo)) {
                continue;
            }
            const image = safeGet(imgInfo, ['image'], {});
            const url = isDict(image) ? image.url ?? null : null;
            const description = (isDict(image) ? image.description : null) ?? imgInfo.description ?? null;
            if (pyTruthy(url) && !images.some((i) => i.url === url)) {
                images.push({
                    url,
                    description: description ?? null,
                });
            }
        }
    }

    return images;
}

/** Extract property features (bedrooms, bathrooms, sleeps) from PropertySummary spaceOverview. */
function extractFeatures(summaryData: any): Feature[] {
    const features: Feature[] = [];

    const spaceOverview = safeGet(
        summaryData,
        ['data', 'propertyInfo', 'summary', 'spaceOverview'],
        {},
    );

    function extractFromItem(item: any): Feature | null {
        if (!isDict(item)) {
            return null;
        }

        const {text} = item;
        const primary = item.primary || {};
        const primaryText = isDict(primary) ? primary.text ?? null : null;

        let iconId: any = null;
        const primaryGraphic = safeGet(primary, ['graphic'], {});
        if (isDict(primaryGraphic)) {
            iconId = primaryGraphic.id ?? null;
        }
        if (!pyTruthy(iconId)) {
            const itemGraphic = item.graphic || {};
            if (isDict(itemGraphic)) {
                iconId = itemGraphic.id ?? null;
            }
        }
        if (!pyTruthy(iconId)) {
            const itemIcon = item.icon || {};
            if (isDict(itemIcon)) {
                iconId = itemIcon.id ?? null;
            }
        }

        const displayText = primaryText ?? text;
        if (pyTruthy(displayText)) {
            return { iconId: iconId ?? null, text: displayText };
        }
        return null;
    }

    // Check infoItems first.
    const infoItems = spaceOverview.infoItems || [];
    for (const item of asArray(infoItems)) {
        const feature = extractFromItem(item);
        if (feature) {
            features.push(feature);
        }
    }

    // Also check items array.
    const items = spaceOverview.items || [];
    for (const item of asArray(items)) {
        const feature = extractFromItem(item);
        if (feature && !features.some((f) => f.text === feature.text)) {
            features.push(feature);
        }
    }

    return features;
}

// ---------------------------------------------------------------------------
// Pricing / units
// ---------------------------------------------------------------------------

/** Extract pricing information from PropertyOffers response. */
function extractPricing(offersData: any): Pricing | null {
    const tripSummary = safeGet(offersData, ['data', 'propertyOffers', 'tripSummary'], {});

    if (!pyTruthy(tripSummary)) {
        return null;
    }

    const price = tripSummary.price || {};
    if (!pyTruthy(price)) {
        return null;
    }

    const lead = price.lead || {};
    const total = price.total || {};

    const currencyInfo = lead.currencyInfo || {};

    const result: Pricing = {
        total: total.amount ?? null,
        nightly: lead.amount ?? null,
        currency: currencyInfo.code ?? null,
        formattedTotal: lead.formatted ?? null,
        roomNightMessage: price.roomNightMessage ?? null,
    };

    // Get display messages.
    const displayMessages = price.displayMessages || [];
    const priceLines: PriceLine[] = [];
    for (const msg of asArray(displayMessages)) {
        const lineItems = msg.lineItems || [];
        for (const item of asArray(lineItems)) {
            if (item.__typename === 'DisplayPrice') {
                const formatted = safeGet(item, ['price', 'formatted']);
                const label = safeGet(item, ['price', 'accessibilityLabel']);
                if (pyTruthy(formatted)) {
                    priceLines.push({ formatted, label: label ?? null });
                }
            }
        }
    }
    if (pyTruthy(priceLines)) {
        result.priceBreakdown = priceLines;
    }

    return result;
}

/** Helper to extract price data from a price object. */
function extractPriceFromObject(price: any): UnitPrice | null {
    if (!isDict(price)) {
        return null;
    }

    const lead = price.lead || {};
    const total = price.total || {};

    // Check if we have actual price data.
    if ((lead.amount ?? null) !== null || pyTruthy(lead.formatted)) {
        const currencyInfo = lead.currencyInfo || {};
        return {
            amount: lead.amount ?? null,
            formatted: lead.formatted ?? null,
            total: total.amount ?? null,
            totalFormatted: total.formatted ?? null,
            currency: currencyInfo.code ?? null,
        };
    }

    return null;
}

/** Extract per-unit pricing from a LodgingCategorizedUnit. */
function extractUnitPrice(listing: any): UnitPrice | null {
    const primarySelections = listing.primarySelections || [];

    for (const selection of asArray(primarySelections)) {
        if (!isDict(selection)) {
            continue;
        }

        const propertyUnit = selection.propertyUnit || {};
        const ratePlans = propertyUnit.ratePlans || [];

        for (const ratePlan of asArray(ratePlans)) {
            if (!isDict(ratePlan)) {
                continue;
            }

            const priceDetailsRaw = ratePlan.priceDetails;

            // Handle priceDetails being either a dict (VRBO) or list (Expedia).
            if (Array.isArray(priceDetailsRaw)) {
                // Expedia format: priceDetails is a list of price detail objects.
                for (const pd of priceDetailsRaw) {
                    if (!isDict(pd)) {
                        continue;
                    }
                    const price = pd.price || {};
                    const result = extractPriceFromObject(price);
                    if (result) {
                        return result;
                    }
                }
            } else if (isDict(priceDetailsRaw)) {
                // VRBO format: priceDetails is a single dict.
                const price = priceDetailsRaw.price || {};
                const result = extractPriceFromObject(price);
                if (result) {
                    return result;
                }
            }
        }
    }

    return null;
}

/** Build a mapping of unit names to their matched gallery images. */
function buildUnitImageMap(galleryData: any, unitNames: string[]): Record<string, UnitImage[]> {
    const result: Record<string, UnitImage[]> = {};
    for (const name of unitNames) {
        result[name] = [];
    }

    if (!pyTruthy(galleryData) || !pyTruthy(unitNames)) {
        return result;
    }

    const categorizedImages = safeGet(
        galleryData,
        ['data', 'productGallery', 'categorizedImages'],
        [],
    );
    const allImages: any[] = [];
    for (const category of asArray(categorizedImages)) {
        // Skip the "all" category to avoid duplicating every image.
        const catId = category.categoryId ?? '';
        if (catId === 'all') {
            continue;
        }
        for (const imgItem of asArray(category.images)) {
            allImages.push(imgItem);
        }
    }

    // Normalize unit names for matching (lowercase, stripped).
    const normalizedUnits: Array<[string, string]> = unitNames.map((name) => [
        name,
        name.toLowerCase().trim(),
    ]);

    for (const imgItem of allImages) {
        const img = imgItem.image || {};
        const {url} = img;
        if (!pyTruthy(url)) {
            continue;
        }

        const description = img.description || '';
        if (!description.includes(' | ')) {
            continue;
        }

        const prefix = description.split(' | ')[0].trim().toLowerCase();
        if (!pyTruthy(prefix)) {
            continue;
        }

        // Bidirectional prefix match.
        for (const [name, normName] of normalizedUnits) {
            if (prefix.startsWith(normName) || normName.startsWith(prefix)) {
                result[name].push({
                    url,
                    description: img.description ?? null,
                    aspectRatio: img.aspectRatio ?? null,
                });
                break; // Each image matches at most one unit.
            }
        }
    }

    return result;
}

/** Extract unit information from PropertyOffers categorizedListings. */
function extractUnitsFromOffers(
    offersData: any,
    galleryData: any = null,
    roomAmenities: AmenityCategory[] | null = null,
): PropertyUnit[] {
    const units: PropertyUnit[] = [];

    const categorizedListings = safeGet(
        offersData,
        ['data', 'propertyOffers', 'categorizedListings'],
        [],
    );

    // Property-level price from tripSummary as fallback.
    const tripSummary = safeGet(offersData, ['data', 'propertyOffers', 'tripSummary'], {});
    let propertyPrice: UnitPrice | null = null;
    if (pyTruthy(tripSummary)) {
        const priceData = tripSummary.price || {};
        const lead = priceData.lead || {};
        if (pyTruthy(lead.formatted) || (lead.amount ?? null) !== null) {
            const currencyInfo = lead.currencyInfo || {};
            const totalData = priceData.total || {};
            propertyPrice = {
                amount: lead.amount ?? null,
                formatted: lead.formatted ?? null,
                total: totalData.amount ?? null,
                totalFormatted: null,
                currency: currencyInfo.code ?? null,
            };
        }
    }

    // Collect unit names first for image matching.
    const unitNames: string[] = [];
    for (const listing of asArray(categorizedListings)) {
        if (!isDict(listing)) {
            continue;
        }
        if (listing.__typename === 'LodgingCategorizedUnit' && pyTruthy(listing.unitId)) {
            const header = listing.header || {};
            const name = header.text;
            if (pyTruthy(name)) {
                unitNames.push(name);
            }
        }
    }

    // Build per-unit image map using description-based matching.
    const unitImageMap = buildUnitImageMap(galleryData, unitNames);

    for (const listing of asArray(categorizedListings)) {
        if (!isDict(listing)) {
            continue;
        }

        const typename = listing.__typename;
        if (typename === 'LodgingCategorizedUnit') {
            const {unitId} = listing;
            if (pyTruthy(unitId)) {
                const header = listing.header || {};
                const unitName = header.text ?? null;
                const unitSubtext = header.subText ?? null;

                // Extract features array as dicts with text and iconId.
                const featuresData = listing.features || [];
                const features: Feature[] = [];
                for (const feature of asArray(featuresData)) {
                    if (isDict(feature) && pyTruthy(feature.text)) {
                        const iconId = safeGet(feature, ['icon', 'id']);
                        features.push({ text: feature.text, iconId });
                    }
                }

                // Per-unit price, fallback to property price.
                const unitPrice = extractUnitPrice(listing) ?? propertyPrice;

                // Look up matched images by unit name.
                // Python: unit_image_map.get(unit_name, []) — when unit_name is
                // null (no header text) it isn't a key, so defaults to [].
                const unitImages =
                    unitName !== null && Object.prototype.hasOwnProperty.call(unitImageMap, unitName)
                        ? unitImageMap[unitName]
                        : [];

                // Extract bed types from features.
                const bedTypes = extractBedTypes(features);

                units.push({
                    id: unitId,
                    name: unitName,
                    description: unitSubtext,
                    features,
                    amenities: roomAmenities || [],
                    images: unitImages,
                    price: unitPrice,
                    bedTypes: pyTruthy(bedTypes) ? bedTypes : null,
                });
            }
        }
    }

    return units;
}

/** Extract units from gallery image descriptions when offers has no categorizedListings. */
function extractUnitsFromGallery(
    galleryData: any,
    roomAmenities: AmenityCategory[] | null = null,
): PropertyUnit[] {
    if (!pyTruthy(galleryData)) {
        return [];
    }

    const categorizedImages = safeGet(
        galleryData,
        ['data', 'productGallery', 'categorizedImages'],
        [],
    );

    // Collect all images with unit name prefixes. A Map preserves first-seen
    // insertion order, matching Python dict iteration order.
    const unitImages = new Map<string, UnitImage[]>();

    for (const category of asArray(categorizedImages)) {
        const catId = category.categoryId ?? '';
        if (catId === 'all') {
            continue;
        }
        for (const imgItem of asArray(category.images)) {
            const img = imgItem.image || {};
            const {url} = img;
            const description = img.description || '';
            if (!pyTruthy(url) || !description.includes(' | ')) {
                continue;
            }

            const prefix = description.split(' | ')[0].trim();
            if (!pyTruthy(prefix)) {
                continue;
            }

            if (!unitImages.has(prefix)) {
                unitImages.set(prefix, []);
            }

            unitImages.get(prefix)!.push({
                url,
                description,
                aspectRatio: img.aspectRatio ?? null,
            });
        }
    }

    if (unitImages.size === 0) {
        return [];
    }

    const units: PropertyUnit[] = [];
    for (const [name, images] of unitImages) {
        units.push({
            id: null,
            name,
            description: null,
            features: [],
            amenities: roomAmenities || [],
            images,
            price: null,
        });
    }

    return units;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function formatProperty(args: {
    summaryData: any;
    contentData: any;
    url: string;
    propertyId: string;
    platform: Platform;
    galleryData?: any;
    offersData?: any;
    pageLayoutData?: any;
}): PropertyResult {
    const {
        summaryData,
        contentData,
        url,
        propertyId,
        platform,
        galleryData = null,
        offersData = null,
        pageLayoutData = null,
    } = args;

    // review_data is part of the Python signature but always defaulted to None
    // by every caller in main.py, so it is omitted here.

    // Extract from PropertySummary.
    const summary = safeGet(summaryData, ['data', 'propertyInfo', 'summary'], {});

    // Mirror Python `dict.get(key, "")`: the "" default applies only when the
    // key is ABSENT. A present-but-null value (the API sends `tagline: null`)
    // must stay null, not collapse to "" — otherwise `tagline != name` would
    // wrongly emit "" instead of None in the output.
    const name = isDict(summary) && 'name' in summary ? summary.name : '';
    const tagline = isDict(summary) && 'tagline' in summary ? summary.tagline : '';

    // Location data.
    const location = summary.location || {};
    const address = location.address || {};
    const coordinates = location.coordinates || {};
    const parentRegion = location.parentRegion || {};

    // Review/rating - try page layout first (most reliable), then review summary.
    let [rating, reviewCountFromLayout] = extractRatingFromPageLayout(pageLayoutData);

    // Fall back to PropertySummary reviewSummary if page layout had no rating.
    if (rating === null) {
        const propertyDetails = safeGet(
            summaryData,
            ['data', 'propertyInfo', 'propertyDetails'],
            {},
        );
        const reviewSummary = propertyDetails.reviewSummary || {};
        rating = extractRating(reviewSummary);
    }

    // Extract from PropertyContent.
    const description = extractDescription(contentData);
    const highlightedAmenities = extractAmenitiesSummary(contentData);
    const detailedAmenities = extractDetailedAmenities(contentData);
    const policies = extractPolicies(contentData);
    const importantInfo = extractImportantInfo(contentData);

    // Extract images from gallery data.
    const images = pyTruthy(galleryData) ? extractImages(galleryData) : [];

    // Extract features from summary data.
    const features = extractFeatures(summaryData);

    // Extract pricing from offers data.
    const pricing = pyTruthy(offersData) ? extractPricing(offersData) : null;

    // Extract host data.
    const host = extractHostData(contentData);

    // Extract review count - prefer page layout, fall back to summary.
    let reviewCount = reviewCountFromLayout;
    if (reviewCount === null) {
        reviewCount = extractReviewCount(summaryData);
    }

    // Extract room setup (parse counts from features).
    const roomSetup = extractRoomSetup(features);

    // Extract structured house rules from policies.
    const houseRules = extractHouseRules(policies);

    // Get thumbnail (first image URL).
    const thumbnail = pyTruthy(images) ? images[0].url ?? null : null;

    // Extract room amenities separately for per-unit attachment.
    let roomAmenities = extractCategorizedAmenitiesFromSummary(contentData, 'Room amenities');

    // Fallback: room-relevant categories from detailed amenities.
    if (!pyTruthy(roomAmenities)) {
        roomAmenities = extractRoomAmenitiesFallback(contentData);
    }

    // Extract units from categorizedListings (multi-unit properties).
    let units = pyTruthy(offersData)
        ? extractUnitsFromOffers(offersData, galleryData, roomAmenities)
        : [];

    // Fallback: discover units from gallery image descriptions.
    if (!pyTruthy(units) && pyTruthy(galleryData)) {
        units = extractUnitsFromGallery(galleryData, roomAmenities);
    }

    // If still no units, create single-unit fallback.
    if (!pyTruthy(units)) {
        const bedTypes = extractBedTypes(features);
        units.push({
            id: null,
            name: null,
            images: [],
            features,
            amenities: roomAmenities,
            price: pricing,
            bedTypes: pyTruthy(bedTypes) ? bedTypes : null,
        });
    }

    return {
        source: PLATFORM_LABEL_MAP[platform],
        url,
        id: propertyId,
        name: name || tagline,
        tagline: tagline !== name ? tagline : null,
        description: pyTruthy(description) ? description.slice(0, 1000) : null,
        thumbnail,
        latitude: coordinates.latitude ?? null,
        longitude: coordinates.longitude ?? null,
        country: address.countryCode ?? null,
        city: address.city ?? null,
        region: (address.province || parentRegion.name) ?? null,
        street: address.addressLine ?? null,
        rating,
        reviewCount,
        guestCount: roomSetup.guestCount,
        bedroomCount: roomSetup.bedroomCount,
        bathroomCount: roomSetup.bathroomCount,
        images,
        features,
        highlightedAmenities,
        amenities: detailedAmenities,
        policies,
        importantInfo,
        host,
        houseRules,
        units,
        scrapedAt: nowIso(),
    };
}

export function formatError(
    url: string,
    propertyId: string,
    error: string,
    platform: Platform | null,
): ErrorRow {
    return {
        source: platform ? PLATFORM_LABEL_MAP[platform] : null,
        url,
        id: propertyId,
        error,
        scrapedAt: nowIso(),
    };
}
