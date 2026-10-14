export type ManagementResponse = {
    authorName: string | null;
    publishedDate: string | null;
    text: string;
};

export type Review = {
    reviewId: string;
    hotelId: string;
    propertyUrl: string;
    reviewPosition: number;
    publishedDate: string | null;
    rating: number | null;
    ratingText: string;
    title: string | null;
    text: string | null;
    locale: string;
    isTranslated: boolean;
    authorName: string | null;
    authorCountryCode: string | null;
    nightsStayed: number | null;
    stayedMonth: string | null;
    helpfulVoteCount: number | null;
    likedThemes: string[];
    dislikedThemes: string[];
    photoUrls: string[];
    managementResponses: ManagementResponse[];
    customData: Record<string, unknown>;
};
