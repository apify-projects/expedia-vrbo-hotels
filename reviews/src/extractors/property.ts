import type { CheerioAPI } from '@crawlee/cheerio';

// Hotels.com nests JSON inside JSON, which lands the quotes three backslashes deep.
const PROPERTY_ID_PATTERN = /\\*"propertyId\\*"\s*:\s*\\*"(\d+)\\*"/;

/** Hotels.com embeds the id in a script blob, Vrbo exposes it as a meta tag. */
export const extractPropertyId = ($: CheerioAPI): string | undefined => {
    for (const script of $('script').toArray()) {
        const propertyId = $(script).text().match(PROPERTY_ID_PATTERN)?.[1];

        if (propertyId) return propertyId;
    }

    return $('meta[itemprop="identifier"]').attr('content') || undefined;
};
