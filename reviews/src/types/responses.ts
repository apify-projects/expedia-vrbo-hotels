// GraphQL always returns every selected key, so only the fields below typed `| null`
// are ever actually missing a value.

type ResponseTheme = {
    label: string;
};

type ResponsePhoto = {
    url: string;
};

type ResponseManagementResponse = {
    header: { text: string };
    response: string;
};

type ResponseFooterMessage = {
    seoStructuredData: { content: string } | null;
    text: { text: string };
};

type ResponseInteractionSection = {
    primaryDisplayString: string | null;
    reviewInteractionType: string;
};

export type ResponseReview = {
    id: string;
    title: string;
    text: string;
    superlative: string;
    locale: string;
    reviewScoreWithDescription: { value: string };
    submissionTime: { longDateFormat: string };
    reviewFooter: { messages: ResponseFooterMessage[] };
    reviewInteractionSections: ResponseInteractionSection[];
    photos: ResponsePhoto[];
    managementResponses: ResponseManagementResponse[];
    // Expedia sends the author and themes, Hotels.com sends the region instead.
    reviewAuthorAttribution: { text: string } | null;
    reviewRegion: { id: string } | null;
    themes: ResponseTheme[] | null;
    translationInfo: object | null;
};

/** The API answers a batched operation, hence the array. */
export type ResponseReviewsPage = {
    data?: {
        propertyReviewSummaries?: { totalCount?: { raw?: number } }[];
        propertyInfo?: {
            reviewInfo?: { reviews?: ResponseReview[] };
        };
    };
    errors?: { message?: string }[];
}[];
