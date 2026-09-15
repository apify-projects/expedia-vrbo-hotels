/**
 * The dataset row shapes `formatter.ts` produces.
 *
 * Field order is the row's column order, and the null-vs-absent distinction is
 * deliberate: a null field is one the API did not fill, an absent one is a field
 * that code path never builds.
 */
import type { Platform } from './url-parser.js';

/** An image entry produced by `extractImages`. */
export interface PropertyImage {
    url: string;
    /** description may be null (image.description / img_info.description fallback). */
    description: string | null;
}

/**
 * A per-unit image, from `buildUnitImageMap` or `extractUnitsFromGallery`.
 * Carries an extra aspectRatio field.
 */
export interface UnitImage {
    url: string;
    description: string | null;
    aspectRatio: string | null;
}

/** A highlighted amenity from `extractAmenitiesSummary`. */
export interface HighlightedAmenity {
    iconId: string | null;
    text: string;
}

/** A categorized amenity block from `extract_detailed_amenities`. */
export interface AmenityCategory {
    title: string;
    items: string[];
}

/**
 * A policy block from `extract_policies`. `items` is a heterogeneous array:
 * either plain strings (text items) or nested PolicySubSection objects.
 */
export interface PolicySubSection {
    iconId: string | null;
    title: string;
    items: string[];
}

export interface PolicySection {
    /** section header text; may be null when absent. */
    title: string | null;
    items: (string | PolicySubSection)[];
}

/** Structured house rules from `extract_house_rules`. */
export interface HouseRules {
    checkInTime: string | null;
    checkOutTime: string | null;
    smokingAllowed: boolean | null;
    petsAllowed: boolean | null;
    eventsAllowed: boolean | null;
}

/** A property/unit feature from `extractFeatures`. */
export interface Feature {
    iconId: string | null;
    text: string;
}

/** A structured bed type from `extractBedTypes`. */
export interface BedType {
    type: string;
    count: number;
}

/**
 * A unit entry. Units are built from three code paths with slightly different
 * key sets, so several fields are optional/absent:
 *
 * - from offers (`extractUnitsFromOffers`): has `bedTypes`.
 * - from gallery (`extractUnitsFromGallery`): NO `bedTypes` key.
 * - single-unit fallback: NO top-level `description` key, but has `bedTypes`.
 */
export interface PropertyUnit {
    id: string | null;
    name: string | null;
    /** Present in offers/gallery units; ABSENT in the single-unit fallback. */
    description?: string | null;
    features: Feature[];
    amenities: AmenityCategory[];
    images: UnitImage[];
    /** Present in offers/fallback units; ABSENT in gallery-derived units. null when empty. */
    bedTypes?: BedType[] | null;
}

/** The success row returned by `formatProperty`. */
export interface PropertyResult {
    platform: Platform;
    url: string;
    id: string;
    name: string;
    description: string | null;
    thumbnail: string | null;
    latitude: number | null;
    longitude: number | null;
    country: string | null;
    city: string | null;
    region: string | null;
    street: string | null;
    rating: number | null;
    reviewCount: number | null;
    guestCount: number | null;
    bedroomCount: number | null;
    bathroomCount: number | null;
    images: PropertyImage[];
    features: Feature[];
    highlightedAmenities: HighlightedAmenity[];
    amenities: AmenityCategory[];
    policies: PolicySection[];
    importantInfo: string[];
    houseRules: HouseRules;
    units: PropertyUnit[];
    scrapedAt: string;
}

/** The error row returned by `formatError`. */
export interface ErrorRow {
    platform: Platform | null;
    url: string;
    id: string;
    error: string;
    scrapedAt: string;
}
