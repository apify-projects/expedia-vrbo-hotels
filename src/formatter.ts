/**
 * Output formatter for Vrbo / Expedia / Hotels.com property details.
 *
 * Turns the raw PropertySummary / PropertyContent / ProductGallery /
 * PropertyOffers / TemplatePageLayout responses into one dataset item. The
 * fallback order between those sources is load-bearing: several fields have a
 * second source, used only when the first is empty.
 *
 * All functions are pure (no network, no I/O).
 */
import {
    extractAmenitiesSummary,
    extractCategorizedAmenitiesFromSummary,
    extractDetailedAmenities,
    extractRoomAmenitiesFallback,
} from './extractors/amenities.js';
import { asArray, extractTextItems, isDict, nowIso, nullIfBlank, pyTruthy, safeGet } from './extractors/common.js';
import { extractHouseRules, extractImportantInfo, extractPolicies } from './extractors/policies.js';
import { extractRating, extractRatingFromPageLayout, extractReviewCount } from './extractors/rating.js';
import { extractBedTypes, extractUnitsFromGallery, extractUnitsFromOffers } from './extractors/units.js';
import type { ErrorItem, Feature, PropertyImage, PropertyResult } from './types.js';
import type { Platform } from './url-parser.js';
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
                    const header = element.header || {};
                    if (pyTruthy(header)) {
                        const headerText = header.text;
                        if (pyTruthy(headerText) && !pyTruthy(title)) {
                            title = headerText;
                        }
                    }

                    const items = element.items || [];
                    const texts = extractTextItems(items);
                    descriptionParts.push(...texts);
                }
            }
        }
    }

    return descriptionParts.join(' ').trim();
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
        const text = isDict(feature) ? (feature.text ?? '') : String(feature);

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
        const url = isDict(image) ? (image.url ?? null) : null;
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
            const url = isDict(image) ? (image.url ?? null) : null;
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

    const spaceOverview = safeGet(summaryData, ['data', 'propertyInfo', 'summary', 'spaceOverview'], {});

    function extractFromItem(item: any): Feature | null {
        if (!isDict(item)) {
            return null;
        }

        const { text } = item;
        const primary = item.primary || {};
        const primaryText = isDict(primary) ? (primary.text ?? null) : null;

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

    const infoItems = spaceOverview.infoItems || [];
    for (const item of asArray(infoItems)) {
        const feature = extractFromItem(item);
        if (feature) {
            features.push(feature);
        }
    }

    const items = spaceOverview.items || [];
    for (const item of asArray(items)) {
        const feature = extractFromItem(item);
        if (feature && !features.some((f) => f.text === feature.text)) {
            features.push(feature);
        }
    }

    return features;
}

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

    const summary = safeGet(summaryData, ['data', 'propertyInfo', 'summary'], {});

    const { name } = summary;

    const location = summary.location || {};
    const address = location.address || {};
    const coordinates = location.coordinates || {};
    const parentRegion = location.parentRegion || {};

    // Review/rating - try page layout first (most reliable), then review summary.
    let [rating, reviewCountFromLayout] = extractRatingFromPageLayout(pageLayoutData);

    // Fall back to PropertySummary reviewSummary if page layout had no rating.
    if (rating === null) {
        const propertyDetails = safeGet(summaryData, ['data', 'propertyInfo', 'propertyDetails'], {});
        const reviewSummary = propertyDetails.reviewSummary || {};
        rating = extractRating(reviewSummary);
    }

    const description = extractDescription(contentData);
    const highlightedAmenities = extractAmenitiesSummary(contentData);
    const detailedAmenities = extractDetailedAmenities(contentData);
    const policies = extractPolicies(contentData);
    const importantInfo = extractImportantInfo(contentData);

    const images = pyTruthy(galleryData) ? extractImages(galleryData) : [];

    const features = extractFeatures(summaryData);

    let reviewCount = reviewCountFromLayout;
    if (reviewCount === null) {
        reviewCount = extractReviewCount(summaryData);
    }

    const roomSetup = extractRoomSetup(features);

    const houseRules = extractHouseRules(policies);

    const thumbnail = pyTruthy(images) ? (images[0].url ?? null) : null;

    // Kept separate from the property amenities so each unit can carry its own.
    let roomAmenities = extractCategorizedAmenitiesFromSummary(contentData, 'Room amenities');

    // Fallback: room-relevant categories from detailed amenities.
    if (!pyTruthy(roomAmenities)) {
        roomAmenities = extractRoomAmenitiesFallback(contentData);
    }

    // Multi-unit properties list their units under categorizedListings.
    let units = pyTruthy(offersData) ? extractUnitsFromOffers(offersData, galleryData, roomAmenities) : [];

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
            bedTypes: pyTruthy(bedTypes) ? bedTypes : null,
        });
    }

    return {
        platform,
        url,
        id: propertyId,
        name,
        description: pyTruthy(description) ? description.slice(0, 1000) : null,
        thumbnail,
        latitude: coordinates.latitude ?? null,
        longitude: coordinates.longitude ?? null,
        country: nullIfBlank(address.countryCode),
        city: nullIfBlank(address.city),
        region: nullIfBlank(address.province || parentRegion.name),
        street: nullIfBlank(address.addressLine),
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
        houseRules,
        units,
        scrapedAt: nowIso(),
    };
}

export function formatError(url: string, propertyId: string, error: string, platform: Platform | null): ErrorItem {
    return {
        platform,
        url,
        id: propertyId,
        error,
        scrapedAt: nowIso(),
    };
}
