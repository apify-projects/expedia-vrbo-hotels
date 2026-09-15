/**
 * Output types for the property formatter.
 *
 * Faithful port of the output dict shapes produced by
 * `src/formatters/vrbo_formatter.py` (`format_property` and `format_error`).
 * Field names, ordering, and null-vs-absent semantics mirror the Python output
 * exactly so a downstream parity test can diff against the Python actor.
 */
import type { Platform } from './url-parser.js';

/** An image entry produced by `extract_images`. */
export interface PropertyImage {
    url: string;
    /** description may be null (image.description / img_info.description fallback). */
    description: string | null;
}

/**
 * A per-unit image produced by `_build_unit_image_map` /
 * `extract_units_from_gallery`. Carries an extra aspectRatio field.
 */
export interface UnitImage {
    url: string;
    description: string | null;
    aspectRatio: string | null;
}

/** A highlighted amenity from `extract_amenities_summary`. */
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
    items: Array<string | PolicySubSection>;
}

/** Structured house rules from `extract_house_rules`. */
export interface HouseRules {
    checkInTime: string | null;
    checkOutTime: string | null;
    smokingAllowed: boolean | null;
    petsAllowed: boolean | null;
    eventsAllowed: boolean | null;
}

/** A property/unit feature ({iconId, text}) from `extract_features`. */
export interface Feature {
    iconId: string | null;
    text: string;
}

/** A structured bed type from `extract_bed_types`. */
export interface BedType {
    type: string;
    count: number;
}

/**
 * A unit entry. Units are built from three code paths with slightly different
 * key sets, so several fields are optional/absent:
 *
 * - from offers (`extract_units_from_offers`): has `bedTypes`.
 * - from gallery (`extract_units_from_gallery`): NO `bedTypes` key.
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

/** The Terminal success row returned by `format_property`. */
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

/** The Terminal error row returned by `format_error`. */
export interface ErrorRow {
    platform: Platform | null;
    url: string;
    id: string;
    error: string;
    scrapedAt: string;
}
