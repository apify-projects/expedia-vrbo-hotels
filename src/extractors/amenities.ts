import type { AmenityCategory, HighlightedAmenity } from '../types.js';
import { asArray, extractTextItems, pyTruthy, safeGet } from './common.js';

/** Extract highlighted amenities from amenitiesSummary. */
export function extractAmenitiesSummary(contentData: any): HighlightedAmenity[] {
    const amenitiesList: HighlightedAmenity[] = [];

    const amenities = safeGet(contentData, ['data', 'propertyInfo', 'amenitiesSummary', 'amenities'], {});
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
export function extractCategorizedAmenitiesFromSummary(
    contentData: any,
    sectionFilter: string | null = null,
): AmenityCategory[] {
    const categories: AmenityCategory[] = [];

    const summary = safeGet(contentData, ['data', 'propertyInfo', 'amenitiesSummary', 'amenities'], {});
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
export function extractDetailedAmenities(contentData: any): AmenityCategory[] {
    let categories: AmenityCategory[] = [];

    // Try detailedAmenitiesContent first (Vrbo structure).
    const detailed = safeGet(contentData, ['data', 'propertyInfo', 'detailedAmenitiesContent', 'amenities'], {});
    const sections = detailed.sections || [];

    if (pyTruthy(sections)) {
        // Vrbo structure: categories are in bodySubSections headers.
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
export function extractRoomAmenitiesFallback(contentData: any): AmenityCategory[] {
    // Try detailedAmenitiesContent first.
    const detailed = safeGet(contentData, ['data', 'propertyInfo', 'detailedAmenitiesContent', 'amenities'], {});
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
    const summary = safeGet(contentData, ['data', 'propertyInfo', 'amenitiesSummary', 'amenities'], {});
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
