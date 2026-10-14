import { isDict, pyFloat, pyIntStrict, pyRound1, pyTruthy, safeGet } from './common.js';

/**
 * Extract rating and review count from TemplatePageLayout config.
 *
 * Primary source: seoStructuredData -> aggregateRating.
 * Fallback for review count: "See all X reviews" pattern in the raw config str.
 *
 * Returns [ratingValue, reviewCount].
 */
export function extractRatingFromPageLayout(pageLayoutData: any): [number | null, number | null] {
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
                        // Not the JSON blob we are after; keep walking.
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
        // bestRating "0" means the property has no rating yet, not that it scored 0.
        const bestRating = 'bestRating' in aggregateRating ? pyFloat(aggregateRating.bestRating) : 10;
        const hasRatingScale = bestRating !== null && bestRating > 0;

        const ratingStr = aggregateRating.ratingValue;
        if (hasRatingScale && pyTruthy(ratingStr) && ratingStr !== 'null') {
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
export function extractRating(reviewSummary: any): number | null {
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
                    // 5-point scale.
                    ratingValue = pyRound1(parsed * 2);
                } else if (maxVal === 10) {
                    ratingValue = parsed;
                } else {
                    // Any other scale.
                    ratingValue = pyRound1((parsed / maxVal) * 10);
                }
                break;
            }
            // A bare number counts only if it is already on the 10-point scale.
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

/** Extract total review count from PropertySummary. */
export function extractReviewCount(summaryData: any): number | null {
    const countPattern = /(\d+)\s*(?:review|rating)/i;

    // Try PropertySummary reviewSummary (the only reliable source).
    const reviewSummary = safeGet(summaryData, ['data', 'propertyInfo', 'propertyDetails', 'reviewSummary'], {});
    if (pyTruthy(reviewSummary)) {
        // Check totalCount (nested structure with raw/formatted).
        const { totalCount } = reviewSummary;
        if (isDict(totalCount)) {
            const { raw } = totalCount;
            if (typeof raw === 'number' && raw > 0) {
                return Math.trunc(raw);
            }
            const { formatted } = totalCount;
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
