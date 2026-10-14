import type { AmenityCategory, BedType, Feature, PropertyUnit, UnitImage } from '../types.js';
import { asArray, isDict, pyCapitalize, pyTruthy, safeGet } from './common.js';

const BED_TYPE_PATTERN =
    /(\d+)\s+(king|queen|double|twin|single|sofa|bunk|full|trundle|futon)(?:\s+size)?\s*(?:sofa\s+)?beds?/gi;

/** Extract structured bed type information from feature text. */
export function extractBedTypes(features: any): BedType[] {
    const bedTypes: BedType[] = [];
    const seen = new Set<string>();

    for (const feature of asArray(features)) {
        const text = isDict(feature) ? (feature.text ?? '') : String(feature);
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

/** Build a mapping of unit names to their matched gallery images. */
function buildUnitImageMap(galleryData: any, unitNames: string[]): Record<string, UnitImage[]> {
    const result: Record<string, UnitImage[]> = {};
    for (const name of unitNames) {
        result[name] = [];
    }

    if (!pyTruthy(galleryData) || !pyTruthy(unitNames)) {
        return result;
    }

    const categorizedImages = safeGet(galleryData, ['data', 'productGallery', 'categorizedImages'], []);
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

    const normalizedUnits: [string, string][] = unitNames.map((name) => [name, name.toLowerCase().trim()]);

    for (const imgItem of allImages) {
        const img = imgItem.image || {};
        const { url } = img;
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
export function extractUnitsFromOffers(
    offersData: any,
    galleryData: any = null,
    roomAmenities: AmenityCategory[] | null = null,
): PropertyUnit[] {
    const units: PropertyUnit[] = [];

    const categorizedListings = safeGet(offersData, ['data', 'propertyOffers', 'categorizedListings'], []);

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

    const unitImageMap = buildUnitImageMap(galleryData, unitNames);

    for (const listing of asArray(categorizedListings)) {
        if (!isDict(listing)) {
            continue;
        }

        const typename = listing.__typename;
        if (typename === 'LodgingCategorizedUnit') {
            const { unitId } = listing;
            if (pyTruthy(unitId)) {
                const header = listing.header || {};
                const unitName = header.text ?? null;
                const unitSubtext = header.subText ?? null;

                const featuresData = listing.features || [];
                const features: Feature[] = [];
                for (const feature of asArray(featuresData)) {
                    if (isDict(feature) && pyTruthy(feature.text)) {
                        const iconId = safeGet(feature, ['icon', 'id']);
                        features.push({ text: feature.text, iconId });
                    }
                }

                // Python: unit_image_map.get(unit_name, []) - when unit_name is
                // null (no header text) it isn't a key, so defaults to [].
                const unitImages =
                    unitName !== null && Object.prototype.hasOwnProperty.call(unitImageMap, unitName)
                        ? unitImageMap[unitName]
                        : [];

                const bedTypes = extractBedTypes(features);

                units.push({
                    id: unitId,
                    name: unitName,
                    description: unitSubtext,
                    features,
                    amenities: roomAmenities || [],
                    images: unitImages,
                    bedTypes: pyTruthy(bedTypes) ? bedTypes : null,
                });
            }
        }
    }

    return units;
}

/** Extract units from gallery image descriptions when offers has no categorizedListings. */
export function extractUnitsFromGallery(
    galleryData: any,
    roomAmenities: AmenityCategory[] | null = null,
): PropertyUnit[] {
    if (!pyTruthy(galleryData)) {
        return [];
    }

    const categorizedImages = safeGet(galleryData, ['data', 'productGallery', 'categorizedImages'], []);

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
            const { url } = img;
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
        });
    }

    return units;
}
