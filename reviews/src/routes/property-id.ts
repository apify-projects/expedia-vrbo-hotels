import type { CheerioCrawlingContext } from '@crawlee/cheerio';

import { extractPropertyId } from '../extractors/property.js';
import { buildReviewsRequest } from '../request-builders.js';
import type { PropertyIdUserData } from '../types/user-data.js';

export const propertyIdRoute = async (context: CheerioCrawlingContext<PropertyIdUserData>) => {
    const { $, request, addRequests, log } = context;
    const { userData } = request;

    const propertyId = extractPropertyId($);
    if (!propertyId) {
        throw new Error('Could not find a property id');
    }

    log.info(`Resolved property id: ${propertyId}`, { propertyUrl: userData.propertyUrl });

    await addRequests([buildReviewsRequest({ ...userData, propertyId, startIndex: 0 })]);
};
