import type { CheerioCrawlingContext } from '@crawlee/cheerio';

import { PAGE_SIZE, PPE_EVENTS } from '../consts.js';
import { extractReview, extractReviewsPage } from '../extractors/review.js';
import { buildReviewsRequest } from '../request-builders.js';
import type { CrawlerState } from '../types/common.js';
import type { ResponseReviewsPage } from '../types/responses.js';
import type { ReviewsUserData } from '../types/user-data.js';
import { getMaxPaidDatasetItems, pushDataAndCharge } from '../utils/charging.js';
import { parseReviewDate } from '../utils/dates.js';
import { buildRemainingStartIndexes } from '../utils/urls.js';

const sumReviewCounts = (counts: Record<string, number>): number =>
    Object.values(counts).reduce((total, count) => total + count, 0);

export const reviewsRoute = async (context: CheerioCrawlingContext<ReviewsUserData, ResponseReviewsPage>) => {
    const { json, request, addRequests, crawler, log, useState } = context;
    const { propertyUrl, propertyId, startIndex, maxReviewsPerHotel, minDate } = request.userData;

    const page = extractReviewsPage(json);
    if (!page) {
        throw new Error(`Expected a reviews array for property ${propertyId} at index ${startIndex}`);
    }

    const state = await useState<CrawlerState>();
    const maxPaidDatasetItems = getMaxPaidDatasetItems();

    // Counted from this page's own offset, so parallel pages truncate the same way whatever order they land in.
    const remainingForHotel = maxReviewsPerHotel ? maxReviewsPerHotel - startIndex : Infinity;
    const remainingPaid = maxPaidDatasetItems - sumReviewCounts(state.reviewCounts);
    const remaining = Math.min(remainingForHotel, remainingPaid);

    if (remaining <= 0) return;

    const cutoff = minDate ? parseReviewDate(minDate) : undefined;
    let hasOlderThanMinDate = false;

    const reviewsToPush = page.reviews
        .filter((review) => {
            if (!cutoff) return true;

            const date = parseReviewDate(review.submissionTime?.longDateFormat);
            if (!date) return true;

            if (date < cutoff) hasOlderThanMinDate = true;
            return date >= cutoff;
        })
        .slice(0, remaining)
        .map((review, index) =>
            extractReview(review, {
                hotelId: propertyId,
                propertyUrl,
                reviewPosition: startIndex + index + 1,
                customData: request.userData.customData,
            }),
        );

    const pageNumber = startIndex / PAGE_SIZE + 1;

    if (page.reviews.length === 0) {
        log.info(`No reviews returned for property ${propertyId}`, { propertyUrl, page: pageNumber });
    } else if (reviewsToPush.length === 0) {
        // Only the date cutoff can empty a non-empty page - the limits returned above.
        log.info(`No reviews newer than ${minDate} for property ${propertyId}`, { propertyUrl, page: pageNumber });
    } else {
        await pushDataAndCharge(reviewsToPush, PPE_EVENTS.RESULT, crawler);
        state.reviewCounts[propertyId] = (state.reviewCounts[propertyId] ?? 0) + reviewsToPush.length;

        log.info(`Scraped ${reviewsToPush.length} reviews for property ${propertyId}`, {
            propertyUrl,
            page: pageNumber,
            reviewCount: page.totalCount,
        });
    }

    if (sumReviewCounts(state.reviewCounts) >= maxPaidDatasetItems) {
        log.warningOnce('Reached the maximum number of paid results, stopping the actor.');
        await crawler.autoscaledPool?.abort();
        return;
    }

    // A cutoff only exists under Most recent sorting, which is strictly newest-first,
    // so once a page crosses it no later page can qualify.
    if (cutoff) {
        if (hasOlderThanMinDate || page.reviews.length < PAGE_SIZE) return;

        const nextStartIndex = startIndex + PAGE_SIZE;
        if (maxReviewsPerHotel && nextStartIndex >= maxReviewsPerHotel) return;

        await addRequests([buildReviewsRequest({ ...request.userData, startIndex: nextStartIndex })]);
        return;
    }

    // The first page reports the property total, so the rest are queued at once.
    if (startIndex > 0 || page.totalCount === undefined) return;

    const pageLimit = Math.min(maxReviewsPerHotel ?? Infinity, maxPaidDatasetItems);
    const startIndexes = buildRemainingStartIndexes(page.totalCount, pageLimit);
    if (startIndexes.length === 0) return;

    await addRequests(
        startIndexes.map((nextStartIndex) => buildReviewsRequest({ ...request.userData, startIndex: nextStartIndex })),
    );

    log.info(`Enqueued ${startIndexes.length} more review pages for property ${propertyId}`, { propertyUrl });
};
