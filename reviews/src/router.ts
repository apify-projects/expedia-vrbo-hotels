import { createCheerioRouter } from '@crawlee/cheerio';

import { LABELS } from './consts.js';
import { propertyIdRoute } from './routes/property-id.js';
import { reviewsRoute } from './routes/reviews.js';

export const router = createCheerioRouter();

router.use(async (context) => {
    context.log = context.log.child({ prefix: `[${context.request.label}]` });
});

router.addHandler(LABELS.PROPERTY_ID, propertyIdRoute);
router.addHandler(LABELS.REVIEWS, reviewsRoute);
