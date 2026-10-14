import type { ManagementResponse, Review } from '../types/output.js';
import type { ResponseReview, ResponseReviewsPage } from '../types/responses.js';
import { parseReviewDate } from '../utils/dates.js';

type ReviewsPage = {
    reviews: ResponseReview[];
    totalCount?: number;
};

export const extractReviewsPage = (response: ResponseReviewsPage): ReviewsPage | undefined => {
    const page = response?.[0];
    const reviews = page?.data?.propertyInfo?.reviewInfo?.reviews;

    if (!Array.isArray(reviews)) return undefined;

    return { reviews, totalCount: page?.data?.propertyReviewSummaries?.[0]?.totalCount?.raw };
};

const RATING_PATTERN = /^(\d+(?:\.\d+)?)\//;
const NIGHTS_PATTERN = /(\d+)[- ]night/;
const STAY_MONTH_PATTERN = /\bin ([A-Z][a-z]{2} \d{4})\b/;
const RESPONSE_HEADER_PATTERN = /^Response from (.+?) on (.+)$/;

const parseIsoDate = (value?: string | null): string | null =>
    parseReviewDate(value)?.toISOString().slice(0, 10) ?? null;

// Expedia capitalises only the first label after the colon, so they are evened out here.
const extractThemes = (themes: ResponseReview['themes'], sentiment: string): string[] =>
    (themes ?? [])
        .filter((theme) => theme.label.toLowerCase().startsWith(sentiment))
        .flatMap((theme) =>
            (theme.label.split(':')[1] ?? '')
                .split(',')
                .map((label) => label.trim())
                .filter(Boolean)
                .map((label) => label[0]!.toUpperCase() + label.slice(1)),
        );

const extractManagementResponses = (review: ResponseReview): ManagementResponse[] =>
    review.managementResponses.map(({ header, response }) => {
        const [, authorName, respondedOn] = header.text.match(RESPONSE_HEADER_PATTERN) ?? [];

        return {
            authorName: authorName ?? null,
            publishedDate: parseIsoDate(respondedOn),
            text: response,
        };
    });

type ReviewContext = {
    hotelId: string;
    propertyUrl: string;
    reviewPosition: number;
    customData: Record<string, unknown>;
};

export const extractReview = (review: ResponseReview, context: ReviewContext): Review => {
    const [footerMessage] = review.reviewFooter.messages;
    const stayDetail = footerMessage?.text.text ?? '';
    const helpfulVotes =
        review.reviewInteractionSections.find((section) => section.reviewInteractionType === 'HELPFUL_REVIEW')
            ?.primaryDisplayString ?? null;
    const rating = Number(review.reviewScoreWithDescription.value.match(RATING_PATTERN)?.[1]);
    const nightsStayed = Number(stayDetail.match(NIGHTS_PATTERN)?.[1]);

    return {
        reviewId: review.id,
        hotelId: context.hotelId,
        propertyUrl: context.propertyUrl,
        reviewPosition: context.reviewPosition,
        publishedDate: parseIsoDate(review.submissionTime.longDateFormat),
        rating: Number.isNaN(rating) ? null : rating,
        ratingText: review.superlative,
        title: review.title || null,
        text: review.text || null,
        locale: review.locale,
        isTranslated: review.translationInfo !== null,
        authorName: review.reviewAuthorAttribution?.text ?? footerMessage?.seoStructuredData?.content ?? null,
        authorCountryCode: review.reviewRegion?.id.toUpperCase() ?? null,
        nightsStayed: Number.isNaN(nightsStayed) ? null : nightsStayed,
        stayedMonth: parseIsoDate(stayDetail.match(STAY_MONTH_PATTERN)?.[1])?.slice(0, 7) ?? null,
        helpfulVoteCount: helpfulVotes === null ? null : Number(helpfulVotes),
        likedThemes: extractThemes(review.themes, 'liked'),
        dislikedThemes: extractThemes(review.themes, 'disliked'),
        photoUrls: review.photos.map((photo) => photo.url),
        managementResponses: extractManagementResponses(review),
        customData: context.customData,
    };
};
